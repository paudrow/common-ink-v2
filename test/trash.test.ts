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

test("only a person can delete a note forever: its text leaves history, and one change says who and when", async () => {
  const { store, write, remove } = workspace();
  write("Secret.md", "# Secret\nthe code is 1234");
  remove("Secret.md");
  assert.deepEqual(await run(store, "purge", { paths: ["Secret.md"] }, claude), { error: "Only a person can delete notes forever, in the app. Agents and extensions can restore them instead." });
  assert.deepEqual(await run(store, "purge", { paths: ["Secret.md"] }, { kind: "extension", id: "tasks", by: "ada@example.com" }), { error: "Only a person can delete notes forever, in the app. Agents and extensions can restore them instead." });
  const done = await run(store, "purge", { paths: ["Secret.md"] });
  assert.deepEqual((done.purged as Array<{ path: string }>).map((p) => p.path), ["Secret.md"]);
  assert.deepEqual(store.files.history("Secret.md" as FilePath).map((c) => ({ author: c.author, purged: c.purged, diff: c.diff })), [{ author: ada, purged: true, diff: [] }]);
  assert.deepEqual(await run(store, "trash"), []);
  assert.deepEqual(await run(store, "restore", { path: "Secret.md" }), { error: "Secret.md isn't in Trash" });
  assert.deepEqual(await run(store, "purge", { paths: ["Secret.md"] }), { error: "Nothing to delete forever: Secret.md isn't in Trash" });
});

test("agents aren't offered purge over MCP", async () => {
  const { mcp } = await import("../worker/src/mcp.ts");
  const { store, write, remove } = workspace();
  write("Gone.md", "# Gone");
  remove("Gone.md");
  const call = async (method: string, params: unknown) => (await (await mcp(new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), store, claude)).json()) as { result?: { tools: Array<{ name: string }> }; error?: { message: string } };
  assert.equal((await call("tools/list", {})).result!.tools.some((t) => t.name === "purge"), false);
  assert.deepEqual((await call("tools/call", { name: "purge", arguments: { paths: ["Gone.md"] } })).error, { code: -32602, message: "No tool named purge" });
  assert.equal(store.files.read("Gone.md" as FilePath), null);
  assert.equal(store.files.history("Gone.md" as FilePath).length, 2, "nothing purged");
});

test("each day, notes in Trash longer than trash.retentionDays are purged by Trash retention", async () => {
  const { purgeExpired } = await import("../worker/src/trash.ts");
  const { store, age, write, remove } = workspace();
  for (const p of ["Old.md", "Recent.md", "Projects/Older.md"]) write(p, `# ${p}`);
  write(".common-ink/old.json", "{}");
  for (const p of ["Old.md", "Recent.md", "Projects/Older.md", ".common-ink/old.json"]) remove(p);
  age("Old.md", 31);
  age("Projects/Older.md", 45);
  age(".common-ink/old.json", 90);
  age("Recent.md", 29);
  assert.deepEqual(purgeExpired(store.files, Date.now()).map((p) => p.path).sort(), ["Old.md", "Projects/Older.md"]);
  assert.deepEqual(store.files.history("Old.md" as FilePath).map((c) => [c.author, c.purged]), [[{ kind: "retention" }, true]]);
  assert.deepEqual((await run(store, "trash")).map((t) => t.path), ["Recent.md"]);
  assert.deepEqual(purgeExpired(store.files, Date.now()), [], "a second run that day has nothing to do");
});
