// The Common Ink CLI: the workspace operations from a terminal, as an agent.
//
//   common-ink ls                      every file and its revision
//   common-ink cat <path>              a file's text
//   common-ink write <path> [--base N] save stdin as a file's text (based on the revision read now, by default)
//   common-ink rm <path> [--base N]    delete a file (undo brings it back)
//   common-ink upload <file> [--name N] upload a file; prints the link to put in a note
//   common-ink history [path] [--author KEY] [--limit N]
//   common-ink show <revision>         one change's diff
//   common-ink undo <revision...>      undo changes (undoing an undo redoes it)
//
// COMMON_INK_URL is the workspace (default http://localhost:8787). Changes are by the agent named in
// COMMON_INK_AGENT (default "CLI"), working for you. Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID
// and CF_ACCESS_CLIENT_SECRET to a service token's. --json prints what the API answered.
import type { Change, WorkspaceFile, FileSummary, UndoResult, WriteResult } from "../worker/src/files.ts";
import { ago, describeAuthor, diffLines, diffStat } from "../web/src/describe.ts";

const base = (process.env.COMMON_INK_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const args = process.argv.slice(2);
const json = take("--json");
const command = args[0];
/** The arguments after the command, once a command has taken its flags. */
const positional = () => args.slice(1);

function take(flag: string, withValue = false): string | true | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, withValue ? 2 : 1);
  return withValue ? value : true;
}

async function api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { "X-Common-Ink-Agent": process.env.COMMON_INK_AGENT ?? "CLI", "Content-Type": "application/json" };
  if (process.env.CF_ACCESS_CLIENT_ID) headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  if (process.env.CF_ACCESS_CLIENT_SECRET) headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as T;
  if (res.status >= 400 && res.status !== 409) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(data) ?? ""}`);
  return { status: res.status, data };
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return s ? `?${s}` : "";
};

function print(data: unknown, text: () => string) {
  console.log(json ? JSON.stringify(data, null, 2) : text());
}

function changeLine(c: Change) {
  return `${String(c.revision).padStart(5)}  ${ago(c.time).padEnd(11)} ${c.path}  ${c.deleted ? "deleted" : diffStat(c)}  ${describeAuthor(c.author)}${c.undoes ? `  (undoes ${c.undoes})` : ""}`;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const commands: Record<string, () => Promise<void>> = {
  async ls() {
    const { data } = await api<FileSummary[]>("GET", "/api/files");
    print(data, () => data.map((d) => `${String(d.revision).padStart(5)}  ${d.path}`).join("\n"));
  },
  async cat() {
    const { data } = await api<WorkspaceFile>("GET", `/api/file${q({ path: positional()[0] })}`);
    print(data, () => data.text);
  },
  async write() {
    const baseFlag = take("--base", true);
    const path = positional()[0];
    const text = await readStdin();
    const revision = typeof baseFlag === "string" ? Number(baseFlag) : await api<WorkspaceFile>("GET", `/api/file${q({ path })}`).then((r) => r.data.revision, () => 0);
    const { status, data } = await api<WriteResult>("PUT", "/api/file", { path, text, base: revision });
    print(data, () => (data.status === "conflict" ? `Not saved: ${path} changed in the same lines since revision ${revision}.` : `${data.status} ${path} at revision ${data.file?.revision}`));
    if (status === 409) process.exitCode = 1;
  },
  async rm() {
    const baseFlag = take("--base", true);
    const path = positional()[0];
    const revision = typeof baseFlag === "string" ? Number(baseFlag) : (await api<WorkspaceFile>("GET", `/api/file${q({ path })}`)).data.revision;
    const { status, data } = await api<WriteResult>("DELETE", "/api/file", { path, base: revision });
    print(data, () => (data.status === "conflict" ? `Not deleted: ${path} changed since revision ${revision}.` : `deleted ${path} at revision ${data.file?.revision}`));
    if (status === 409) process.exitCode = 1;
  },
  async upload() {
    const nameFlag = take("--name", true);
    const local = positional()[0];
    if (!local) throw new Error("Usage: common-ink upload <file> [--name NAME]");
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    const name = typeof nameFlag === "string" ? nameFlag : basename(local);
    const headers: Record<string, string> = { "X-Common-Ink-Agent": process.env.COMMON_INK_AGENT ?? "CLI", "Content-Type": "application/octet-stream" };
    if (process.env.CF_ACCESS_CLIENT_ID) headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    if (process.env.CF_ACCESS_CLIENT_SECRET) headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
    const res = await fetch(`${base}/api/upload${q({ name })}`, { method: "PUT", headers, body: await readFile(local) });
    const data = (await res.json().catch(() => null)) as { status?: string; url?: string; upload?: { name: string; type: string }; error?: string } | null;
    if (!res.ok || !data?.upload) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
    const { name: saved, type } = data.upload;
    print(data, () => `${data.status} ${saved}\n${type.startsWith("image/") ? `![${saved.replace(/\.[^.]+$/, "")}](${data.url})` : `[${saved}](${data.url})`}`);
  },
  async history() {
    const author = take("--author", true);
    const limit = take("--limit", true);
    const { data } = await api<Change[]>("GET", `/api/history${q({ path: positional()[0], author: author as string | undefined, limit: limit as string | undefined })}`);
    print(data, () => data.map(changeLine).join("\n"));
  },
  async show() {
    const revision = Number(positional()[0]);
    const { data } = await api<Change[]>("GET", `/api/history${q({ before: String(revision + 1), limit: "1" })}`);
    const change = data.find((c) => c.revision === revision);
    if (!change) throw new Error(`No change ${revision}`);
    print(change, () => [changeLine(change), ...diffLines(change).map((l) => `${l.kind}${String(l.line).padStart(4)} ${l.text}`)].join("\n"));
  },
  async undo() {
    const { data } = await api<UndoResult[]>("POST", "/api/undo", { revisions: positional().map(Number) });
    print(data, () => data.map((r) => `${r.revision}: ${r.status}`).join("\n"));
  },
};

const run = commands[command ?? ""];
if (!run) {
  console.error("Usage: common-ink ls | cat <path> | write <path> [--base N] | rm <path> [--base N] | upload <file> [--name N] | history [path] [--author KEY] [--limit N] | show <revision> | undo <revision...>  [--json]");
  process.exit(2);
}
await run().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
