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

const archivedNow = async (store: ReturnType<typeof memoryStore>) => (await run(store, "list_files", {})).filter((f) => f.archived).map((f) => f.path);
const archiveFile = (store: ReturnType<typeof memoryStore>) => store.files.read(".common-ink/archive.json" as FilePath)?.text;

test("undoing one archive never clashes with another note's archive or unarchive", async () => {
  const store = workspace();
  const first = await run(store, "archive", { paths: ["Launch plan.md"] });
  await run(store, "archive", { paths: ["Old launch.md"] }, claude);
  const [undone] = (await run(store, "undo", { revisions: [first.revision] })) as unknown as Array<{ status: string }>;
  assert.equal(undone.status, "undone");
  assert.deepEqual(await archivedNow(store), ["Old launch.md"]);
  const second = await run(store, "archive", { paths: ["Groceries.md"] });
  await run(store, "unarchive", { paths: ["Old launch.md"] });
  const [again] = (await run(store, "undo", { revisions: [second.revision] })) as unknown as Array<{ status: string }>;
  assert.equal(again.status, "undone");
  assert.deepEqual(await archivedNow(store), []);
});

test("two tabs writing the archive from the same version both count", () => {
  const store = workspace();
  const path = ".common-ink/archive.json" as FilePath;
  const start = store.files.write({ path, text: '{\n  "archived": [\n    "Groceries.md"\n  ]\n}\n', base: 0, author: ada });
  store.files.write({ path, text: '{\n  "archived": [\n    "Groceries.md",\n    "Launch plan.md"\n  ]\n}\n', base: start.file!.revision, author: ada });
  const stale = store.files.write({ path, text: '{\n  "archived": []\n}\n', base: start.file!.revision, author: claude });
  assert.equal(stale.status, "merged");
  assert.equal(archiveFile(store), '{\n  "archived": [\n    "Launch plan.md"\n  ]\n}\n');
});

test("deleting a note takes it out of the archive, so a new note at its path isn't archived", async () => {
  const store = workspace();
  await run(store, "archive", { paths: ["Groceries.md", "Old launch.md"] });
  const note = store.files.read("Groceries.md" as FilePath)!;
  await run(store, "delete_file", { path: "Groceries.md", base: note.revision });
  assert.deepEqual(await archivedNow(store), ["Old launch.md"]);
  store.files.write({ path: "Groceries.md" as FilePath, text: "# Groceries\nnew list", base: 0, author: ada });
  assert.deepEqual(await archivedNow(store), ["Old launch.md"]);
});

test("a hand-edited archive keeps its other keys, and one that isn't valid JSON is never written over", async () => {
  const store = workspace();
  const path = ".common-ink/archive.json" as FilePath;
  store.files.write({ path, text: '{"why": "my notes", "archived": ["Groceries.md", "Folder/"]}\n', base: 0, author: ada });
  await run(store, "archive", { paths: ["Old launch.md"] });
  assert.equal(archiveFile(store), '{\n  "why": "my notes",\n  "archived": [\n    "Groceries.md",\n    "Old launch.md",\n    "Folder/"\n  ]\n}\n');
  const broken = '{ broken, "Groceries.md"\n';
  store.files.write({ path, text: broken, base: store.files.read(path)!.revision, author: ada });
  assert.deepEqual(await run(store, "archive", { paths: ["Launch plan.md"] }), { error: ".common-ink/archive.json isn't valid JSON with an \"archived\" list, so it wasn't changed. Fix it, or put back an earlier version from History." });
  assert.equal(archiveFile(store), broken);
});

test("history undoes a hand edit that broke the archive, and the one that fixed it, line by line", async () => {
  const store = workspace();
  await run(store, "archive", { paths: ["Groceries.md"] });
  const path = ".common-ink/archive.json" as FilePath;
  const good = archiveFile(store);
  const broke = store.files.write({ path, text: '{ "archived": ["Groceries.md", }\n', base: store.files.read(path)!.revision, author: ada }).file!.revision;
  assert.deepEqual((await run(store, "undo", { revisions: [broke] })).map((u) => u.status), ["undone"]);
  assert.equal(archiveFile(store), good);
  const broken = store.files.write({ path, text: '{ "archived": [ }\n', base: store.files.read(path)!.revision, author: ada }).file!.revision;
  const fixed = store.files.write({ path, text: good!, base: broken, author: ada }).file!.revision;
  assert.deepEqual((await run(store, "undo", { revisions: [fixed] })).map((u) => u.status), ["undone"]);
  assert.equal(archiveFile(store), '{ "archived": [ }\n');
});

test("undoing a note's delete in History brings it back archived, as it was", async () => {
  const store = workspace();
  await run(store, "archive", { paths: ["Groceries.md"] });
  const d = ((await run(store, "delete_file", { path: "Groceries.md", base: store.files.read("Groceries.md" as FilePath)!.revision })).file as { revision: number }).revision;
  assert.deepEqual(await archivedNow(store), []);
  await run(store, "undo", { revisions: [d] });
  assert.deepEqual(await archivedNow(store), ["Groceries.md"]);
});
