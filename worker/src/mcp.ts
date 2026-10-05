// The MCP server at /mcp: JSON-RPC over HTTP POST (MCP's Streamable HTTP transport, answering with
// plain JSON). Its tools are the workspace operations (operations.ts), so agents use what the UI uses.
import type { Author } from "./files.ts";
import { isOperation, OPERATIONS, runOperation, type Store } from "./operations.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Common Ink is a workspace of markdown notes and workspace JSON. Read a file before you write it, and pass its revision as `base`. Every change you make is recorded with you as its author; history shows them and undo reverses them. Notes can hold embeds (timers, background noise, small HTML apps and more): list_embeds says which, with examples.";

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const reply = (id: Request["id"], result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const error = (id: Request["id"], code: number, message: string) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function mcp(req: globalThis.Request, store: Store, author: Author): Promise<Response> {
  if (req.method !== "POST") return new Response("POST JSON-RPC messages here.\n", { status: 405, headers: { Allow: "POST" } });
  const msg = (await req.json().catch(() => null)) as Request | null;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(null, -32600, "Not a JSON-RPC 2.0 request");
  // Notifications (no id) need no answer.
  if (msg.id === undefined) return new Response(null, { status: 202 });
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "common-ink", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, {
        tools: Object.entries(OPERATIONS).map(([name, o]) => ({ name, description: o.description, inputSchema: o.input })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!isOperation(name)) return error(msg.id, -32602, `No tool named ${name}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await runOperation(name, args, store, author);
      if (!result.ok) return reply(msg.id, { content: [{ type: "text", text: result.error }], isError: true });
      const value = result.value;
      const failed = value === null || (typeof value === "object" && (value as { status?: string }).status === "conflict");
      return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: failed });
    }
    default:
      return error(msg.id, -32601, `No method ${msg.method}`);
  }
}
