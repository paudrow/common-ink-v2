// What people and agents can do with a workspace, defined once. The HTTP API (and so the web app and
// the CLI) and the MCP server both run these, so an agent can do anything the UI does, the same way.
import type { SourceStatus } from "./data-sources.ts";
import { DEFAULT_SETTINGS, defaultsText, isReadOnly } from "./settings.ts";
import type { Contact, Event } from "./sources.ts";
import { LABELS_PATH, labelsText, parseLabels } from "./labels.ts";
import { parseFilePath, type Author, type FileDiff, type FilePath, type Change, type WorkspaceFile, type FileSummary, type HistoryQuery, type Revision, type UndoResult, type Write, type WriteResult } from "./files.ts";

/** The workspace, as the Durable Object's stub offers it. */
export interface Store {
  list(): Promise<FileSummary[]> | FileSummary[];
  read(path: WorkspaceFile["path"]): Promise<WorkspaceFile | null> | WorkspaceFile | null;
  write(w: Write): Promise<WriteResult> | WriteResult;
  recent(q: HistoryQuery): Promise<Change[]> | Change[];
  undo(revisions: Revision[], author: Author): Promise<UndoResult[]> | UndoResult[];
  sourceStatus(email: string): Promise<SourceStatus> | SourceStatus;
  events(email: string, from: string, to: string): Promise<Event[]>;
  contacts(email: string, query: string): Promise<Contact[]>;
  combined(revisions: Revision[]): Promise<FileDiff[]> | FileDiff[];
  versionAt(path: FilePath, revision: Revision): Promise<string | null> | string | null;
  restore(path: FilePath, at: { revision: Revision } | { before: Revision }, author: Author): Promise<WriteResult | null> | WriteResult | null;
}

/** The person whose data sources an author reads: themselves, or whoever an agent works for. */
function personOf(author: Author): string {
  const email = author.kind === "user" ? author.email : author.by;
  if (!email) throw new Error("Data sources belong to a person, and this agent isn't working for one");
  return email;
}

const isoTime = (v: unknown, fallback: Date): string | null => {
  if (v === undefined || v === "") return fallback.toISOString();
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** Files are larger than this only by mistake, and a Durable Object's SQLite rows top out at 2 MB. */
const MAX_FILE_BYTES = 1_000_000;

type Args = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Operation<T = unknown> {
  description: string;
  /** JSON Schema for the arguments, as MCP lists it. */
  input: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  parse(args: Args): Parsed<T>;
  run(store: Store, args: T, author: Author): Promise<unknown>;
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ ok: false, error });

/** A whole number from JSON or a query string. */
function count(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : undefined;
}

const PATH = { type: "string", description: 'A file\'s path, like "Projects/Plan.md" or ".common-ink/layout.json"' };

function op<T>(o: Operation<T>): Operation<T> {
  return o;
}

export const OPERATIONS = {
  list_files: op<Record<string, never>>({
    description: "List every file in the workspace (notes and workspace JSON) with its revision.",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store) => store.list(),
  }),
  read_file: op<{ path: WorkspaceFile["path"] }>({
    description: "Read a file's text and revision. Pass the revision back as `base` when you write it.",
    input: { type: "object", properties: { path: PATH }, required: ["path"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      return path ? ok({ path }) : fail('"path" must be a path ending in .md or .json');
    },
    run: async (store, { path }) => (path === DEFAULT_SETTINGS ? { path, text: defaultsText(), revision: 0 } : store.read(path)),
  }),
  write_file: op<Omit<Write, "author">>({
    description:
      "Write a file's whole text, given the revision you read (`base`, or 0 for a new file). If it changed since, your edit is merged in; if it can't be, nothing is saved and you get the current file back.",
    input: {
      type: "object",
      properties: { path: PATH, text: { type: "string" }, base: { type: "integer", minimum: 0 } },
      required: ["path", "text", "base"],
    },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const base = count(a.base);
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (isReadOnly(path)) return fail(`${path} is written by Common Ink and can't be changed`);
      if (typeof a.text !== "string" || new TextEncoder().encode(a.text).length > MAX_FILE_BYTES) return fail('"text" must be a string under 1 MB');
      if (base === undefined) return fail('"base" must be the revision you started from, or 0 for a new file');
      return ok({ path, text: a.text, base });
    },
    run: async (store, w, author) => store.write({ ...w, author }),
  }),
  delete_file: op<{ path: FilePath; base: Revision }>({
    description:
      "Delete a file, given the revision you read (`base`). It's a change like any other: it shows in history, and undoing it brings the file back. If the file changed since you read it, nothing is deleted.",
    input: { type: "object", properties: { path: PATH, base: { type: "integer", minimum: 1 } }, required: ["path", "base"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const base = count(a.base);
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (isReadOnly(path)) return fail(`${path} is written by Common Ink and can't be changed`);
      if (!base) return fail('"base" must be the revision you read');
      return ok({ path, base });
    },
    run: async (store, { path, base }, author) => store.write({ path, text: "", base, author, delete: true }),
  }),
  history: op<HistoryQuery>({
    description: "Changes across the workspace, newest first, each with its author, time and line diff. Filter by file or by author.",
    input: {
      type: "object",
      properties: {
        path: PATH,
        author: { type: "string", description: 'An author key from a change\'s "author", like "agent:Claude:ada@example.com" or "user:ada@example.com"' },
        before: { type: "integer", description: "Only changes older than this revision, for paging" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    parse: (a) => {
      const q: HistoryQuery = {};
      if (a.path !== undefined && a.path !== "") {
        const path = parseFilePath(a.path);
        if (!path) return fail('"path" must be a path ending in .md or .json');
        q.path = path;
      }
      if (typeof a.author === "string" && a.author) q.author = a.author;
      q.before = count(a.before);
      q.limit = count(a.limit);
      return ok(q);
    },
    run: async (store, q) => store.recent(q),
  }),
  undo: op<{ revisions: Revision[] }>({
    description:
      "Undo changes by revision, newest first, each recorded as a new change by you. Later edits elsewhere in the file are kept; an undo that clashes with them does nothing. Undoing an undo redoes it.",
    input: { type: "object", properties: { revisions: { type: "array", items: { type: "integer" }, minItems: 1 } }, required: ["revisions"] },
    parse: (a) => {
      const revisions = Array.isArray(a.revisions) ? a.revisions.map(count) : [];
      return revisions.length && revisions.every((r) => r !== undefined && r > 0) ? ok({ revisions: revisions as number[] }) : fail('"revisions" must be a list of change revisions');
    },
    run: async (store, { revisions }, author) => store.undo(revisions, author),
  }),
  data_sources: op<Record<string, never>>({
    description: "Which data sources you have: your Google calendar and contacts, sample data, or none yet.",
    input: { type: "object", properties: {} },
    parse: () => ok({}),
    run: async (store, _args, author) => store.sourceStatus(personOf(author)),
  }),
  list_events: op<{ from: string; to: string }>({
    description: "Calendar events between two times (ISO 8601; by default the next 14 days), with recurring events as separate occurrences.",
    input: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } },
    parse: (a) => {
      const now = new Date();
      const from = isoTime(a.from, now);
      const to = isoTime(a.to, new Date(Date.parse(from ?? now.toISOString()) + 14 * 86_400_000));
      if (!from || !to) return fail('"from" and "to" must be times, like "2026-10-05T00:00:00Z"');
      return to > from ? ok({ from, to }) : fail('"to" must be after "from"');
    },
    run: async (store, { from, to }, author) => store.events(personOf(author), from, to),
  }),
  list_contacts: op<{ query: string }>({
    description: "Your contacts, optionally only those whose name, email or organization contains `query`.",
    input: { type: "object", properties: { query: { type: "string" } } },
    parse: (a) => ok({ query: typeof a.query === "string" ? a.query : "" }),
    run: async (store, { query }, author) => store.contacts(personOf(author), query),
  }),
  diff: op<{ revisions: Revision[] }>({
    description:
      "What chosen changes did together, file by file: each run of changes next to each other in a file's history, as its text before and after. Changes not chosen are left out.",
    input: { type: "object", properties: { revisions: { type: "array", items: { type: "integer" }, minItems: 1 } }, required: ["revisions"] },
    parse: (a) => {
      const revisions = Array.isArray(a.revisions) ? a.revisions.map(count) : [];
      return revisions.length && revisions.every((r) => r !== undefined && r > 0) ? ok({ revisions: revisions as number[] }) : fail('"revisions" must be a list of change revisions');
    },
    run: async (store, { revisions }) => store.combined(revisions),
  }),
  read_version: op<{ path: FilePath; revision: Revision }>({
    description: "A file's text as it was at one of its revisions (a change's revision, or a label's).",
    input: { type: "object", properties: { path: PATH, revision: { type: "integer", minimum: 1 } }, required: ["path", "revision"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const revision = count(a.revision);
      return path && revision ? ok({ path, revision }) : fail('"path" and "revision" must name one of the file\'s revisions');
    },
    run: async (store, { path, revision }) => {
      const text = await store.versionAt(path, revision);
      return text === null ? null : { path, revision, text };
    },
  }),
  restore: op<{ path: FilePath; at: { revision: Revision } | { before: Revision } }>({
    description:
      "Put a file back the way it was at one of its revisions (`revision`, such as a label's), or just before one of its changes (`before`), as a new change by you. The changes since stay in history, and this can be undone.",
    input: { type: "object", properties: { path: PATH, revision: { type: "integer", minimum: 0 }, before: { type: "integer", minimum: 1 } }, required: ["path"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const revision = count(a.revision);
      const before = count(a.before);
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (revision !== undefined) return ok({ path, at: { revision } });
      return before ? ok({ path, at: { before } }) : fail('Say which version: "revision", or "before" a change');
    },
    run: async (store, { path, at }, author) => store.restore(path, at, author),
  }),
  labels: op<{ path?: FilePath }>({
    description: "Labels: names given to a note's state at one revision. All of them, or one file's.",
    input: { type: "object", properties: { path: PATH } },
    parse: (a) => {
      if (a.path === undefined || a.path === "") return ok({});
      const path = parseFilePath(a.path);
      return path ? ok({ path }) : fail('"path" must be a path ending in .md or .json');
    },
    run: async (store, { path }) => {
      const labels = parseLabels((await store.read(LABELS_PATH))?.text ?? "");
      return path ? labels.filter((l) => l.path === path) : labels;
    },
  }),
  add_label: op<{ path: FilePath; name: string; revision?: Revision }>({
    description: "Name a note's state at a revision (by default, as it is now), so you can find it, open it and restore it later.",
    input: { type: "object", properties: { path: PATH, name: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["path", "name"] },
    parse: (a) => {
      const path = parseFilePath(a.path);
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (!path) return fail('"path" must be a path ending in .md or .json');
      if (!name || name.length > 80) return fail('"name" must be 1 to 80 characters');
      return ok({ path, name, revision: count(a.revision) });
    },
    run: async (store, { path, name, revision }, author) => {
      const at = revision ?? (await store.read(path))?.revision;
      if (!at) throw new OperationError(`${path} has no saved version to label yet`);
      // The labels file is shared: re-read and try again if someone else wrote it meanwhile.
      for (let tries = 0; tries < 3; tries++) {
        const file = await store.read(LABELS_PATH);
        const labels = parseLabels(file?.text ?? "").filter((l) => !(l.path === path && l.name === name));
        const result = await store.write({ path: LABELS_PATH, text: labelsText([...labels, { name, path, revision: at }]), base: file?.revision ?? 0, author });
        if (result.status !== "conflict") return { name, path, revision: at };
      }
      throw new OperationError("The labels file kept changing; try again");
    },
  }),
};

/** An operation couldn't be done, for a reason the caller can act on: it comes back as an error, not a crash. */
export class OperationError extends Error {}

export type OperationName = keyof typeof OPERATIONS;

export const isOperation = (name: string): name is OperationName => Object.hasOwn(OPERATIONS, name);

/** Parse and run an operation. */
export async function runOperation(name: OperationName, args: Args, store: Store, author: Author): Promise<Parsed<unknown>> {
  const operation = OPERATIONS[name] as Operation;
  const parsed = operation.parse(args);
  if (!parsed.ok) return parsed;
  try {
    return ok(await operation.run(store, parsed.value, author));
  } catch (err) {
    // Data sources fail in ways the caller can fix (connect Google); say how instead of a 500.
    if (name === "data_sources" || name === "list_events" || name === "list_contacts") return fail((err as Error).message);
    if (err instanceof OperationError) return fail(err.message);
    throw err;
  }
}
