// A workspace's files and their history, on any SQLite: the Durable Object's in production, node:sqlite
// in tests. A file is a note (markdown) or workspace JSON (app state such as the layout, in .common-ink/).
// Every write is recorded as a change with its author, and a file's text is what its changes add up to
// (ADR 0002). The files table keeps the latest text so reads are cheap.
import { patch, type IPatchRes } from "node-diff3";
import { lineMerge, linePatch } from "./line-diff.ts";

export type SqlValue = string | number | null;

export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  tx<T>(fn: () => T): T;
}

/** A file's path in its workspace, like "Projects/Plan.md" or ".common-ink/layout.json". Only parseFilePath makes one. */
export type FilePath = string & { readonly __brand: "FilePath" };

export function parseFilePath(value: unknown): FilePath | null {
  if (typeof value !== "string" || value.length > 300) return null;
  // Notes and JSON anywhere; JavaScript only as a workspace extension's code.
  if (!/\.(md|json)$/.test(value) && !EXTENSION_SCRIPT.test(value)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.trim() !== p)) return null;
  return value as FilePath;
}

export const isNote = (path: FilePath) => path.endsWith(".md");

/** A workspace extension's code: any `.js` file in `.common-ink/extensions/<id>/`. */
const EXTENSION_SCRIPT = /^\.common-ink\/extensions\/[a-zA-Z0-9][\w.-]{0,63}\/([\w.-]+\/)*[\w.-]+\.js$/;
export const isExtensionScript = (path: FilePath) => EXTENSION_SCRIPT.test(path);

/**
 * Who made a change: a person, an agent (perhaps working for a person, as the CLI and MCP do), an
 * extension acting for the person using it, or a data source's sync bringing in what changed there
 * ("google-calendar").
 */
export type Author = { kind: "user"; email: string } | { kind: "agent"; name: string; by?: string } | { kind: "extension"; id: string; by: string } | { kind: "sync"; source: string };

/** One string per author, for filtering history by who made a change. */
export function authorKey(a: Author): string {
  switch (a.kind) {
    case "user":
      return `user:${a.email}`;
    case "extension":
      return `extension:${a.id}`;
    case "sync":
      return `sync:${a.source}`;
    case "agent":
      return `agent:${a.name}${a.by ? `:${a.by}` : ""}`;
  }
}

/** Revisions are change numbers, counted across the workspace. 0 is "before the file existed". */
export type Revision = number;

export interface WorkspaceFile {
  path: FilePath;
  text: string;
  revision: Revision;
}

export type FileSummary = Omit<WorkspaceFile, "text">;

/** Line by line, from the file's previous text to its new one. */
export type Diff = IPatchRes<string>[];

export interface Change {
  revision: Revision;
  path: FilePath;
  author: Author;
  /** The revision the author was looking at. Older than the file's previous revision when the write was merged. */
  base: Revision;
  diff: Diff;
  time: number;
  /** The change this one undid, if it's an undo. Undoing an undo is a redo. */
  undoes: Revision | null;
  /** The undo in effect for this change, if it's undone (and that undo hasn't itself been undone). Set by `recent`. */
  undoneBy?: Revision | null;
  /** The change deleted the file. Undoing it brings the file back. */
  deleted?: true;
}

/** A file in Trash: its delete change, and its text just before. */
export interface Deleted {
  path: FilePath;
  /** The delete's revision: undoing it restores the file. */
  revision: Revision;
  author: Author;
  time: number;
  /** The file's last revision before the delete: its text then is the note in Trash. 0 if it had none. */
  before: Revision;
}

/** What undoing one change did. "conflict": the file has changed since in the same lines, so nothing was done. */
export interface UndoResult {
  revision: Revision;
  status: "undone" | "unchanged" | "conflict" | "missing";
  file?: WorkspaceFile;
}

/** What a stretch of changes next to each other in a file's history did: its text before and after them. */
export interface DiffRun {
  revisions: Revision[];
  before: string;
  after: string;
}

/** What chosen changes did to one file. Changes left out split it into runs, so their edits don't show. */
export interface FileDiff {
  path: FilePath;
  runs: DiffRun[];
}

export interface HistoryQuery {
  path?: FilePath;
  /** An authorKey. */
  author?: string;
  /** Only changes older than this revision, for paging. */
  before?: Revision;
  limit?: number;
}

/**
 * "saved": the file now has the text that was sent. "merged": the write was based on an old revision
 * and was merged with what changed since, so `file.text` is new to the writer. "conflict": it couldn't
 * be merged, nothing changed, and `file` is the current file.
 */
export type WriteResult = { status: "saved" | "merged"; file: WorkspaceFile } | { status: "conflict"; file: WorkspaceFile | null; reason?: string };

export interface Write {
  path: FilePath;
  text: string;
  base: Revision;
  author: Author;
  undoes?: Revision;
  /** Delete the file instead: `text` is ignored, and `base` must be its revision. */
  delete?: true;
  /** An id the writer gave this edit, to ask later whether it was applied: a page that went before it heard back. */
  edit?: string;
}

/**
 * Notes a Preview starts with. `replace` rewrites a note that exists; otherwise only missing notes are
 * added. `edits` are later versions of notes the seed just added, by named agents, for history to show.
 */
export interface Seed {
  id: string;
  notes: Array<{ path: string; text: string; replace: boolean }>;
  /** With `label`, the note's state after the edit gets that label, so a Preview has labels to show. With `delete`, the agent deletes the note instead, so Trash has something in it. */
  edits?: Array<{ path: string; text: string; agent: string; label?: string; delete?: true }>;
  /** The scenario it was made from (docs/TESTING.md), and the clock that scenario starts at. */
  scenario?: { name: string; now?: string };
}

export const SEED_AUTHOR: Author = { kind: "agent", name: "Preview seed" };

/** A short, stable fingerprint of a text (FNV-1a), for telling whether a seed's text changed. */
function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const lines = (text: string) => text.split("\n");

/** A Durable Object's SQLite binds at most 100 parameters in a statement, so a list goes in pieces this long. */
const chunks = <T>(xs: readonly T[], size = 100): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

const hasTable = (db: Db, name: string) => db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;

/** Whether a table's definition has a column. ALTER TABLE ADD COLUMN writes it as ", name TYPE" or "name TYPE". */
const hasColumn = (db: Db, table: string, column: string) =>
  new RegExp(`[(,\\s]${column}\\s`).test(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table)[0]?.sql ?? "");

/**
 * The database's shape. Each step looks at what's there before it changes anything, so the whole list
 * runs on every start and any database, however old or half-changed, ends in the same shape. Add steps
 * at the end; a step must be safe to run on a database that already has it.
 */
const SCHEMA: Array<(db: Db) => void> = [
  // Files and their changes. The first deploy called the files table "notes", and early Previews "docs".
  (db) => {
    for (const old of ["notes", "docs"]) if (hasTable(db, old) && !hasTable(db, "files")) db.run(`ALTER TABLE ${old} RENAME TO files`);
    db.run("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.run(
      `CREATE TABLE IF NOT EXISTS changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
        author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)`,
    );
    db.run("CREATE INDEX IF NOT EXISTS changes_by_path ON changes(path, revision)");
  },
  // Undo and redo are changes that record which change they undid.
  (db) => {
    if (!hasColumn(db, "changes", "undoes")) db.run("ALTER TABLE changes ADD COLUMN undoes INTEGER");
  },
  // Data source connections: a person's Google refresh token and what it may read.
  (db) =>
    db.run(
      "CREATE TABLE IF NOT EXISTS connections(email TEXT NOT NULL, provider TEXT NOT NULL, refresh_token TEXT NOT NULL, scopes TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY(email, provider))",
    ),
  // 3. A change can delete its file.
  (db) => {
    if (!hasColumn(db, "changes", "deletes")) db.run("ALTER TABLE changes ADD COLUMN deletes INTEGER NOT NULL DEFAULT 0");
  },
  // 4. The ids writers gave their edits, by file, once applied: with a hash of the text sent, and when.
  (db) => {
    db.run("CREATE TABLE IF NOT EXISTS edits(path TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY(path, id))");
    db.run("CREATE INDEX IF NOT EXISTS edits_by_time ON edits(time)");
  },
];

/** How long an edit's id is kept: a page that went asks about it when its note next opens there. */
const EDIT_DAYS = 30;

/** A hash of an edit's text, to tell whether its id is sent again with the same text: two 32-bit halves (cyrb53) and its length. */
function editHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}:${text.length}`;
}

type ChangeRow = { revision: number; path: FilePath; author: string; base: number; diff: string; time: number; undoes: number | null; deletes: number };
const toChange = ({ deletes, ...row }: ChangeRow): Change => ({ ...row, author: JSON.parse(row.author), diff: JSON.parse(row.diff), ...(deletes ? { deleted: true as const } : {}) });
const invert = (diff: Diff): Diff => diff.map(({ buffer1, buffer2 }) => ({ buffer1: buffer2, buffer2: buffer1 }));

/** What clients hear about each change, as it happens: enough to know whether to fetch the file again. */
export interface ChangeNotice {
  path: FilePath;
  revision: Revision;
  author: Author;
  /** The change deleted the file. */
  deleted?: true;
  /** The change undid this one (a restore from Trash is one). */
  undoes?: Revision;
}

export class Files {
  constructor(
    private db: Db,
    private now: () => number = Date.now,
    /** Told of every change once it's recorded. */
    private announce: (notice: ChangeNotice) => void = () => {},
    /** Told of every file's new text (null: deleted), and the change's revision, inside its transaction, to keep indexes of files. */
    private observe: (path: FilePath, text: string | null, revision: Revision) => void = () => {},
    /** How a file merges, if not line by line: the archive merges as a set (archive.ts). */
    private mergeFor: (path: FilePath) => Merge | undefined = () => undefined,
  ) {
    db.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.tx(() => SCHEMA.forEach((step) => step(db)));
  }

  /** Changes made in the transaction running now, announced once it's kept. */
  private heard: ChangeNotice[] = [];
  /** How many transactions deep the write running now is: only the outermost one's commit is kept. */
  private depth = 0;
  /** A transaction inside the one running now failed: the outer one is rolled back too, even if it caught the error. */
  private innerFailed = false;

  /**
   * A transaction of writes. Open pages hear of its changes only once the outermost one commits, so
   * never of a revision that was rolled back, and one page's socket failing doesn't stop the rest. One
   * inside another is part of the outer one, since SQLite has one transaction at a time: it can't be
   * rolled back alone, so if it fails, the outer one fails as it ends, whether or not it caught the
   * error, and none of either is kept.
   */
  private tx<T>(fn: () => T): T {
    this.depth++;
    try {
      if (this.depth > 1) return fn();
      this.innerFailed = false;
      const out = this.db.tx(() => {
        const out = fn();
        if (this.innerFailed) throw new Error("A write inside this one failed, so none of them were kept");
        return out;
      });
      const notices = this.heard;
      this.heard = [];
      for (const notice of notices) {
        try {
          this.announce(notice);
        } catch (err) {
          console.error("Announcing a change failed:", err);
        }
      }
      return out;
    } catch (err) {
      if (this.depth > 1) this.innerFailed = true;
      // Rolled back: nobody hears of any of it.
      else this.heard = [];
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** Run `fn` as one transaction: its writes all happen, or none do, and nothing comes between them. */
  atomically<T>(fn: () => T): T {
    return this.tx(fn);
  }

  /** Every file but data sources' records, which are listed by their kind (records.ts). */
  list(): FileSummary[] {
    return this.db.all<FileSummary>("SELECT path, revision FROM files WHERE path NOT LIKE '.common-ink/records/%' ORDER BY path");
  }

  /** The notes whose text has any of some strings in it, with their text. */
  notesWith(needles: readonly string[]): WorkspaceFile[] {
    if (!needles.length) return [];
    return this.db.all<WorkspaceFile>(
      `SELECT path, text, revision FROM files WHERE path LIKE '%.md' AND (${needles.map(() => "instr(text, ?) > 0").join(" OR ")}) ORDER BY path`,
      ...needles,
    );
  }

  /** Every file under a folder, with its text: what an index of them is made from. */
  under(prefix: string): WorkspaceFile[] {
    return this.db.all<WorkspaceFile>("SELECT path, text, revision FROM files WHERE substr(path, 1, ?) = ?", prefix.length, prefix);
  }

  read(path: FilePath): WorkspaceFile | null {
    return this.db.all<WorkspaceFile>("SELECT path, text, revision FROM files WHERE path = ?", path)[0] ?? null;
  }

  /** The file's changes, oldest first. */
  history(path: FilePath): Change[] {
    return this.db.all<ChangeRow>("SELECT * FROM changes WHERE path = ? ORDER BY revision", path).map(toChange);
  }

  /** Changes across the workspace, newest first, optionally for one file or one author. */
  recent(q: HistoryQuery = {}): Change[] {
    const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
    // Who made each change is read a page at a time, and only the chosen changes whole, so a long history is never all in memory.
    const chosen: Revision[] = [];
    for (let before = q.before ?? null; chosen.length < limit; ) {
      // One statement per shape, so SQLite pages by the index (changes_by_path, or the revision itself).
      const where = [...(q.path ? ["path = ?"] : []), ...(before !== null ? ["revision < ?"] : [])];
      const page = this.db.all<{ revision: number; author: string }>(
        `SELECT revision, author FROM changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY revision DESC LIMIT 1000`,
        ...(q.path ? [q.path] : []),
        ...(before !== null ? [before] : []),
      );
      for (const { revision, author } of page) {
        if (chosen.length < limit && (!q.author || authorKey(JSON.parse(author)) === q.author)) chosen.push(revision);
      }
      if (page.length < 1000) break;
      before = page.at(-1)!.revision;
    }
    const undoneBy = this.undoneBy();
    return chunks(chosen)
      .flatMap((some) => this.db.all<ChangeRow>(`SELECT * FROM changes WHERE revision IN (${some.map(() => "?").join(",")})`, ...some))
      .sort((a, b) => b.revision - a.revision)
      .map((row) => ({ ...toChange(row), undoneBy: undoneBy(row.revision) }));
  }

  /** Which undo, if any, is in effect for a change: the latest undo of it that hasn't been undone itself. */
  private undoneBy(): (revision: Revision) => Revision | null {
    const undos = new Map<Revision, Revision[]>();
    for (const { revision, undoes } of this.db.all<{ revision: number; undoes: number }>("SELECT revision, undoes FROM changes WHERE undoes IS NOT NULL ORDER BY revision")) {
      undos.set(undoes, [...(undos.get(undoes) ?? []), revision]);
    }
    const memo = new Map<Revision, Revision | null>();
    const find = (revision: Revision): Revision | null => {
      if (!memo.has(revision)) memo.set(revision, [...(undos.get(revision) ?? [])].reverse().find((u) => find(u) === null) ?? null);
      return memo.get(revision)!;
    };
    return find;
  }

  /**
   * Undo changes, newest first, each as a new change by `author`. A change is undone by merging its
   * reverse into the file as it is now, so later edits elsewhere in the file stay.
   */
  undo(revisions: Revision[], author: Author): UndoResult[] {
    return this.tx(() =>
      [...new Set(revisions)]
        .sort((a, b) => b - a)
        .map((revision) => {
          const [row] = this.db.all<ChangeRow>("SELECT * FROM changes WHERE revision = ?", revision);
          if (!row) return { revision, status: "missing" as const };
          const change = toChange(row);
          const after = this.textAt(change.path, revision) ?? "";
          const before = patch(lines(after), invert(change.diff)).join("\n");
          const current = this.read(change.path);
          const undone = (this.mergeFor(change.path) ?? merge)(current?.text ?? "", after, before);
          if (undone === null) return { revision, status: "conflict" as const, file: current ?? undefined };
          if (current && undone === current.text) return { revision, status: "unchanged" as const, file: current };
          const result = this.apply({ path: change.path, text: undone, base: current?.revision ?? 0, author, undoes: revision });
          return { revision, status: "undone" as const, file: result.file ?? undefined };
        }),
    );
  }

  /**
   * What chosen changes did together, file by file. Within a file, chosen changes that sit next to each
   * other in its history make one run, from the text before the first to the text after the last; a
   * change that wasn't chosen ends a run, so its edits are left out.
   */
  combined(revisions: Revision[]): FileDiff[] {
    const chosen = new Set(revisions);
    const paths = [...new Set(chunks([...chosen]).flatMap((some) => this.db.all<{ path: FilePath }>(`SELECT path FROM changes WHERE revision IN (${some.map(() => "?").join(",")})`, ...some).map((r) => r.path)))];
    return paths.sort().map((path) => {
      const history = this.history(path);
      const runs: DiffRun[] = [];
      let run: Revision[] = [];
      const close = () => {
        if (!run.length) return;
        const first = history.findIndex((c) => c.revision === run[0]);
        const before = first > 0 ? this.textAt(path, history[first - 1].revision)! : "";
        runs.push({ revisions: run, before, after: this.textAt(path, run.at(-1)!)! });
        run = [];
      };
      for (const c of history) {
        if (chosen.has(c.revision)) run.push(c.revision);
        else close();
      }
      close();
      return { path, runs };
    });
  }

  /**
   * Deletes since a time that are in effect, newest first: each is a file in Trash, whatever is at its
   * path now (a daily note made again, say). A delete that was undone, or restored, isn't one. Only
   * revisions and times are read here; a deleted file's text is `versionAt(path, before)`, when asked.
   */
  deleted(since: number): Deleted[] {
    const undoneBy = this.undoneBy();
    return this.db
      .all<{ revision: number; path: FilePath; author: string; time: number }>("SELECT revision, path, author, time FROM changes WHERE deletes = 1 AND time >= ? ORDER BY revision DESC", since)
      .filter((d) => undoneBy(d.revision) === null)
      .map(({ revision, path, author, time }) => {
        const [before] = this.db.all<{ r: number | null }>("SELECT max(revision) AS r FROM changes WHERE path = ? AND revision < ?", path, revision);
        return { path, revision, author: JSON.parse(author) as Author, time, before: before?.r ?? 0 };
      });
  }

  /** A file's text just before a revision (of any file): "" if it had none yet. */
  textBefore(path: FilePath, revision: Revision): string {
    const [row] = this.db.all<{ r: number | null }>("SELECT max(revision) AS r FROM changes WHERE path = ? AND revision < ?", path, revision);
    return row?.r ? (this.textAt(path, row.r) ?? "") : "";
  }

  /** A file's text at one of its revisions, or null if it never had that revision. */
  versionAt(path: FilePath, revision: Revision): string | null {
    return this.textAt(path, revision);
  }

  /**
   * Put a file back the way it was at one of its revisions (or just before one of its changes), as a
   * new change by `author`. Nothing is
   * lost: the changes since stay in history, and this one can be undone like any other.
   */
  restore(path: FilePath, at: { revision: Revision } | { before: Revision }, author: Author): WriteResult | null {
    return this.tx(() => {
      const revision =
        "revision" in at
          ? at.revision
          : (this.db.all<{ r: number | null }>("SELECT max(revision) AS r FROM changes WHERE path = ? AND revision < ?", path, at.before)[0]?.r ?? 0);
      const text = this.textAt(path, revision);
      if (text === null) return null;
      const current = this.read(path);
      return this.apply({ path, text, base: current?.revision ?? 0, author });
    });
  }

  /**
   * Save a file's text, given the revision it was based on. If the file has changed since, the two
   * edits are merged line by line; if they touch the same lines, nothing is saved.
   */
  write(w: Write): WriteResult {
    return this.tx(() => this.apply(w));
  }

  /** Several writes in one transaction, with `also` run in it after them: all of it happens, or none. */
  writeAll(ws: readonly Write[], also: () => void = () => {}): WriteResult[] {
    return this.tx(() => {
      const results = ws.map((w) => this.apply(w));
      also();
      return results;
    });
  }

  /** The highest revision ever given, even once its changes are gone (as after a reset): 0 before any. */
  lastRevision(): Revision {
    return this.db.all<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'changes'")[0]?.seq ?? 0;
  }

  /** A random secret by name, made the first time it's asked for and kept from then on. */
  secret(name: string): string {
    return this.db.tx(() => {
      const key = `secret:${name}`;
      const [row] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
      if (row) return row.value;
      const value = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.db.run("INSERT INTO meta(key, value) VALUES (?, ?)", key, value);
      return value;
    });
  }

  /**
   * Apply a seed once: running it again with the same id changes nothing. A note is written if it's
   * missing, if the seed says to replace it, or if the seed's text for it changed since it was last
   * seeded: a demo the PR changed shows as it is now, and what was there is in history.
   */
  seed(seed: Seed): void {
    this.tx(() => {
      const [applied] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'seed'");
      if (applied?.value === seed.id) return;
      const added = new Set<string>();
      for (const { path: raw, text, replace } of seed.notes) {
        const path = parseFilePath(raw);
        if (!path) throw new Error(`Not a file path: ${raw}`);
        const current = this.read(path);
        const key = `seeded:${path}`;
        const [seeded] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
        // Seeded before seeds were remembered: changed if it reads differently now.
        const changed = seeded ? seeded.value !== textHash(text) : current?.text !== text;
        if (!current) added.add(path);
        if (!current || replace || changed) this.apply({ path, text, base: current?.revision ?? 0, author: SEED_AUTHOR });
        this.db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, textHash(text));
      }
      const labels: Array<{ name: string; path: FilePath; revision: Revision }> = [];
      for (const { path, text, agent, label, delete: deleting } of seed.edits ?? []) {
        const current = added.has(path) ? this.read(path as FilePath) : null;
        if (!current) continue;
        const result = this.apply({ path: current.path, text, base: current.revision, author: { kind: "agent", name: agent }, ...(deleting ? { delete: true as const } : {}) });
        if (label && result.file) labels.push({ name: label, path: current.path, revision: result.file.revision });
      }
      if (labels.length) {
        // The labels file's own format (labels.ts), written here so seeding doesn't depend on it.
        const path = ".common-ink/labels.json" as FilePath;
        const file = this.read(path);
        const existing = (() => {
          try {
            return (JSON.parse(file?.text ?? "{}").labels as unknown[]) ?? [];
          } catch {
            return [];
          }
        })();
        this.apply({ path, text: `${JSON.stringify({ labels: [...existing, ...labels] }, null, 2)}\n`, base: file?.revision ?? 0, author: SEED_AUTHOR });
      }
      this.db.run("INSERT INTO meta(key, value) VALUES ('seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seed.id);
    });
  }

  private apply(w: Write): WriteResult {
    const hash = w.edit === undefined ? "" : editHash(w.text);
    const known = w.edit === undefined ? undefined : this.db.all<{ hash: string }>("SELECT hash FROM edits WHERE path = ? AND id = ?", w.path, w.edit)[0];
    if (known) {
      const current = this.read(w.path);
      // Sent again by a page that never heard the answer: it's in already, and the file is as it is now.
      if (known.hash === hash) return current ? { status: "saved", file: current } : { status: "conflict", file: null, reason: "That edit was applied, and the file has been deleted since" };
      // An id is for one text: another under it would be lost, said to be saved.
      return { status: "conflict", file: current, reason: "This edit id was already used for different text" };
    }
    const result = this.applyWrite(w);
    // Applied, even as a merge or with nothing left to change: the writer may ask by its id.
    if (w.edit !== undefined && result.status !== "conflict") {
      const now = this.now();
      this.db.run("INSERT OR IGNORE INTO edits(path, id, revision, hash, time) VALUES (?, ?, ?, ?, ?)", w.path, w.edit, result.file.revision, hash, now);
      this.db.run("DELETE FROM edits WHERE time < ?", now - EDIT_DAYS * 86_400_000);
    }
    return result;
  }

  /** Whether the edit a writer gave this id was applied to the file. */
  editApplied(path: FilePath, id: string): boolean {
    return this.db.all("SELECT 1 FROM edits WHERE path = ? AND id = ?", path, id).length > 0;
  }

  private applyWrite({ path, text, base, author, undoes, delete: deleting }: Write): WriteResult {
    const current = this.read(path);
    const currentText = current?.text ?? "";
    // A delete is never merged: it has to be of the file as it is.
    if (deleting && (!current || base !== current.revision)) return { status: "conflict", file: current };
    let next = deleting ? "" : text;
    let status: "saved" | "merged" = "saved";
    if (!deleting && base !== (current?.revision ?? 0)) {
      const baseText = this.textAt(path, base);
      const merged = baseText === null ? null : (this.mergeFor(path) ?? merge)(text, baseText, currentText);
      if (merged === null) return { status: "conflict", file: current };
      [next, status] = [merged, merged === text ? "saved" : "merged"];
    }
    if (current && next === currentText && !deleting) return { status, file: current };
    const diff = JSON.stringify(linePatch(lines(currentText), lines(next)));
    this.db.run(
      "INSERT INTO changes(path, author, base, diff, time, undoes, deletes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      path, JSON.stringify(author), base, diff, this.now(), undoes ?? null, deleting ? 1 : 0,
    );
    const [{ revision }] = this.db.all<{ revision: number }>("SELECT max(revision) AS revision FROM changes");
    if (deleting) {
      this.db.run("DELETE FROM files WHERE path = ?", path);
      this.observe(path, null, revision);
      this.heard.push({ path, revision, author, deleted: true, ...(undoes ? { undoes } : {}) });
      return { status, file: { path, text: "", revision } };
    }
    this.db.run(
      "INSERT INTO files(path, text, revision) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET text = excluded.text, revision = excluded.revision",
      path, next, revision,
    );
    this.observe(path, next, revision);
    this.heard.push({ path, revision, author, ...(undoes ? { undoes } : {}) });
    return { status, file: { path, text: next, revision } };
  }

  /** The file's text at one of its revisions, by undoing its later changes. Null if it never had that revision. */
  private textAt(path: FilePath, revision: Revision): string | null {
    if (revision === 0) return "";
    const changes = this.history(path);
    if (!changes.some((c) => c.revision === revision)) return null;
    let text = lines(this.read(path)?.text ?? "");
    for (const c of changes.reverse()) {
      if (c.revision === revision) break;
      text = patch(text, invert(c.diff));
    }
    return text.join("\n");
  }
}

/** A three-way merge of a file's text: mine and theirs, from base. Null when they can't be merged. */
export type Merge = (mine: string, base: string, theirs: string) => string | null;

/** Three-way merge by line, or null when both sides changed the same lines differently. */
export function merge(mine: string, base: string, theirs: string): string | null {
  return lineMerge(lines(mine), lines(base), lines(theirs))?.join("\n") ?? null;
}
