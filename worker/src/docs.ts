// A workspace's docs and their history, on any SQLite: the Durable Object's in production, node:sqlite
// in tests. A doc is a note (markdown) or workspace JSON (app state such as the layout, in .common-ink/).
// Every write is recorded as a change with its author, and a doc's text is what its changes add up to
// (ADR 0002). The docs table keeps the latest text so reads are cheap.
import { diff3Merge, diffPatch, patch, type IPatchRes } from "node-diff3";

export type SqlValue = string | number | null;

export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  tx<T>(fn: () => T): T;
}

/** A doc's path in its workspace, like "Projects/Plan.md" or ".common-ink/layout.json". Only parseDocPath makes one. */
export type DocPath = string & { readonly __brand: "DocPath" };

export function parseDocPath(value: unknown): DocPath | null {
  if (typeof value !== "string" || value.length > 300 || !/\.(md|json)$/.test(value)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.trim() !== p)) return null;
  return value as DocPath;
}

export const isNote = (path: DocPath) => path.endsWith(".md");

/** Who made a change. An agent may be working for a person (`by`), as the CLI and MCP do. */
export type Author = { kind: "user"; email: string } | { kind: "agent"; name: string; by?: string };

/** One string per author, for filtering history by who made a change. */
export const authorKey = (a: Author) => (a.kind === "user" ? `user:${a.email}` : `agent:${a.name}${a.by ? `:${a.by}` : ""}`);

/** Revisions are change numbers, counted across the workspace. 0 is "before the doc existed". */
export type Revision = number;

export interface Doc {
  path: DocPath;
  text: string;
  revision: Revision;
}

export type DocSummary = Omit<Doc, "text">;

/** Line by line, from the doc's previous text to its new one. */
export type Diff = IPatchRes<string>[];

export interface Change {
  revision: Revision;
  path: DocPath;
  author: Author;
  /** The revision the author was looking at. Older than the doc's previous revision when the write was merged. */
  base: Revision;
  diff: Diff;
  time: number;
  /** The change this one undid, if it's an undo. Undoing an undo is a redo. */
  undoes: Revision | null;
  /** The undo in effect for this change, if it's undone (and that undo hasn't itself been undone). Set by `recent`. */
  undoneBy?: Revision | null;
}

/** What undoing one change did. "conflict": the doc has changed since in the same lines, so nothing was done. */
export interface UndoResult {
  revision: Revision;
  status: "undone" | "unchanged" | "conflict" | "missing";
  doc?: Doc;
}

export interface HistoryQuery {
  path?: DocPath;
  /** An authorKey. */
  author?: string;
  /** Only changes older than this revision, for paging. */
  before?: Revision;
  limit?: number;
}

/**
 * "saved": the doc now has the text that was sent. "merged": the write was based on an old revision
 * and was merged with what changed since, so `doc.text` is new to the writer. "conflict": it couldn't
 * be merged, nothing changed, and `doc` is the current doc.
 */
export type WriteResult = { status: "saved" | "merged"; doc: Doc } | { status: "conflict"; doc: Doc | null };

export interface Write {
  path: DocPath;
  text: string;
  base: Revision;
  author: Author;
  undoes?: Revision;
}

/**
 * Notes a Preview starts with. `replace` rewrites a note that exists; otherwise only missing notes are
 * added. `edits` are later versions of notes the seed just added, by named agents, for history to show.
 */
export interface Seed {
  id: string;
  notes: Array<{ path: string; text: string; replace: boolean }>;
  edits?: Array<{ path: string; text: string; agent: string }>;
}

export const SEED_AUTHOR: Author = { kind: "agent", name: "Preview seed" };

const lines = (text: string) => text.split("\n");

const hasTable = (db: Db, name: string) => db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;

/**
 * The database's shape, one step at a time. Each runs once, in order, and the number done is kept in
 * meta's "schema" row. Add steps at the end; never change one that has shipped.
 */
const MIGRATIONS: Array<(db: Db) => void> = [
  // 1. Docs and their changes. The first deploy called the docs table "notes".
  (db) => {
    if (hasTable(db, "notes")) db.run("ALTER TABLE notes RENAME TO docs");
    db.run("CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.run(
      `CREATE TABLE IF NOT EXISTS changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
        author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)`,
    );
    db.run("CREATE INDEX IF NOT EXISTS changes_by_path ON changes(path, revision)");
  },
  // 2. Undo and redo are changes that record which change they undid.
  (db) => db.run("ALTER TABLE changes ADD COLUMN undoes INTEGER"),
];

type ChangeRow = { revision: number; path: DocPath; author: string; base: number; diff: string; time: number; undoes: number | null };
const toChange = (row: ChangeRow): Change => ({ ...row, author: JSON.parse(row.author), diff: JSON.parse(row.diff) });
const invert = (diff: Diff): Diff => diff.map(({ buffer1, buffer2 }) => ({ buffer1: buffer2, buffer2: buffer1 }));

export class Docs {
  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {
    db.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.tx(() => {
      const [row] = db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'");
      const from = Number(row?.value ?? 0);
      MIGRATIONS.slice(from).forEach((migrate) => migrate(db));
      if (from < MIGRATIONS.length) {
        db.run("INSERT INTO meta(key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(MIGRATIONS.length));
      }
    });
  }

  list(): DocSummary[] {
    return this.db.all<DocSummary>("SELECT path, revision FROM docs ORDER BY path");
  }

  read(path: DocPath): Doc | null {
    return this.db.all<Doc>("SELECT path, text, revision FROM docs WHERE path = ?", path)[0] ?? null;
  }

  /** The doc's changes, oldest first. */
  history(path: DocPath): Change[] {
    return this.db.all<ChangeRow>("SELECT * FROM changes WHERE path = ? ORDER BY revision", path).map(toChange);
  }

  /** Changes across the workspace, newest first, optionally for one doc or one author. */
  recent(q: HistoryQuery = {}): Change[] {
    const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
    const rows = this.db.all<ChangeRow>(
      `SELECT * FROM changes WHERE (?1 IS NULL OR path = ?1) AND (?2 IS NULL OR revision < ?2) ORDER BY revision DESC`,
      q.path ?? null,
      q.before ?? null,
    );
    const undoneBy = this.undoneBy();
    const out: Change[] = [];
    for (const row of rows) {
      const change = toChange(row);
      if (q.author && authorKey(change.author) !== q.author) continue;
      out.push({ ...change, undoneBy: undoneBy(change.revision) });
      if (out.length >= limit) break;
    }
    return out;
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
   * reverse into the doc as it is now, so later edits elsewhere in the doc stay.
   */
  undo(revisions: Revision[], author: Author): UndoResult[] {
    return this.db.tx(() =>
      [...new Set(revisions)]
        .sort((a, b) => b - a)
        .map((revision) => {
          const [row] = this.db.all<ChangeRow>("SELECT * FROM changes WHERE revision = ?", revision);
          if (!row) return { revision, status: "missing" as const };
          const change = toChange(row);
          const after = this.textAt(change.path, revision) ?? "";
          const before = patch(lines(after), invert(change.diff)).join("\n");
          const current = this.read(change.path);
          const undone = merge(current?.text ?? "", after, before);
          if (undone === null) return { revision, status: "conflict" as const, doc: current ?? undefined };
          if (current && undone === current.text) return { revision, status: "unchanged" as const, doc: current };
          const result = this.apply({ path: change.path, text: undone, base: current?.revision ?? 0, author, undoes: revision });
          return { revision, status: "undone" as const, doc: result.doc ?? undefined };
        }),
    );
  }

  /**
   * Save a doc's text, given the revision it was based on. If the doc has changed since, the two
   * edits are merged line by line; if they touch the same lines, nothing is saved.
   */
  write(w: Write): WriteResult {
    return this.db.tx(() => this.apply(w));
  }

  /** Apply a seed once: running it again with the same id changes nothing. */
  seed(seed: Seed): void {
    this.db.tx(() => {
      const [applied] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'seed'");
      if (applied?.value === seed.id) return;
      const added = new Set<string>();
      for (const { path: raw, text, replace } of seed.notes) {
        const path = parseDocPath(raw);
        if (!path) throw new Error(`Not a doc path: ${raw}`);
        const current = this.read(path);
        if (!current) added.add(path);
        if (!current || replace) this.apply({ path, text, base: current?.revision ?? 0, author: SEED_AUTHOR });
      }
      for (const { path, text, agent } of seed.edits ?? []) {
        const current = added.has(path) ? this.read(path as DocPath) : null;
        if (current) this.apply({ path: current.path, text, base: current.revision, author: { kind: "agent", name: agent } });
      }
      this.db.run("INSERT INTO meta(key, value) VALUES ('seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seed.id);
    });
  }

  private apply({ path, text, base, author, undoes }: Write): WriteResult {
    const current = this.read(path);
    const currentText = current?.text ?? "";
    let next = text;
    let status: "saved" | "merged" = "saved";
    if (base !== (current?.revision ?? 0)) {
      const baseText = this.textAt(path, base);
      const merged = baseText === null ? null : merge(text, baseText, currentText);
      if (merged === null) return { status: "conflict", doc: current };
      [next, status] = [merged, merged === text ? "saved" : "merged"];
    }
    if (current && next === currentText) return { status, doc: current };
    const diff = JSON.stringify(diffPatch(lines(currentText), lines(next)));
    this.db.run(
      "INSERT INTO changes(path, author, base, diff, time, undoes) VALUES (?, ?, ?, ?, ?, ?)",
      path, JSON.stringify(author), base, diff, this.now(), undoes ?? null,
    );
    const [{ revision }] = this.db.all<{ revision: number }>("SELECT max(revision) AS revision FROM changes");
    this.db.run(
      "INSERT INTO docs(path, text, revision) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET text = excluded.text, revision = excluded.revision",
      path, next, revision,
    );
    return { status, doc: { path, text: next, revision } };
  }

  /** The doc's text at one of its revisions, by undoing its later changes. Null if it never had that revision. */
  private textAt(path: DocPath, revision: Revision): string | null {
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

/** Three-way merge by line, or null when both sides changed the same lines differently. */
export function merge(mine: string, base: string, theirs: string): string | null {
  const regions = diff3Merge(lines(mine), lines(base), lines(theirs), { excludeFalseConflicts: true });
  if (regions.some((r) => r.conflict)) return null;
  return regions.flatMap((r) => r.ok ?? []).join("\n");
}
