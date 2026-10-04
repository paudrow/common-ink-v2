// What people and agents can do with a workspace, defined once. The HTTP API (and so the web app and
// the CLI) and the MCP server both run these, so an agent can do anything the UI does, the same way.
import { DEFAULT_SETTINGS, defaultsText, isReadOnly } from "./settings.ts";
import { parseFilePath, type Author, type Change, type WorkspaceFile, type FileSummary, type HistoryQuery, type Revision, type UndoResult, type Write, type WriteResult } from "./files.ts";

/** The workspace, as the Durable Object's stub offers it. */
export interface Store {
  list(): Promise<FileSummary[]> | FileSummary[];
  read(path: WorkspaceFile["path"]): Promise<WorkspaceFile | null> | WorkspaceFile | null;
  write(w: Write): Promise<WriteResult> | WriteResult;
  recent(q: HistoryQuery): Promise<Change[]> | Change[];
  undo(revisions: Revision[], author: Author): Promise<UndoResult[]> | UndoResult[];
}

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
};

export type OperationName = keyof typeof OPERATIONS;

export const isOperation = (name: string): name is OperationName => Object.hasOwn(OPERATIONS, name);

/** Parse and run an operation. */
export async function runOperation(name: OperationName, args: Args, store: Store, author: Author): Promise<Parsed<unknown>> {
  const operation = OPERATIONS[name] as Operation;
  const parsed = operation.parse(args);
  return parsed.ok ? ok(await operation.run(store, parsed.value, author)) : parsed;
}
