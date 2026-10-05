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
  assert.deepEqual(tools, ["list_files", "read_file", "write_file", "delete_file", "history", "undo", "data_sources", "list_events", "list_contacts", "diff", "read_version", "restore", "labels", "add_label", "list_embeds", "complete_task", "list_uploads", "upload_file"]);
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
  const stale = await run("complete_task", { path: "Chores.md", line: 3, text: "- [ ] Something else" });
  assert.equal(stale.ok, false);
});
