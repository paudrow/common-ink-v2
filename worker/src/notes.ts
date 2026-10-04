// A workspace's notes and their history, on any SQLite: the Durable Object's in production,
// node:sqlite in tests. Every write is recorded as a change with its author, and a note's text is
// what its changes add up to (ADR 0002). The notes table keeps the latest text so reads are cheap.
import { diff3Merge, diffPatch, patch, type IPatchRes } from "node-diff3";

export type SqlValue = string | number | null;

export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  tx<T>(fn: () => T): T;
}

/** A note's path in its workspace, like "Projects/Plan.md". Only parseNotePath makes one. */
export type NotePath = string & { readonly __brand: "NotePath" };

export function parseNotePath(value: unknown): NotePath | null {
  if (typeof value !== "string" || value.length > 300 || !value.endsWith(".md")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.trim() !== p)) return null;
  return value as NotePath;
}

export type Author = { kind: "user"; email: string } | { kind: "agent"; name: string };

/** Revisions are change numbers, counted across the workspace. 0 is "before the note existed". */
export type Revision = number;

export interface Note {
  path: NotePath;
  text: string;
  revision: Revision;
}

export type NoteSummary = Omit<Note, "text">;

/** Line by line, from the note's previous text to its new one. */
export type Diff = IPatchRes<string>[];

export interface Change {
  revision: Revision;
  path: NotePath;
  author: Author;
  /** The revision the author was looking at. Older than the note's previous revision when the write was merged. */
  base: Revision;
  diff: Diff;
  time: number;
}

/**
 * "saved": the note now has the text that was sent. "merged": the write was based on an old revision
 * and was merged with what changed since, so `note.text` is new to the writer. "conflict": it couldn't
 * be merged, nothing changed, and `note` is the current note.
 */
export type WriteResult = { status: "saved" | "merged"; note: Note } | { status: "conflict"; note: Note | null };

export interface Write {
  path: NotePath;
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

export class Notes {
  constructor(
    private db: Db,
    private now: () => number = Date.now,
  ) {
    db.run("CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.run(
      `CREATE TABLE IF NOT EXISTS changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
        author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL)`,
    );
    db.run("CREATE INDEX IF NOT EXISTS changes_by_path ON changes(path, revision)");
    db.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  list(): NoteSummary[] {
    return this.db.all<NoteSummary>("SELECT path, revision FROM notes ORDER BY path");
  }

  read(path: NotePath): Note | null {
    return this.db.all<Note>("SELECT path, text, revision FROM notes WHERE path = ?", path)[0] ?? null;
  }

  /** The note's changes, oldest first. */
  history(path: NotePath): Change[] {
    return this.db
      .all<{ revision: number; path: NotePath; author: string; base: number; diff: string; time: number }>(
        "SELECT * FROM changes WHERE path = ? ORDER BY revision",
        path,
      )
      .map((row) => ({ ...row, author: JSON.parse(row.author), diff: JSON.parse(row.diff) }));
  }

  /**
   * Save a note's text, given the revision it was based on. If the note has changed since, the two
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
        const path = parseNotePath(raw);
        if (!path) throw new Error(`Not a note path: ${raw}`);
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
      if (merged === null) return { status: "conflict", note: current };
      [next, status] = [merged, merged === text ? "saved" : "merged"];
    }
    if (current && next === currentText) return { status, note: current };
    const diff = JSON.stringify(diffPatch(lines(currentText), lines(next)));
    this.db.run(
      "INSERT INTO changes(path, author, base, diff, time) VALUES (?, ?, ?, ?, ?)",
      path, JSON.stringify(author), base, diff, this.now(),
    );
    const [{ revision }] = this.db.all<{ revision: number }>("SELECT max(revision) AS revision FROM changes");
    this.db.run(
      "INSERT INTO notes(path, text, revision) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET text = excluded.text, revision = excluded.revision",
      path, next, revision,
    );
    return { status, note: { path, text: next, revision } };
  }

  /** The note's text at one of its revisions, by undoing its later changes. Null if it never had that revision. */
  private textAt(path: NotePath, revision: Revision): string | null {
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
function merge(mine: string, base: string, theirs: string): string | null {
  const regions = diff3Merge(lines(mine), lines(base), lines(theirs), { excludeFalseConflicts: true });
  if (regions.some((r) => r.conflict)) return null;
  return regions.flatMap((r) => r.ok ?? []).join("\n");
}
