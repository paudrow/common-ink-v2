import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { runOperation, type OperationName } from "../worker/src/operations.ts";
import { memoryStore } from "./store.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const claude: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };
const DAY = 86_400_000;

type Answer = Record<string, unknown> & Array<Record<string, unknown>>;
async function run(store: ReturnType<typeof memoryStore>, name: OperationName, args: Record<string, unknown> = {}, author: Author = ada): Promise<Answer> {
  const out = await runOperation(name, args, store, author);
  return (out.ok ? out.value : { error: out.error }) as Answer;
}

/** A workspace, with a way to make a delete days old. */
function workspace() {
  const store = memoryStore();
  const age = (path: string, days: number) => store.db.run("UPDATE changes SET time = ? WHERE path = ? AND deletes = 1", Date.now() - days * DAY, path);
  const write = (path: string, text: string, author = ada) => store.files.write({ path: path as FilePath, text, base: store.files.read(path as FilePath)?.revision ?? 0, author });
  const remove = (path: string, author = ada) => store.files.write({ path: path as FilePath, text: "", base: store.files.read(path as FilePath)!.revision, author, delete: true });
  return { store, age, write, remove };
}

test("Trash lists deleted notes, newest first, with who deleted them and the days they have left", async () => {
  const { store, age, write, remove } = workspace();
  write("Untitled 3.md", "# Untitled 3\nscratch");
  write("Reading list.md", "# Reading list");
  write("Old.md", "# Old");
  write(".common-ink/layout.json", "{}");
  remove("Untitled 3.md", claude);
  remove("Reading list.md");
  remove("Old.md");
  remove(".common-ink/layout.json");
  age("Untitled 3.md", 27.5);
  age("Old.md", 31);
  const trash = await run(store, "trash");
  assert.deepEqual(
    trash.map((t) => [t.path, t.title, (t.author as Author).kind, t.daysLeft]),
    [
      ["Reading list.md", "Reading list", "user", 30],
      ["Untitled 3.md", "Untitled 3", "agent", 3],
    ],
  );
});

test("restoring undoes the delete: the note comes back with its whole history, and leaves Trash", async () => {
  const { store, write, remove } = workspace();
  write("Plan.md", "# Plan\none");
  write("Plan.md", "# Plan\none\ntwo");
  remove("Plan.md");
  const restored = await run(store, "restore", { path: "Plan.md" });
  assert.equal(restored.status, "restored");
  assert.equal(store.files.read("Plan.md" as FilePath)?.text, "# Plan\none\ntwo");
  assert.deepEqual(store.files.history("Plan.md" as FilePath).map((c) => [c.deleted ?? false, c.undoes !== null]), [[false, false], [false, false], [true, false], [false, true]]);
  assert.deepEqual(await run(store, "trash"), []);
  assert.deepEqual(await run(store, "restore", { path: "Plan.md" }), { error: "Plan.md isn't deleted" });
  assert.deepEqual(await run(store, "restore", { path: "Never.md" }), { error: "Never.md isn't in Trash" });
});

test("a note deleted, restored and deleted again is in Trash once, as of its last delete", async () => {
  const { store, write, remove } = workspace();
  write("Twice.md", "# Twice");
  remove("Twice.md");
  await run(store, "restore", { path: "Twice.md" });
  remove("Twice.md", claude);
  const trash = await run(store, "trash");
  assert.deepEqual(trash.map((t) => [t.path, (t.author as Author).kind]), [["Twice.md", "agent"]]);
});

test("search finds notes in Trash only with is:trashed", async () => {
  const { store, write, remove } = workspace();
  write("Gone.md", "# Gone\nzebra stripes");
  write("Here.md", "# Here\nzebra too");
  remove("Gone.md");
  const paths = async (query: string) => ((await run(store, "search", { query })).results as Array<{ path: string; trashed?: true }>).map((r) => `${r.path}${r.trashed ? " (trashed)" : ""}`);
  assert.deepEqual(await paths("zebra"), ["Here.md"]);
  assert.deepEqual(await paths("zebra is:trashed"), ["Gone.md (trashed)"]);
});

test("the retention period is the workspace's trash.retentionDays", async () => {
  const { store, age, write, remove } = workspace();
  write("Week old.md", "# Week old");
  remove("Week old.md");
  age("Week old.md", 7);
  write(".common-ink/settings.json", '{ "trash.retentionDays": 10 }');
  assert.deepEqual((await run(store, "trash")).map((t) => t.daysLeft), [3]);
  write(".common-ink/settings.json", '{ "trash.retentionDays": 5 }');
  assert.deepEqual(await run(store, "trash"), []);
});

test("a Preview's seed can delete a note it adds, so Trash has something to show", async () => {
  const { store } = workspace();
  store.files.seed({ id: "t", notes: [{ path: "Untitled 3.md", text: "# Untitled 3\nscratch", replace: false }], edits: [{ path: "Untitled 3.md", text: "", agent: "Claude", delete: true }] });
  assert.deepEqual((await run(store, "trash")).map((t) => [t.path, t.title, (t.author as { name: string }).name]), [["Untitled 3.md", "Untitled 3", "Claude"]]);
});
