// The query language, one parser and matcher for every list of notes: the search bar, the Feed's
// filter, saved searches, and `search` over MCP and the CLI. A query is plain text you can read and
// edit, such as `launch "beta date" -draft in:Projects/ is:pinned sort:edited`: words and phrases
// (full text), filters (`key:value`), and either negated with a leading `-`. Extensions import it as
// `common-ink/query`, so they read a query the same way.
import type { Author } from "./files.ts";

/** Whether a path matches one of some globs, as a provider keeps to search's `within` (globs.ts). */
export { inGlobs } from "./globs.ts";

/** One piece of a query: a word or "a phrase", or a filter like `is:archived`. A leading `-` negates either. */
export type Term = { kind: "words"; text: string; negated: boolean } | { kind: "filter"; key: string; value: string; negated: boolean };

export interface Query {
  terms: Term[];
}

/** What the matcher knows about a note. */
export interface NoteFacts {
  path: string;
  title: string;
  text: string;
  /** When its last change was made. */
  edited: number;
  /** Who made its last change. */
  author: Author;
  archived?: boolean;
  pinned?: boolean;
  /** Deleted, and still in Trash. */
  trashed?: boolean;
}

/** What `edited:` is measured against: now, and the time zone whose days `today` means. */
export interface MatchContext {
  now: number;
  zone: string;
}

/** A filter the language knows: what completion offers, what the docs list, and how a note is tested. */
export interface Filter {
  key: string;
  description: string;
  /** Values to offer when completing, in order. */
  values: readonly string[];
  /** Several of this filter in one query: a note must pass any of them (`type:`, `in:`, `from:`), or all of them. */
  several: "any" | "all";
  /** Why a value isn't one this filter takes, or null if it is. */
  problem(value: string): string | null;
  /** Whether a note passes, or undefined when the filter doesn't apply to notes (they never match it). */
  test(note: NoteFacts, value: string, ctx: MatchContext): boolean | undefined;
}

/**
 * Text as search compares it: accents dropped where they're optional, as on Latin, Greek, Hebrew and
 * Arabic letters (é, ά, ָ, َ), and kept where they make another letter (й, が, ा); then lower case.
 */
const fold = (s: string) => {
  // Plain ASCII, as most notes are, has no accents: folding it is lower case alone.
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
  const d = s.normalize("NFD");
  return d
    .replace(/\p{M}+/gu, (marks, at: number) => {
      if (at === 0) return marks;
      // The letter before: a pair of surrogates is one; a lone one is nothing with optional accents.
      const unit = d.charCodeAt(at - 1);
      const high = at > 1 ? d.charCodeAt(at - 2) : 0;
      const letter = unit >= 0xdc00 && unit <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? d.codePointAt(at - 2)! : unit;
      return marksOptional(letter) ? "" : marks;
    })
    .normalize("NFC")
    .toLowerCase();
};

const OPTIONAL = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Arabic}]$/u;
const optional = new Map<number, boolean>();
/** Whether accents on a letter are optional: on Latin, Greek, Hebrew and Arabic ones. Remembered for the first few thousand letters asked about. */
function marksOptional(codePoint: number): boolean {
  const known = optional.get(codePoint);
  if (known !== undefined) return known;
  const answer = OPTIONAL.test(String.fromCodePoint(codePoint));
  if (optional.size < 4096) optional.set(codePoint, answer);
  return answer;
}

/**
 * Text as the words search sees: runs of letters, digits and the marks that are part of them, folded.
 * The full-text index is given these words, already folded (search.ts), so the index and this agree in
 * every script.
 */
export function tokens(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) ?? [];
}

/**
 * Whether text holds a word or phrase: its words, next to each other and in order, the last one as the
 * start of a word, so `laun` finds "launch" and "beta da" finds "beta date". No words hold anywhere,
 * so a term of only punctuation, like `+`, changes nothing.
 */
export function holds(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length) return true;
  const last = needle.length - 1;
  outer: for (let i = 0; i + last < haystack.length; i++) {
    for (let j = 0; j < last; j++) if (haystack[i + j] !== needle[j]) continue outer;
    if (haystack[i + last].startsWith(needle[last])) return true;
  }
  return false;
}

/** A note's title: its first `# ` heading, without closing #s, or its file name. Linear in the text's length. */
export function titleOf(path: string, text: string): string {
  for (const line of text.split("\n")) {
    if (!/^# /.test(line)) continue;
    let end = line.length;
    while (end > 1 && (line[end - 1] === " " || line[end - 1] === "\t" || line[end - 1] === "\r")) end--;
    let hashes = end;
    while (hashes > 1 && line[hashes - 1] === "#") hashes--;
    // Closing #s count only after a space ("# C#" keeps its #).
    if (hashes < end && (line[hashes - 1] === " " || line[hashes - 1] === "\t")) end = hashes;
    const heading = line.slice(1, end).trim();
    if (heading) return heading;
  }
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

const DAY = 86_400_000;
const UNITS: Record<string, number> = { d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY };

const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** The day a time falls on in a zone, as 2026-10-05. */
function dayIn(time: number, zone: string): string {
  let f = dayFormats.get(zone);
  if (!f) dayFormats.set(zone, (f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(time);
}

const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * DAY).toISOString().slice(0, 10);

type Edited = (edited: number, ctx: MatchContext) => boolean;

/**
 * `edited:` values: `today`, `yesterday` or a day (2026-10-05), alone or after <, <=, > or >=; or an age,
 * `<7d` (in the last 7 days) or `>3m` (more than 3 months ago), in d, w, m (30 days) or y.
 */
function parseEdited(value: string): Edited | null {
  const age = /^([<>])=?(\d{1,4})([dwmy])$/.exec(value);
  if (age) {
    const span = Number(age[2]) * UNITS[age[3]];
    return age[1] === "<" ? (t, c) => t > c.now - span : (t, c) => t < c.now - span;
  }
  const at = /^(<=|>=|<|>)?(today|yesterday|\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!at || (/\d/.test(at[2]) && Number.isNaN(Date.parse(`${at[2]}T00:00:00Z`)))) return null;
  const [, op = "", when] = at;
  const target = (c: MatchContext) => (when === "today" ? dayIn(c.now, c.zone) : when === "yesterday" ? shiftDay(dayIn(c.now, c.zone), -1) : when);
  const compare: Record<string, (a: string, b: string) => boolean> = { "": (a, b) => a === b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b };
  return (t, c) => compare[op](dayIn(t, c.zone), target(c));
}

const oneOf = (values: readonly string[], what: string) => (v: string) => (values.includes(v.toLowerCase()) ? null : `${what} is one of ${values.join(", ")}`);

const IS = ["archived", "pinned", "trashed", "open", "done"] as const;
const TYPES = ["note", "task", "event", "contact", "command", "setting"] as const;
const HAS = ["task", "embed", "event"] as const;
const SORTS = ["relevance", "edited", "title"] as const;

/** What `has:` looks for in a note's text. */
const HAS_TESTS: Record<(typeof HAS)[number], RegExp> = {
  task: /^[ \t]*[-*+] \[[ xX]\]/m,
  embed: /^:{2,3}[a-zA-Z][\w-]*/m,
  event: /\]\(event:/,
};

function fromTest(author: Author, value: string): boolean {
  const v = value.toLowerCase();
  if (v === "me") return author.kind === "user";
  if (v === "agent" || v === "extension" || v === "sync") return author.kind === v;
  const name = author.kind === "user" ? author.email : author.kind === "agent" ? author.name : author.kind === "extension" ? author.id : author.kind === "sync" ? author.source : "retention";
  return name.toLowerCase() === v;
}

/** The filters every note understands. Extensions add their own (`due:`, `on:`), which notes never match. */
export const FILTERS: readonly Filter[] = [
  {
    key: "is",
    description: "A state: archived, pinned, or in Trash (tasks: open, done)",
    values: IS,
    several: "all",
    problem: oneOf(IS, "is:"),
    test: (note, v) => {
      const state = v.toLowerCase();
      if (state === "archived" || state === "pinned" || state === "trashed") return note[state] === true;
      return state === "open" || state === "done" ? undefined : false;
    },
  },
  {
    key: "in",
    description: "In a folder, like in:Projects/",
    values: [],
    several: "any",
    problem: (v) => (v.replace(/\/+$/, "") ? null : "in: names a folder, like in:Projects/"),
    test: (note, v) => note.path.toLowerCase().startsWith(`${v.replace(/\/+$/, "").toLowerCase()}/`),
  },
  {
    key: "from",
    description: "Who made the last change: me, agent, sync, extension, or a name",
    values: ["me", "agent", "sync", "extension"],
    several: "any",
    problem: (v) => (v ? null : "from: names who made the last change: me, agent, or a name"),
    test: (note, v) => fromTest(note.author, v),
  },
  {
    key: "type",
    description: "One kind of result: note, task, event, contact, command or setting",
    values: TYPES,
    several: "any",
    problem: oneOf(TYPES, "type:"),
    test: (_note, v) => v.toLowerCase() === "note",
  },
  {
    key: "edited",
    description: "When it last changed: today, yesterday, <7d, >3m, <=2026-10-01",
    values: ["today", "yesterday", "<7d", "<30d", ">90d"],
    several: "all",
    problem: (v) => (parseEdited(v) ? null : "edited: is today, yesterday, a day like 2026-10-05 (after <, <=, > or >=), or an age like <7d or >3m"),
    test: (note, v, ctx) => parseEdited(v)?.(note.edited, ctx) ?? false,
  },
  {
    key: "has",
    description: "What a note holds: task, embed or event",
    values: HAS,
    several: "all",
    problem: oneOf(HAS, "has:"),
    test: (note, v) => HAS_TESTS[v.toLowerCase() as (typeof HAS)[number]]?.test(note.text) ?? false,
  },
  {
    key: "sort",
    description: "The order: relevance, edited (newest first) or title",
    values: SORTS,
    several: "all",
    problem: oneOf(SORTS, "sort:"),
    test: () => true,
  },
];

const BY_KEY = new Map(FILTERS.map((f) => [f.key, f]));

/** A filter's key as written: letters, perhaps with dashes, before the colon. */
const KEY = /^[a-zA-Z][a-zA-Z-]*$/;

/**
 * Read a query. `extra` are filter keys extensions add (`due`, `on`); any other `word:` is a word.
 * Never fails: anything it can't read as a filter is a word, and a quote left open runs to the end.
 */
export function parse(text: string, extra: readonly string[] = []): Query {
  const keys = new Set([...BY_KEY.keys(), ...extra.map((k) => k.toLowerCase())]);
  const terms: Term[] = [];
  let i = 0;
  const quoted = () => {
    const end = text.indexOf('"', i + 1);
    const out = text.slice(i + 1, end < 0 ? text.length : end);
    i = end < 0 ? text.length : end + 1;
    return out;
  };
  const bare = () => {
    const start = i;
    while (i < text.length && !/\s/.test(text[i]) && text[i] !== '"') i++;
    return text.slice(start, i);
  };
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const negated = text[i] === "-" && i + 1 < text.length && !/\s/.test(text[i + 1]);
    if (negated) i++;
    if (text[i] === '"') {
      terms.push({ kind: "words", text: quoted(), negated });
      continue;
    }
    const word = bare();
    const colon = word.indexOf(":");
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
    if (colon > 0 && KEY.test(key) && keys.has(key)) {
      const value = colon === word.length - 1 && text[i] === '"' ? quoted() : word.slice(colon + 1);
      terms.push({ kind: "filter", key, value, negated });
    } else {
      terms.push({ kind: "words", text: word, negated });
    }
  }
  return { terms };
}

/** A query as text, the way parse reads it back with the same `extra` keys. Words and values with spaces are quoted. */
export function format(query: Query, extra: readonly string[] = []): string {
  const keys = new Set([...BY_KEY.keys(), ...extra.map((k) => k.toLowerCase())]);
  const looksLikeFilter = (s: string) => {
    const key = /^([a-zA-Z][a-zA-Z-]*):/.exec(s)?.[1];
    return key !== undefined && keys.has(key.toLowerCase());
  };
  const needsQuotes = (s: string) => s === "" || /\s/.test(s) || s.startsWith("-") || looksLikeFilter(s);
  return query.terms
    .map((t) => {
      const sign = t.negated ? "-" : "";
      if (t.kind === "words") return `${sign}${needsQuotes(t.text) ? `"${t.text}"` : t.text}`;
      return `${sign}${t.key}:${/\s/.test(t.value) ? `"${t.value}"` : t.value}`;
    })
    .join(" ");
}

/** What's wrong with a query, in sentences: values a filter doesn't take, and filters that can't be negated. */
export function problems(query: Query): string[] {
  return query.terms.flatMap((t) => {
    if (t.kind !== "filter" || !t.value) return [];
    if (t.key === "sort" && t.negated) return ["sort: can't be negated"];
    const p = BY_KEY.get(t.key)?.problem(t.value);
    return p ? [p] : [];
  });
}

/** The order a query asks for: its last `sort:`, or relevance when it has words to rank by, else edited. */
export function sortOf(query: Query): (typeof SORTS)[number] {
  const asked = query.terms.findLast((t) => t.kind === "filter" && t.key === "sort" && !t.negated && SORTS.includes(t.value.toLowerCase() as never));
  if (asked?.kind === "filter") return asked.value.toLowerCase() as (typeof SORTS)[number];
  return query.terms.some((t) => t.kind === "words" && !t.negated && tokens(t.text).length) ? "relevance" : "edited";
}

/** Whether a query asks for a state with a positive `is:`, as `is:archived`. */
export const asksFor = (query: Query, state: string) => query.terms.some((t) => t.kind === "filter" && t.key === "is" && !t.negated && t.value.toLowerCase() === state);

/** Whether a word or phrase term holds in some text: its words, in order, the last as a prefix. */
export function matchesWords(query: Query, text: string): boolean {
  const hay = tokens(text);
  return query.terms.every((t) => t.kind !== "words" || !tokens(t.text).length || holds(hay, tokens(t.text)) !== t.negated);
}

/**
 * Whether a note matches a query: every word and phrase, and every filter (filters with the same key
 * that take any of several pass on one). A filter notes don't have (`due:`, `is:open`) never matches,
 * negated or not. Notes in Trash match only a query that asks for `is:trashed`. A filter still being
 * typed (`is:`) is left out.
 */
export function matches(query: Query, note: NoteFacts, ctx: MatchContext): boolean {
  if (note.trashed && !asksFor(query, "trashed")) return false;
  if (!matchesWords(query, `${note.title}\n${note.text}`)) return false;
  const anyOf = new Map<string, boolean>();
  for (const t of query.terms) {
    // A filter still being typed, and the order, say nothing about which notes match.
    if (t.kind !== "filter" || !t.value || t.key === "sort") continue;
    const filter = BY_KEY.get(t.key);
    const passed = filter?.test(note, t.value, ctx);
    if (passed === undefined) return false;
    if (filter!.several === "any" && !t.negated) anyOf.set(t.key, anyOf.get(t.key) === true || passed);
    else if (passed === t.negated) return false;
  }
  return [...anyOf.values()].every(Boolean);
}

/** How many of the query's words are in a note's title: notes that match by title come first. */
function titleScore(query: Query, note: NoteFacts): number {
  const title = tokens(note.title);
  return query.terms.filter((t) => t.kind === "words" && !t.negated && tokens(t.text).length && holds(title, tokens(t.text))).length;
}

/** The notes that match, in the query's order (`ordered`). */
export function select(query: Query, notes: readonly NoteFacts[], ctx: MatchContext): NoteFacts[] {
  return ordered(query, notes.filter((n) => matches(query, n, ctx)));
}

/**
 * Notes in a query's order. Archived notes come last unless the query asks for them (decision 15);
 * within that, relevance puts title matches first, then the newest. It needs only what's known of each
 * note without its text, so a search can order notes before it reads any.
 */
export function ordered(query: Query, notes: NoteFacts[]): NoteFacts[] {
  const sort = sortOf(query);
  const score = new Map(sort === "relevance" ? notes.map((n) => [n, titleScore(query, n)]) : []);
  const newest = (a: NoteFacts, b: NoteFacts) => b.edited - a.edited || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const order: Record<typeof sort, (a: NoteFacts, b: NoteFacts) => number> = {
    relevance: (a, b) => score.get(b)! - score.get(a)! || newest(a, b),
    edited: newest,
    title: (a, b) => a.title.localeCompare(b.title) || newest(a, b),
  };
  return notes.sort((a, b) => Number(a.archived === true) - Number(b.archived === true) || order[sort](a, b));
}
