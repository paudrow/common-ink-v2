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
  assert.deepEqual(await run(store, "restore", { path: "Plan.md" }), { error: "Plan.md isn't in Trash" });
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

test("a deleted note stays in Trash when a new note takes its path, and restores beside it", async () => {
  const { store, write, remove } = workspace();
  write("Journal/2026-10-06.md", "# 2026-10-06\nimportant thoughts");
  remove("Journal/2026-10-06.md");
  write("Journal/2026-10-06.md", "# 2026-10-06\n");
  const trash = await run(store, "trash");
  assert.deepEqual(trash.map((t) => [t.path, t.title]), [["Journal/2026-10-06.md", "2026-10-06"]]);
  assert.deepEqual(((await run(store, "search", { query: "important is:trashed" })).results as Array<{ path: string }>).map((r) => r.path), ["Journal/2026-10-06.md"]);
  const restored = await run(store, "restore", { path: "Journal/2026-10-06.md", deleted: trash[0].revision });
  assert.equal(restored.path, "Journal/2026-10-06 (restored).md");
  assert.equal(store.files.read("Journal/2026-10-06 (restored).md" as FilePath)?.text, "# 2026-10-06\nimportant thoughts");
  assert.equal(store.files.read("Journal/2026-10-06.md" as FilePath)?.text, "# 2026-10-06\n", "the new note is left as it is");
  assert.deepEqual(await run(store, "trash"), []);
});

test("each delete of a path is its own note in Trash, and restores the one asked for", async () => {
  const { store, write, remove } = workspace();
  write("Untitled 1.md", "# Untitled 1\nfirst");
  remove("Untitled 1.md");
  write("Untitled 1.md", "# Untitled 1\nsecond");
  remove("Untitled 1.md");
  const trash = await run(store, "trash");
  assert.equal(trash.length, 2);
  const older = trash[1];
  const done = await run(store, "restore", { path: "Untitled 1.md", deleted: older.revision });
  assert.equal(done.path, "Untitled 1.md");
  assert.equal(store.files.read("Untitled 1.md" as FilePath)?.text, "# Untitled 1\nfirst");
  assert.deepEqual((await run(store, "trash")).map((t) => t.revision), [trash[0].revision]);
});

test("restore keeps to Trash's retention, as its list does", async () => {
  const { store, age, write, remove } = workspace();
  write("Old.md", "# Old");
  remove("Old.md");
  age("Old.md", 31);
  assert.deepEqual(await run(store, "restore", { path: "Old.md" }), { error: "Old.md isn't in Trash" });
});

test("a note archived when it was deleted comes back archived", async () => {
  const { store, write } = workspace();
  write("Kept.md", "# Kept");
  await run(store, "archive", { paths: ["Kept.md"] });
  await run(store, "delete_file", { path: "Kept.md", base: store.files.read("Kept.md" as FilePath)!.revision });
  await run(store, "restore", { path: "Kept.md" });
  assert.deepEqual((await run(store, "list_files")).filter((f) => f.archived).map((f) => f.path), ["Kept.md"]);
});

test("a search within some paths finds only the notes in Trash there", async () => {
  const { store, write, remove } = workspace();
  write("Public/Gone.md", "# Gone\nzebra");
  write("Secret/Plan.md", "# Plan\nzebra");
  remove("Public/Gone.md");
  remove("Secret/Plan.md");
  const found = await run(store, "search", { query: "zebra is:trashed", within: ["Public/**"] });
  assert.deepEqual([(found.results as Array<{ path: string }>).map((r) => r.path), found.total], [["Public/Gone.md"], 1]);
});

test("restoring beside a taken path that's near the length limit shortens the name, and says so when no name is free", { timeout: 5000 }, async () => {
  const { store, write, remove } = workspace();
  const long = `Projects/${"x".repeat(283)}.md`;
  write(long, "# v1");
  const d = remove(long).file!.revision;
  write(long, "# v2");
  const restored = await run(store, "restore", { path: long, deleted: d });
  assert.equal(restored.status, "restored");
  const path = restored.path as string;
  assert.ok(path.length <= 300 && path.startsWith("Projects/xxx") && path.endsWith(" (restored).md"), path);
  assert.equal(store.files.read(path as FilePath)?.text, "# v1");
  // A folder so long that no name with "(restored)" fits under it.
  const deep = `${"f".repeat(288)}/a.md`;
  write(deep, "# a1");
  const d2 = remove(deep).file!.revision;
  write(deep, "# a2");
  assert.match(String((await run(store, "restore", { path: deep, deleted: d2 })).error), /no free name/);
});

test("undoing a restore puts the note back in Trash, rather than leaving an empty copy", async () => {
  const { store, write, remove } = workspace();
  write("Plan.md", "# Plan\nold");
  const d = remove("Plan.md").file!.revision;
  write("Plan.md", "# Plan\nnew");
  const beside = await run(store, "restore", { path: "Plan.md", deleted: d });
  await run(store, "undo", { revisions: [beside.revision as number] });
  assert.equal(store.files.read("Plan (restored).md" as FilePath), null);
  assert.ok((await run(store, "trash")).some((t) => t.path === "Plan (restored).md" || t.path === "Plan.md"));
  write("Other.md", "# Other\nhere");
  const d2 = remove("Other.md").file!.revision;
  const inPlace = await run(store, "restore", { path: "Other.md", deleted: d2 });
  await run(store, "undo", { revisions: [inPlace.revision as number] });
  assert.equal(store.files.read("Other.md" as FilePath), null);
  assert.ok((await run(store, "trash")).some((t) => t.path === "Other.md"));
});
