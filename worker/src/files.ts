// A workspace's files and their history, on any SQLite: the Durable Object's in production, node:sqlite
// in tests. A file is a note (markdown) or workspace JSON (app state such as the layout, in .common-ink/).
// Every write is recorded as a change with its author, and a file's text is what its changes add up to
// (ADR 0002). The files table keeps the latest text so reads are cheap.
import { diff3Merge, diffPatch, patch, type IPatchRes } from "node-diff3";

export type SqlValue = string | number | null;

export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  tx<T>(fn: () => T): T;
}

/** A file's path in its workspace, like "Projects/Plan.md" or ".common-ink/layout.json". Only parseFilePath makes one. */
export type FilePath = string & { readonly __brand: "FilePath" };

export function parseFilePath(value: unknown): FilePath | null {
  if (typeof value !== "string" || value.length > 300 || !/\.(md|json)$/.test(value)) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.trim() !== p)) return null;
  return value as FilePath;
}

export const isNote = (path: FilePath) => path.endsWith(".md");

export type Author = { kind: "user"; email: string } | { kind: "agent"; name: string };

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
}

/**
 * "saved": the file now has the text that was sent. "merged": the write was based on an old revision
 * and was merged with what changed since, so `file.text` is new to the writer. "conflict": it couldn't
 * be merged, nothing changed, and `file` is the current file.
 */
export type WriteResult = { status: "saved" | "merged"; file: WorkspaceFile } | { status: "conflict"; file: WorkspaceFile | null };

export interface Write {
  path: FilePath;
  text: string;
  base: Revision;
  author: Author;
}

/** Notes a Preview starts with. `replace` rewrites a note that exists; otherwise only missing notes are added. */
export interface Seed {
  id: string;
  notes: Array<{ path: string; text: string; replace: boolean }>;
}

export const SEED_AUTHOR: Author = { kind: "agent", name: "Preview seed" };

const lines = (text: string) => text.split("\n");

const hasTable = (db: Db, name: string) => db.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;

/**
 * The database's shape, one step at a time. Each runs once, in order, and the number done is kept in
 * meta's "schema" row. Add steps at the end; never change one that has shipped.
 */
const MIGRATIONS: Array<(db: Db) => void> = [
  // 1. Files and their changes. The first deploy called the files table "notes".
  (db) => {
    if (hasTable(db, "notes")) db.run("ALTER TABLE notes RENAME TO files");
    db.run("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.run(
      `CREATE TABLE IF NOT EXISTS changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
        author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)`,
    );
    db.run("CREATE INDEX IF NOT EXISTS changes_by_path ON changes(path, revision)");
  },
];

export class Files {
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

  list(): FileSummary[] {
    return this.db.all<FileSummary>("SELECT path, revision FROM files ORDER BY path");
  }

  read(path: FilePath): WorkspaceFile | null {
    return this.db.all<WorkspaceFile>("SELECT path, text, revision FROM files WHERE path = ?", path)[0] ?? null;
  }

  /** The file's changes, oldest first. */
  history(path: FilePath): Change[] {
    return this.db
      .all<{ revision: number; path: FilePath; author: string; base: number; diff: string; time: number }>(
        "SELECT * FROM changes WHERE path = ? ORDER BY revision",
        path,
      )
      .map((row) => ({ ...row, author: JSON.parse(row.author), diff: JSON.parse(row.diff) }));
  }

  /**
   * Save a file's text, given the revision it was based on. If the file has changed since, the two
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
      for (const { path: raw, text, replace } of seed.notes) {
        const path = parseFilePath(raw);
        if (!path) throw new Error(`Not a file path: ${raw}`);
        const current = this.read(path);
        if (!current || replace) this.apply({ path, text, base: current?.revision ?? 0, author: SEED_AUTHOR });
      }
      this.db.run("INSERT INTO meta(key, value) VALUES ('seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seed.id);
    });
  }

  private apply({ path, text, base, author }: Write): WriteResult {
    const current = this.read(path);
    const currentText = current?.text ?? "";
    let next = text;
    let status: "saved" | "merged" = "saved";
    if (base !== (current?.revision ?? 0)) {
      const baseText = this.textAt(path, base);
      const merged = baseText === null ? null : merge(text, baseText, currentText);
      if (merged === null) return { status: "conflict", file: current };
      [next, status] = [merged, merged === text ? "saved" : "merged"];
    }
    if (current && next === currentText) return { status, file: current };
    const diff = JSON.stringify(diffPatch(lines(currentText), lines(next)));
    this.db.run(
      "INSERT INTO changes(path, author, base, diff, time) VALUES (?, ?, ?, ?, ?)",
      path, JSON.stringify(author), base, diff, this.now(),
    );
    const [{ revision }] = this.db.all<{ revision: number }>("SELECT max(revision) AS revision FROM changes");
    this.db.run(
      "INSERT INTO files(path, text, revision) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET text = excluded.text, revision = excluded.revision",
      path, next, revision,
    );
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
      text = patch(text, c.diff.map(({ buffer1, buffer2 }) => ({ buffer1: buffer2, buffer2: buffer1 })));
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
