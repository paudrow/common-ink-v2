// Full-text search over a workspace's notes: an SQLite FTS5 index on the workspace's database, kept in
// step with the files in the same transaction as each write (Files' `observe`), as the records index
// is. The index only narrows the notes to those that have the query's words; the query language
// (query.ts) decides what matches and in what order, so the index and the matcher can't disagree.
import type { Author, Db } from "./files.ts";
import { inGlobs } from "./globs.ts";
import { holds, matches, ordered, select, titleOf, tokens, type MatchContext, type NoteFacts, type Query, type Term } from "./query.ts";

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
  /**
   * Only notes whose paths match one of these globs (globs.ts) are searched: ranked, limited and
   * counted, as if no other note were there. What an extension may read, for its searches.
   */
  within?: readonly string[];
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

/** At most this many notes' text is read for one search. A search that would read more says so (`more`). */
export const MAX_CANDIDATES = 1000;

/** Notes' text is read this many at a time, so a search holds little of it at once. */
const CHUNK = 100;

/**
 * FTS5's query for the notes that may match: every word and phrase the query wants, the last word of
 * each a prefix, as `holds` matches them. Null when it wants none, so every note may match.
 */
function ftsQuery(query: Query): string | null {
  const wanted = query.terms.flatMap((t) => (t.kind === "words" && !t.negated && tokens(t.text).length ? [`"${tokens(t.text).join(" ")}"*`] : []));
  return wanted.length ? wanted.join(" AND ") : null;
}

/** Whether a term needs a note's text to test: words to find or leave out, or has:. Filters on state, folder, author and age don't. */
const needsText = (t: Term) => (t.kind === "words" && tokens(t.text).length > 0) || (t.kind === "filter" && t.key === "has" && t.value !== "");

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
    db.run("CREATE TABLE IF NOT EXISTS search_merge(since INTEGER NOT NULL)");
  }

  /**
   * A file was written (text) or deleted (null) at a revision: keep its words, if it's a note, and how
   * far the index has got. After a purge, the index is due a merge (`mergePurged`).
   */
  observe(path: string, text: string | null, revision: number, purged = false): void {
    this.mark(revision);
    if (purged && !this.mergeDue()) this.db.run("INSERT INTO search_merge(since) VALUES (?)", revision);
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

  /** Whether a purge since the index was last merged left a deleted note's words in its blocks. */
  mergeDue(): boolean {
    return this.db.all("SELECT 1 FROM search_merge").length > 0;
  }

  /**
   * After purges, merge the index's blocks into one, so no purged note's words stay in them: a
   * contentless index keeps a deleted row's words until its blocks are merged, and secure-delete can't
   * find them without the text. It rewrites the whole index (2 s at 30,000 notes), so the workspace's
   * alarm does it soon after Delete forever, once for any number of them, and not while you wait.
   */
  mergePurged(): void {
    if (!this.mergeDue()) return;
    this.db.tx(() => {
      this.db.run("INSERT INTO search(search) VALUES ('optimize')");
      this.db.run("DELETE FROM search_merge");
    });
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
   * The notes a query finds, in its order: archived ones last. What's known of each note without its
   * text (path, title, last change, archive) is enough to order them all and test every filter but
   * words and has:. A query of only those is answered from it. Otherwise text is read for the notes
   * that pass, in the query's order, until MAX_CANDIDATES have been read: so the first results are the
   * right ones however many notes there are, `more` says some were never read, and `total` counts only
   * those that were.
   */
  search(query: Query, { ctx, limit, archived = new Set(), within }: SearchOptions): SearchResults {
    const fts = ftsQuery(query);
    const inside = within ? inGlobs(within) : () => true;
    const authors = new Map<string, Author>();
    const author = (key: string) => authors.get(key) ?? authors.set(key, JSON.parse(key) as Author).get(key)!;
    const notes: NoteFacts[] = this.db
      .all<{ path: string; title: string; author: string; time: number }>(
        `SELECT d.path, d.title, c.author, c.time FROM search_docs d JOIN files f ON f.path = d.path JOIN changes c ON c.revision = f.revision${fts ? " WHERE d.id IN (SELECT rowid FROM search WHERE search MATCH ?)" : ""}`,
        ...(fts ? [fts] : []),
      )
      .flatMap((r) => (inside(r.path) ? [{ path: r.path, title: r.title, text: "", edited: r.time, author: author(r.author), ...(archived.has(r.path) ? { archived: true } : {}) }] : []));
    if (!query.terms.some(needsText)) return present(query, notes, { ctx, limit });
    const known: Query = { terms: query.terms.filter((t) => !needsText(t)) };
    const candidates = ordered(query, notes.filter((n) => matches(known, n, ctx)));
    const read = candidates.slice(0, MAX_CANDIDATES);
    const found: NoteFacts[] = [];
    let total = 0;
    for (let i = 0; i < read.length; i += CHUNK) {
      const chunk = read.slice(i, i + CHUNK);
      const texts = new Map(this.db.all<{ path: string; text: string }>(`SELECT path, text FROM files WHERE path IN (${chunk.map(() => "?").join(", ")})`, ...chunk.map((n) => n.path)).map((r) => [r.path, r.text]));
      for (const n of chunk) {
        const note = { ...n, text: texts.get(n.path) ?? "" };
        if (!matches(query, note, ctx)) continue;
        total++;
        if (found.length < limit) found.push(note);
      }
    }
    return { ...present(query, found, { ctx, limit }), total, ...(candidates.length > MAX_CANDIDATES ? { more: true as const } : {}) };
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
