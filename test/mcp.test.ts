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
  assert.deepEqual(tools, ["list_files", "read_file", "write_file", "delete_file", "history", "undo", "data_sources", "list_events", "list_contacts", "diff", "read_version", "restore", "labels", "add_label", "list_embeds", "list_uploads", "upload_file"]);
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
