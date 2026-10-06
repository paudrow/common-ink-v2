// Full-text search over a workspace's notes: an SQLite FTS5 index on the workspace's database, kept in
// step with the files in the same transaction as each write (Files' `observe`), as the records index
// is. The index only narrows the notes to those that have the query's words; the query language
// (query.ts) decides what matches and in what order, so the index and the matcher can't disagree.
import type { Author, Db } from "./files.ts";
import { holds, select, titleOf, tokens, type MatchContext, type NoteFacts, type Query } from "./query.ts";

/** A note search found: enough to list it, and the first line that has a word searched for. */
export interface NoteResult {
  path: string;
  title: string;
  edited: number;
  author: Author;
  archived?: true;
  line?: { number: number; text: string };
}

export interface SearchResults {
  results: NoteResult[];
  /** How many matched, of which `results` are the first `limit`. */
  total: number;
}

export interface SearchOptions {
  ctx: MatchContext;
  limit: number;
  /** The paths in the archive, which come last. */
  archived?: ReadonlySet<string>;
}

const isNotePath = (path: string) => path.endsWith(".md");

/** The words a note is found by: its title and its text, as the matcher reads them. */
const indexed = (path: string, text: string) => `${titleOf(path, text)}\n${text}`;

/**
 * FTS5's query for the notes that may match: every word and phrase the query wants, the last word of
 * each a prefix, as `holds` matches them. Null when it wants none, so every note may match.
 */
function ftsQuery(query: Query): string | null {
  const wanted = query.terms.flatMap((t) => (t.kind === "words" && !t.negated && tokens(t.text).length ? [`"${tokens(t.text).join(" ")}"*`] : []));
  return wanted.length ? wanted.join(" AND ") : null;
}

export class SearchIndex {
  constructor(private db: Db) {
    db.run("CREATE TABLE IF NOT EXISTS search_docs(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE)");
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(words, tokenize = 'unicode61 remove_diacritics 2')");
  }

  /** A file was written (text) or deleted (null): keep its words, if it's a note. */
  observe(path: string, text: string | null): void {
    if (!isNotePath(path)) return;
    const [doc] = this.db.all<{ id: number }>("SELECT id FROM search_docs WHERE path = ?", path);
    if (doc) this.db.run("DELETE FROM search WHERE rowid = ?", doc.id);
    if (text === null) {
      this.db.run("DELETE FROM search_docs WHERE path = ?", path);
      return;
    }
    const id = doc?.id ?? this.db.all<{ id: number }>("INSERT INTO search_docs(path) VALUES (?) RETURNING id", path)[0].id;
    this.db.run("INSERT INTO search(rowid, words) VALUES (?, ?)", id, indexed(path, text));
  }

  /** Whether the index has every note: a workspace from before search, or one that stopped partway, doesn't. */
  complete(): boolean {
    const [row] = this.db.all<{ ok: number }>("SELECT (SELECT count(*) FROM search_docs) = (SELECT count(*) FROM files WHERE path LIKE '%.md') AS ok");
    return row?.ok === 1;
  }

  /** Make the index again from the files, all of it or none. */
  rebuild(files: Iterable<{ path: string; text: string }>): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM search");
      this.db.run("DELETE FROM search_docs");
      for (const f of files) this.observe(f.path, f.text);
    });
  }

  /** The notes a query finds, in its order: archived ones last. */
  search(query: Query, { ctx, limit, archived = new Set() }: SearchOptions): SearchResults {
    const fts = ftsQuery(query);
    const rows = this.db.all<{ path: string; text: string; author: string; time: number }>(
      `SELECT f.path, f.text, c.author, c.time FROM files f JOIN changes c ON c.revision = f.revision
        WHERE f.path LIKE '%.md' ${fts ? "AND f.path IN (SELECT d.path FROM search_docs d WHERE d.id IN (SELECT rowid FROM search WHERE search MATCH ?))" : ""}`,
      ...(fts ? [fts] : []),
    );
    const notes: NoteFacts[] = rows.map((r) => ({
      path: r.path,
      title: titleOf(r.path, r.text),
      text: r.text,
      edited: r.time,
      author: JSON.parse(r.author) as Author,
      ...(archived.has(r.path) ? { archived: true } : {}),
    }));
    const found = select(query, notes, ctx);
    const wanted = query.terms.flatMap((t) => (t.kind === "words" && !t.negated && tokens(t.text).length ? [tokens(t.text)] : []));
    return {
      total: found.length,
      results: found.slice(0, limit).map((n) => {
        const lines = n.text.split("\n");
        const at = wanted.length ? lines.findIndex((l) => wanted.some((w) => holds(tokens(l), w))) : -1;
        return {
          path: n.path,
          title: n.title,
          edited: n.edited,
          author: n.author,
          ...(n.archived ? { archived: true as const } : {}),
          ...(at >= 0 ? { line: { number: at + 1, text: lines[at].trim().slice(0, 200) } } : {}),
        };
      }),
    };
  }
}
