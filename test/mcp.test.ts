import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author } from "../worker/src/files.ts";
import { mcp } from "../worker/src/mcp.ts";
import { runOperation, type Store } from "../worker/src/operations.ts";
import { memoryStore } from "./store.ts";

const agent: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };

/** A JSON-RPC request, or a notification when `id` is null. */
async function call(files: Store, method: string, params?: Record<string, unknown>, id: number | null = 1) {
  const msg = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  const res = await mcp(new Request("https://x/mcp", { method: "POST", body: JSON.stringify(msg) }), files, agent);
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

test("MCP lists the workspace operations as tools", async () => {
  const files = memoryStore();
  const init = await call(files, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal((await call(files, "notifications/initialized", undefined, null)).status, 202);
  const tools = (await call(files, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(tools, ["list_files", "read_file", "write_file", "delete_file", "history", "undo", "data_sources", "sync_calendar", "list_calendars", "list_events", "read_event", "create_event", "update_event", "delete_event", "link_event", "list_contacts", "diff", "read_version", "edit_applied", "restore", "labels", "add_label", "search", "trash", "archive", "unarchive", "list_embeds", "complete_task", "list_uploads", "upload_file"]);
});

test("an agent's writes through MCP are its changes, and can be undone", async () => {
  const files = memoryStore();
  const wrote = await call(files, "tools/call", { name: "write_file", arguments: { path: "Plan.md", text: "# Plan\n", base: 0 } });
  assert.equal(wrote.body.result.isError, false);
  const history = JSON.parse((await call(files, "tools/call", { name: "history", arguments: {} })).body.result.content[0].text);
  assert.deepEqual(history[0].author, agent);
  await call(files, "tools/call", { name: "undo", arguments: { revisions: [1] } });
  assert.equal(files.files.read("Plan.md" as never)?.text, "");
});

test("bad arguments and conflicts come back as tool errors", async () => {
  const files = memoryStore();
  const bad = await call(files, "tools/call", { name: "write_file", arguments: { path: "../x.md", text: "", base: 0 } });
  assert.equal(bad.body.result.isError, true);
  await call(files, "tools/call", { name: "write_file", arguments: { path: "Plan.md", text: "a\n", base: 0 } });
  const clash = await call(files, "tools/call", { name: "write_file", arguments: { path: "Plan.md", text: "b\n", base: 0 } });
  assert.equal(clash.body.result.isError, true);
  assert.equal((await call(files, "tools/call", { name: "nope" })).body.error.code, -32602);
});

test("operations take numbers from query strings", async () => {
  const files = memoryStore();
  files.files.write({ path: "A.md" as never, text: "1", base: 0, author: agent });
  files.files.write({ path: "A.md" as never, text: "2", base: 1, author: agent });
  const result = await runOperation("history", { limit: "1", path: "A.md" }, files, agent);
  assert.ok(result.ok);
  assert.deepEqual(
    (result.value as Array<{ revision: number }>).map((c) => c.revision),
    [2],
  );
});

test("an agent ticks a repeating task the way the app does: it moves on, and its completion is logged in today's daily note", async () => {
  const files = memoryStore();
  const run = (name: string, args: Record<string, unknown>) => runOperation(name as never, args, files, agent);
  await run("write_file", { path: "Chores.md", text: "# Chores\n\n- [ ] Water the plants due:2026-10-05 rec:3d #home\n- [ ] Call mum\n", base: 0 });
  const ticked = await run("complete_task", { path: "Chores.md", line: 3, text: "- [ ] Water the plants due:2026-10-05 rec:3d #home", today: "2026-10-05" });
  assert.equal(ticked.ok, true);
  assert.equal(files.files.read("Chores.md" as never)?.text, "# Chores\n\n- [ ] Water the plants due:2026-10-08 rec:3d last:2026-10-05 #home\n- [ ] Call mum\n");
  assert.equal(files.files.read("Journal/2026-10-05.md" as never)?.text, "# 2026-10-05\n\n## Done\n\n- [x] Water the plants #home done:2026-10-05 ([[Chores]])\n");
  // A plain task is ticked where it is, and not logged by default.
  await run("complete_task", { path: "Chores.md", line: 4, today: "2026-10-05" });
  assert.match(files.files.read("Chores.md" as never)!.text, /- \[x\] Call mum done:2026-10-05/);
  assert.doesNotMatch(files.files.read("Journal/2026-10-05.md" as never)!.text, /Call mum/);
  // The person's settings say how: v1's ticked copy, in another folder.
  await run("write_file", { path: ".common-ink/users/ada@example.com/settings.json", text: '{ "tasks.completionLog": "inline" }', base: 0 });
  await run("complete_task", { path: "Chores.md", line: 3, today: "2026-10-08" });
  assert.match(files.files.read("Chores.md" as never)!.text, /- \[x\] Water the plants due:2026-10-08 rec:3d last:2026-10-05 #home done:2026-10-08\n- \[ \] Water the plants due:2026-10-11 rec:3d last:2026-10-05 #home/);
  // A line that isn't that task any more isn't ticked.
  const stale = await run("complete_task", { path: "Chores.md", line: 3, text: "- [ ] Something else", today: "2026-10-08" });
  assert.deepEqual(stale, { ok: false, error: 'Line 3 of Chores.md isn\'t that task any more: it\'s "- [x] Water the plants due:2026-10-08 rec:3d last:2026-10-05 #home done:2026-10-08"' });
});

test("complete_task needs the person's day, since UTC's is tomorrow on a US evening; without it nothing changes", async () => {
  const files = memoryStore();
  await runOperation("write_file", { path: "Chores.md", text: "# Chores\n\n- [ ] Call mum\n", base: 0 }, files, agent);
  const result = await runOperation("complete_task", { path: "Chores.md", line: 3 }, files, agent);
  assert.deepEqual(result, { ok: false, error: '"today" must be the person\'s local date, as YYYY-MM-DD: the tick writes it as done: and last:' });
  assert.equal(files.files.read("Chores.md" as never)?.text, "# Chores\n\n- [ ] Call mum\n");
});

test("eight tasks ticked at once each get their line in the daily note", async () => {
  const files = memoryStore();
  const chores = ["Water the plants", "Feed the cat", "Pay rent", "Call mum", "Take out the bins", "Book the dentist", "Clean the oven", "Fix the bike"];
  for (const [i, chore] of chores.entries()) await runOperation("write_file", { path: `Chores ${i}.md`, text: `# Chores\n\n- [ ] ${chore} due:2026-10-05 rec:1w\n`, base: 0 }, files, agent);
  const results = await Promise.all(chores.map((_, i) => runOperation("complete_task", { path: `Chores ${i}.md`, line: 3, today: "2026-10-05" }, files, agent)));
  assert.deepEqual(results.map((r) => r.ok), chores.map(() => true));
  const logged = files.files.read("Journal/2026-10-05.md" as never)!.text;
  assert.deepEqual(chores.filter((chore) => !logged.includes(`- [x] ${chore} done:2026-10-05`)), []);
});

test("a repeating task in today's daily note is ticked and logged in that note", async () => {
  const files = memoryStore();
  const daily = "Journal/2026-10-05.md";
  await runOperation("write_file", { path: daily, text: "# 2026-10-05\n\n- [ ] Stretch due:2026-10-05 rec:1d\n", base: 0 }, files, agent);
  const ticked = await runOperation("complete_task", { path: daily, line: 3, today: "2026-10-05" }, files, agent);
  assert.equal(ticked.ok, true);
  assert.equal(files.files.read(daily as never)?.text, "# 2026-10-05\n\n- [ ] Stretch due:2026-10-06 rec:1d last:2026-10-05\n\n## Done\n\n- [x] Stretch done:2026-10-05 ([[Journal/2026-10-05]])\n");
});

test("the same tick sent twice at once, as a client's retry does, ticks once and logs once", async () => {
  const files = memoryStore();
  const line = "- [ ] Water the plants due:2026-10-05 rec:3d";
  await runOperation("write_file", { path: "Chores.md", text: `# Chores\n\n${line}\n`, base: 0 }, files, agent);
  const both = await Promise.all([0, 1].map(() => runOperation("complete_task", { path: "Chores.md", line: 3, text: line, today: "2026-10-05" }, files, agent)));
  assert.deepEqual(both.map((r) => r.ok).sort(), [false, true]);
  assert.equal(files.files.read("Chores.md" as never)?.text, "# Chores\n\n- [ ] Water the plants due:2026-10-08 rec:3d last:2026-10-05\n");
  assert.equal(files.files.read("Journal/2026-10-05.md" as never)!.text.split("\n").filter((l) => l.includes("Water the plants")).length, 1);
});

test("an operation that fails unexpectedly says so in a sentence, logs why, and leaks no stack", async () => {
  const files = memoryStore();
  const broken = { ...files, read: () => { throw new Error("SQLITE_IOERR: disk I/O error at /var/do/123"); } };
  const logged: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    assert.deepEqual(await runOperation("read_file", { path: "Plan.md" }, broken, agent), { ok: false, internal: true, error: "Something went wrong running read_file. It's been logged; try again." });
    const { body } = await call(broken, "tools/call", { name: "read_file", arguments: { path: "Plan.md" } });
    assert.deepEqual(body.result, { content: [{ type: "text", text: "Something went wrong running read_file. It's been logged; try again." }], isError: true });
    assert.equal(logged.length, 2);
    assert.match(String((logged[0] as unknown[])[1]), /read_file/);
  } finally {
    console.error = log;
  }
});
