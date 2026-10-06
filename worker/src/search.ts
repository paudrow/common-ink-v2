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
  /** Deleted, and in Trash: only with is:trashed. */
  trashed?: true;
  line?: { number: number; text: string };
}

export interface SearchResults {
  results: NoteResult[];
  /** How many matched, of which `results` are the first `limit`. */
  total: number;
  /** More notes had the words than one search reads: `total` counts those it read. */
  more?: true;
}

export interface SearchOptions {
  ctx: MatchContext;
  limit: number;
  /** The paths in the archive, which come last. */
  archived?: ReadonlySet<string>;
}

const isNotePath = (path: string) => path.endsWith(".md");

/**
 * The words a note is found by: its title's and its text's, as the matcher reads them (query.ts's
 * `tokens`), already folded. FTS5 is given these, not the raw text, so the index and the matcher agree
 * in every script; its tokenizer only splits them where the matcher did.
 */
const indexed = (path: string, text: string) => tokens(`${titleOf(path, text)}\n${text}`).join(" ");

/** The index's table: contentless, so it keeps no second copy of the notes, and its rows can still be deleted. */
const FTS = `CREATE VIRTUAL TABLE search USING fts5(words, content = '', contentless_delete = 1, tokenize = "unicode61 remove_diacritics 0 categories 'L* N* Co M*'")`;

/** At most this many notes' text is read for one search. A search that matches more says so (`more`). */
export const MAX_CANDIDATES = 1000;

/**
 * FTS5's query for the notes that may match: every word and phrase the query wants, the last word of
 * each a prefix, as `holds` matches them. Null when it wants none, so every note may match.
 */
function ftsQuery(query: Query): string | null {
  const wanted = query.terms.flatMap((t) => (t.kind === "words" && !t.negated && tokens(t.text).length ? [`"${tokens(t.text).join(" ")}"*`] : []));
  return wanted.length ? wanted.join(" AND ") : null;
}

/** Whether matching needs the notes' text: words to find or leave out, or has:. Filters on state, folder, author and age don't. */
const needsText = (query: Query) => query.terms.some((t) => (t.kind === "words" && tokens(t.text).length > 0) || (t.kind === "filter" && t.key === "has" && t.value !== ""));

export class SearchIndex {
  constructor(private db: Db) {
    // An index of an older shape (a copy of the text, the raw text's words) is made again from the files.
    const [table] = db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'search'");
    const current = !!table?.sql.includes("contentless_delete");
    if (table && !current) {
      db.run("DROP TABLE search");
      db.run("DROP TABLE IF EXISTS search_docs");
      db.run("DROP TABLE IF EXISTS search_mark");
    }
    if (!current) db.run(FTS);
    db.run("CREATE TABLE IF NOT EXISTS search_docs(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS search_mark(revision INTEGER NOT NULL)");
  }

  /** A file was written (text) or deleted (null) at a revision: keep its words, if it's a note, and how far the index has got. */
  observe(path: string, text: string | null, revision: number): void {
    this.mark(revision);
    if (!isNotePath(path)) return;
    const [doc] = this.db.all<{ id: number }>("SELECT id FROM search_docs WHERE path = ?", path);
    if (doc) this.db.run("DELETE FROM search WHERE rowid = ?", doc.id);
    if (text === null) {
      this.db.run("DELETE FROM search_docs WHERE path = ?", path);
      return;
    }
    const title = titleOf(path, text);
    const id = doc?.id ?? this.db.all<{ id: number }>("INSERT INTO search_docs(path, title) VALUES (?, ?) RETURNING id", path, title)[0].id;
    if (doc) this.db.run("UPDATE search_docs SET title = ? WHERE id = ?", title, id);
    this.db.run("INSERT INTO search(rowid, words) VALUES (?, ?)", id, indexed(path, text));
  }

  private mark(revision: number) {
    this.db.run("DELETE FROM search_mark");
    this.db.run("INSERT INTO search_mark(revision) VALUES (?)", revision);
  }

  /** Whether the index has seen every change up to `revision`: one from before search, or of an older shape, hasn't. */
  complete(revision: number): boolean {
    const [row] = this.db.all<{ revision: number }>("SELECT revision FROM search_mark");
    return row ? row.revision === revision : revision === 0;
  }

  /** Make the index again from the files, as of `revision`, all of it or none. */
  rebuild(files: Iterable<{ path: string; text: string }>, revision: number): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM search");
      this.db.run("DELETE FROM search_docs");
      for (const f of files) this.observe(f.path, f.text, revision);
      this.mark(revision);
    });
  }

  /**
   * The notes a query finds, in its order: archived ones last. A query of filters alone is answered from
   * what's known of each note (path, title, last change, archive) without reading any text; one with
   * words reads only the notes the index finds, at most MAX_CANDIDATES of them.
   */
  search(query: Query, { ctx, limit, archived = new Set() }: SearchOptions): SearchResults {
    const fts = ftsQuery(query);
    const text = needsText(query);
    const rows = this.db.all<{ path: string; title: string; text: string | null; author: string; time: number }>(
      `SELECT d.path, d.title, ${text ? "f.text" : "NULL AS text"}, c.author, c.time FROM search_docs d JOIN files f ON f.path = d.path JOIN changes c ON c.revision = f.revision
        ${fts ? "WHERE d.id IN (SELECT rowid FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?)" : text ? "ORDER BY f.revision DESC LIMIT ?" : ""}`,
      ...(fts ? [fts, MAX_CANDIDATES + 1] : text ? [MAX_CANDIDATES + 1] : []),
    );
    const more = text && rows.length > MAX_CANDIDATES;
    const notes: NoteFacts[] = (more ? rows.slice(0, MAX_CANDIDATES) : rows).map((r) => ({
      path: r.path,
      title: r.title,
      text: r.text ?? "",
      edited: r.time,
      author: JSON.parse(r.author) as Author,
      ...(archived.has(r.path) ? { archived: true } : {}),
    }));
    return { ...present(query, notes, { ctx, limit }), ...(more ? { more: true as const } : {}) };
  }
}

/** The notes that match, in the query's order, the first `limit` of them, each with the first line that has a word searched for. */
export function present(query: Query, notes: readonly NoteFacts[], { ctx, limit }: Pick<SearchOptions, "ctx" | "limit">): SearchResults {
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
        ...(n.trashed ? { trashed: true as const } : {}),
        ...(at >= 0 ? { line: { number: at + 1, text: lines[at].trim().slice(0, 200) } } : {}),
      };
    }),
  };
}
