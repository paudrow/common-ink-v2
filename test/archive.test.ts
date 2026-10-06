import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { runOperation, type OperationName } from "../worker/src/operations.ts";
import { memoryStore } from "./store.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const claude: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };

type Answer = Record<string, unknown> & Array<Record<string, unknown>>;

async function run(store: ReturnType<typeof memoryStore>, name: OperationName, args: Record<string, unknown>, author: Author = ada): Promise<Answer> {
  const out = await runOperation(name, args, store, author);
  return (out.ok ? out.value : { error: out.error }) as Answer;
}

function workspace() {
  const store = memoryStore();
  for (const [path, text] of [["Launch plan.md", "# Launch plan\nShip the launch."], ["Old launch.md", "# Old launch\nThe launch we did."], ["Groceries.md", "# Groceries"]]) store.files.write({ path: path as FilePath, text, base: 0, author: ada });
  return store;
}

test("archiving writes the archive file as one change, and list_files marks the note", async () => {
  const store = workspace();
  const done = await run(store, "archive", { paths: ["Old launch.md", "Groceries.md"] }, claude);
  assert.deepEqual(done.archived, ["Groceries.md", "Old launch.md"]);
  assert.equal(store.files.read(".common-ink/archive.json" as FilePath)?.text, '{\n  "archived": [\n    "Groceries.md",\n    "Old launch.md"\n  ]\n}\n');
  assert.deepEqual(store.files.recent({ limit: 1 }).map((c) => [c.path, c.author]), [[".common-ink/archive.json", claude]]);
  const listed = await run(store, "list_files", {});
  assert.deepEqual(listed.filter((f) => f.archived).map((f) => f.path), ["Groceries.md", "Old launch.md"]);
  assert.deepEqual(await run(store, "archive", { paths: ["Groceries.md"] }), { revision: null, archived: ["Groceries.md", "Old launch.md"] }, "archived already: nothing to change");
});

test("archived notes come last in search, marked", async () => {
  const store = workspace();
  await run(store, "archive", { paths: ["Launch plan.md"] });
  const found = await run(store, "search", { query: "launch" });
  assert.deepEqual((found.results as Array<{ path: string; archived?: true }>).map((r) => [r.path, r.archived ?? false]), [["Old launch.md", false], ["Launch plan.md", true]]);
  const only = await run(store, "search", { query: "is:archived" });
  assert.deepEqual((only.results as Array<{ path: string }>).map((r) => r.path), ["Launch plan.md"]);
});

test("undoing the archive's change unarchives, and unarchive takes notes out", async () => {
  const store = workspace();
  const done = await run(store, "archive", { paths: ["Groceries.md", "Launch plan.md"] });
  await run(store, "undo", { revisions: [done.revision] });
  assert.deepEqual((await run(store, "list_files", {})).filter((f) => f.archived), []);
  await run(store, "archive", { paths: ["Groceries.md", "Launch plan.md"] });
  assert.deepEqual((await run(store, "unarchive", { paths: ["Groceries.md", "Nowhere.md"] })).archived, ["Launch plan.md"]);
});

test("only notes that are there can be archived", async () => {
  const store = workspace();
  assert.deepEqual(await run(store, "archive", { paths: ["Nowhere.md"] }), { error: "There's no note at Nowhere.md" });
  assert.deepEqual(await run(store, "archive", { paths: [".common-ink/layout.json"] }), { error: '"paths" must be a list of notes\' paths, ending in .md' });
});
