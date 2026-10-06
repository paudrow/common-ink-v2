// The Common Ink CLI: the workspace operations from a terminal, as an agent.
//
//   common-ink ls                      every file and its revision
//   common-ink cat <path>              a file's text
//   common-ink write <path> [--base N] save stdin as a file's text (based on the revision read now, by default)
//   common-ink rm <path> [--base N]    delete a file (undo brings it back)
//   common-ink trash                   notes deleted lately, with the days each has left
//   common-ink restore <note>          bring a note back from Trash, with its history
//   common-ink upload <file> [--name N] upload a file; prints the link to put in a note
//   common-ink search <query...> [--limit N]
//                                      notes the query finds (docs/queries.md), best first
//   common-ink archive <note...>      archive notes (out of the Feed, last in search); undo brings them back
//   common-ink unarchive <note...>
//   common-ink history [path] [--author KEY] [--limit N]
//   common-ink show <revision>         one change's diff
//   common-ink undo <revision...>      undo changes (undoing an undo redoes it)
//   common-ink calendars               your calendars
//   common-ink events [--from T] [--to T] [--days N]
//                                      events from now (or --from) on, each occurrence with its address
//   common-ink event <address>         one event, as stored or worked out from its series
//   common-ink event add <title> --start T [--end T] [--calendar ID] [--location L] [--repeat R]
//   common-ink event set <address> [--title X] [--start T] [--end T] [--location L] [--repeat R] [--scope this|following|all]
//   common-ink event rm <address> [--scope this|following|all]
//   common-ink event link <address> <note.md>
//                                      times are wall times (2026-10-05T09:00) in --zone, or days for all day
//   common-ink reset [scenario]        test levers only (a Preview, npm run dev): empty the workspace and
//                                      seed it again, from a scenario (test/scenarios/) or its own seed
//
// COMMON_INK_URL is the workspace (default http://localhost:8787). Changes are by the agent named in
// COMMON_INK_AGENT (default "CLI"), working for you. Behind Cloudflare Access, set CF_ACCESS_CLIENT_ID
// and CF_ACCESS_CLIENT_SECRET to a service token's. --json prints what the API answered.
import type { Change, WorkspaceFile, FileSummary, UndoResult, WriteResult } from "../worker/src/files.ts";
import { ago, describeAuthor, diffLines, diffStat } from "../web/src/describe.ts";
import type { Calendar, Occurrence } from "../worker/src/calendar.ts";
import type { EditResult } from "../worker/src/data-sources.ts";
import type { EventFound } from "../worker/src/operations.ts";
import type { SearchResults } from "../worker/src/search.ts";

type SearchAnswer = SearchResults & { query: string; problems: string[] };

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

/** Times are read and shown in this zone: --zone, or this computer's. */
const zone = (take("--zone", true) as string | undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

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

/** "Mon Oct 5  09:00–09:15  Team standup ↻  event:…", in --zone. */
function occurrenceLine(o: Occurrence) {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { timeZone: zone, ...opts });
  const day = o.allDay ? new Date(`${o.start}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : fmt(o.start, { weekday: "short", month: "short", day: "numeric" });
  const time = o.allDay ? "all day    " : `${fmt(o.start, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}–${fmt(o.end, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  return `${day.padEnd(11)} ${time}  ${o.title}${o.series ? " ↻" : ""}${o.location ? ` (${o.location})` : ""}  ${o.address}`;
}

function changeLine(c: Change) {
  return `${String(c.revision).padStart(5)}  ${ago(c.time).padEnd(11)} ${c.path}  ${c.purged ? "deleted forever" : c.deleted ? "deleted" : diffStat(c)}  ${describeAuthor(c.author)}${c.undoes ? `  (undoes ${c.undoes})` : ""}`;
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
  async trash() {
    const { data } = await api<Array<{ path: string; time: number; author: Change["author"]; daysLeft: number }>>("GET", "/api/trash");
    print(data, () => data.map((d) => `${String(d.daysLeft).padStart(3)} days left  ${ago(d.time).padEnd(11)} ${d.path}  deleted by ${describeAuthor(d.author)}`).join("\n") || "Trash is empty.");
  },
  async restore() {
    const path = positional()[0];
    const { data } = await api<{ status: string }>("POST", "/api/restore", { path });
    print(data, () => `Restored ${path}, with its history.`);
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
  async search() {
    const limit = take("--limit", true);
    const { data } = await api<SearchAnswer>("GET", `/api/search${q({ query: positional().join(" "), limit: limit as string | undefined, zone })}`);
    print(data, () =>
      [
        ...data.problems.map((p) => `! ${p}`),
        ...data.results.map((r) => `${ago(r.edited).padEnd(11)} ${r.path}${r.archived ? "  (archived)" : ""}${r.line ? `\n${String(r.line.number).padStart(15)}: ${r.line.text}` : ""}`),
        `${data.total} found${data.total > data.results.length ? `, ${data.results.length} shown` : ""}  ${data.query}`,
      ].join("\n"),
    );
  },
  async archive() {
    const { data } = await api<{ revision: number | null; archived: string[] }>("POST", "/api/archive", { paths: positional() });
    print(data, () => (data.revision === null ? "Archived already." : `Archived at revision ${data.revision} (undo ${data.revision} takes it back).`));
  },
  async unarchive() {
    const { data } = await api<{ revision: number | null; archived: string[] }>("POST", "/api/unarchive", { paths: positional() });
    print(data, () => (data.revision === null ? "Not archived." : `Unarchived at revision ${data.revision}.`));
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
  async calendars() {
    const { data } = await api<Calendar[]>("GET", "/api/calendars");
    print(data, () => data.map((c) => `${c.id.padEnd(24)} ${c.title}${c.primary ? " (primary)" : ""}${c.writable ? "" : " (read-only)"}`).join("\n"));
  },
  async events() {
    const days = Number(take("--days", true) ?? 7);
    const from = (take("--from", true) as string | undefined) ?? new Date().toISOString();
    const to = (take("--to", true) as string | undefined) ?? new Date(Date.parse(from) + days * 86_400_000).toISOString();
    const { data } = await api<Occurrence[]>("GET", `/api/events${q({ from, to, zone })}`);
    print(data, () => data.map(occurrenceLine).join("\n") || "No events.");
  },
  async event() {
    const verb = positional()[0];
    const fields = () => {
      const out: Record<string, unknown> = {};
      for (const [flag, key] of [["--title", "title"], ["--start", "start"], ["--end", "end"], ["--calendar", "calendar"], ["--location", "location"], ["--description", "description"], ["--repeat", "recurrence"], ["--scope", "scope"], ["--time-zone", "timeZone"]]) {
        const v = take(flag, true);
        if (typeof v === "string") out[key] = v;
      }
      if (take("--all-day")) out.allDay = true;
      return out;
    };
    const done = (data: EditResult) => print(data, () => `${data.status === "queued" ? `queued (${data.error})` : "saved"} ${data.address}`);
    if (verb === "add") {
      const f = fields();
      done((await api<EditResult>("POST", "/api/events", { ...f, title: positional()[1], zone })).data);
    } else if (verb === "set") {
      const f = fields();
      done((await api<EditResult>("PATCH", "/api/event", { ...f, address: positional()[1], zone })).data);
    } else if (verb === "rm") {
      const f = fields();
      done((await api<EditResult>("DELETE", "/api/event", { ...f, address: positional()[1], zone })).data);
    } else if (verb === "link") {
      const [, address, path] = positional();
      const { data } = await api<{ path: string; link: string }>("POST", "/api/event/link", { address, path });
      print(data, () => `linked ${data.path}: ${data.link}`);
    } else {
      const { data } = await api<EventFound>("GET", `/api/event${q({ address: verb, zone })}`);
      print(data, () => JSON.stringify(data.event, null, 2) + (data.path ? `\nhistory: common-ink history ${data.path}` : `\nan occurrence of ${data.series?.id}; nobody has changed it on its own`));
    }
  },
  async reset() {
    const scenario = positional()[0];
    const { data } = await api<{ scenario: { name: string } }>("POST", "/api/levers/reset", scenario ? { scenario } : {}).catch((err: Error) => {
      throw new Error(/No route/.test(err.message) ? `${base} has no test levers: it's production, or a Worker without LEVERS` : err.message);
    });
    print(data, () => `Reset ${base} to ${data.scenario.name || "its own seed"}`);
  },
};

const run = commands[command ?? ""];
if (!run) {
  console.error(
    "Usage: common-ink ls | cat <path> | write <path> [--base N] | rm <path> [--base N] | trash | restore <note> | upload <file> [--name N] | search <query...> [--limit N] | archive <note...> | unarchive <note...> | history [path] [--author KEY] [--limit N] | show <revision> | undo <revision...> | calendars | events [--from T] [--to T] [--days N] | event <address> | event add <title> --start T | event set <address> [--start T] [--scope S] | event rm <address> [--scope S] | event link <address> <note> | reset [scenario]  [--json] [--zone Z]",
  );
  process.exit(2);
}
await run().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
