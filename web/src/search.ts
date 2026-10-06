// Search across kinds of result: notes (the workspace's `search` operation) and whatever extensions
// answer for (`contributes.search`: tasks, events). One query, in the query language (docs/queries.md),
// goes to each kind; `type:` picks kinds. The command bar draws it, with chips and Tab completion.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import { FILTERS, format, parse, type Query, type Term } from "../../worker/src/query.ts";

/** One thing search found, as a row: what it is, a line about it, and a few words at its end. */
export interface SearchResult {
  title: string;
  /** The file it is or is in, when it has one. */
  path?: string;
  detail?: string;
  aside?: string;
  /** Shown quieter, after the rest: archived. */
  dim?: boolean;
  run(): unknown;
}

/** Answers a query for one kind of result. Filters it doesn't have should find nothing (docs/queries.md). */
export interface SearchProvider {
  search(query: Query, limit: number): SearchResult[] | Promise<SearchResult[]>;
}

export interface SearchSection {
  type: string;
  title: string;
  results: SearchResult[];
}

/** A filter search can complete: its key, what it means, and the values it offers. */
export interface FilterInfo {
  key: string;
  description: string;
  values: readonly string[];
}

/** What a chip writes into the query, so the query stays the whole story (study, section 6.3). */
export const CHIPS: ReadonlyArray<{ label: string; filter: string }> = [
  { label: "Archived", filter: "is:archived" },
  { label: "Agents", filter: "from:agent" },
  { label: "Mine", filter: "from:me" },
  { label: "This week", filter: "edited:<7d" },
  { label: "Events", filter: "type:event" },
  { label: "Tasks", filter: "type:task" },
];

const sameFilter = (t: Term, f: Term) => t.kind === "filter" && f.kind === "filter" && !t.negated && t.key === f.key && t.value.toLowerCase() === f.value.toLowerCase();

/** Whether a query has a filter, as a chip writes it. */
export function hasFilter(text: string, filter: string, extra: readonly string[] = []): boolean {
  const [want] = parse(filter, extra).terms;
  return parse(text, extra).terms.some((t) => sameFilter(t, want));
}

/** A chip's tap: the query with its filter added at the end, or taken out if it's there, then a space to type on. */
export function toggleFilter(text: string, filter: string, extra: readonly string[] = []): string {
  const [want] = parse(filter, extra).terms;
  const terms = parse(text, extra).terms;
  const kept = terms.filter((t) => !sameFilter(t, want));
  const next = format({ terms: kept.length === terms.length ? [...terms, want] : kept }, extra);
  return next ? `${next} ` : "";
}

/**
 * Tab in the search field: the word before the caret completed as a filter's key (`ar` → nothing, `is` →
 * `is:`) or value (`is:ar` → `is:archived`). On a value that's complete, Tab moves on to the next one.
 * Null when there's nothing to complete.
 */
export function complete(text: string, caret: number, filters: readonly FilterInfo[]): { text: string; caret: number } | null {
  const start = text.slice(0, caret).search(/\S*$/);
  const word = text.slice(start, caret);
  const sign = word.startsWith("-") ? "-" : "";
  const bare = word.slice(sign.length);
  const colon = bare.indexOf(":");
  let done: string | null = null;
  if (colon < 0) {
    const key = filters.find((f) => bare && f.key.startsWith(bare.toLowerCase()));
    if (key) done = `${key.key}:`;
  } else {
    const filter = filters.find((f) => f.key === bare.slice(0, colon).toLowerCase());
    const typed = bare.slice(colon + 1).toLowerCase();
    const values = filter?.values ?? [];
    const exact = values.findIndex((v) => v.toLowerCase() === typed);
    const value = exact >= 0 ? values[(exact + 1) % values.length] : values.find((v) => v.toLowerCase().startsWith(typed));
    if (filter && value !== undefined && value.toLowerCase() !== typed) done = `${filter.key}:${/\s/.test(value) ? `"${value}"` : value}`;
  }
  if (done === null) return null;
  const replaced = `${sign}${done}`;
  return { text: text.slice(0, start) + replaced + text.slice(caret), caret: start + replaced.length };
}

export class Search {
  private providers = new Map<string, SearchProvider>();

  constructor(
    private deps: {
      /** The manifests of the extensions that are on, for the kinds and filters they add. */
      manifests(): readonly ExtensionManifest[];
      /** Notes, from the workspace. */
      notes: SearchProvider;
      /** Values for filters that depend on the workspace, like its folders for `in:`. */
      values?(key: string): readonly string[];
    },
  ) {}

  provide(type: string, provider: SearchProvider): void {
    this.providers.set(type, provider);
  }

  /** The kinds of result, in the order their sections show: notes, then each extension's, in manifest order. */
  types(): Array<{ type: string; title: string }> {
    return [{ type: "note", title: "Notes" }, ...this.deps.manifests().flatMap((m) => m.contributes.search.types)];
  }

  /** Every filter: the query language's, then extensions'. */
  filters(): FilterInfo[] {
    const extra = this.deps.manifests().flatMap((m) => m.contributes.search.filters.map((f) => ({ key: f.filter, description: f.description, values: f.values })));
    const values = (key: string, own: readonly string[]) => [...own, ...(this.deps.values?.(key) ?? [])];
    return [...FILTERS.map((f) => ({ key: f.key, description: f.description, values: values(f.key, f.key === "type" ? this.types().map((t) => t.type) : f.values) })), ...extra];
  }

  /** The filter keys extensions add, which `parse` needs to read them as filters. */
  extraKeys(): string[] {
    return this.deps.manifests().flatMap((m) => m.contributes.search.filters.map((f) => f.filter));
  }

  /**
   * What a query finds, a section per kind of result that found something. `type:` picks kinds; the
   * rest goes to each kind's provider. With nothing typed, it's the notes changed last.
   */
  async find(text: string, limit: number): Promise<SearchSection[]> {
    const extra = this.extraKeys();
    const query = parse(text, extra);
    const typed = query.terms.filter((t) => t.kind === "filter" && t.key === "type" && !t.negated && t.value).map((t) => (t.kind === "filter" ? t.value.toLowerCase() : ""));
    const rest: Query = { terms: query.terms.filter((t) => !(t.kind === "filter" && t.key === "type")) };
    if (!rest.terms.length && !typed.length) {
      const recent = await Promise.resolve(this.deps.notes.search(parse("-is:archived sort:edited"), limit)).catch(() => []);
      return recent.length ? [{ type: "note", title: "Recent", results: recent }] : [];
    }
    const own = new Set(FILTERS.map((f) => f.key));
    const sections = await Promise.all(
      this.types()
        .filter((t) => !typed.length || typed.includes(t.type))
        .map(async ({ type, title }) => {
          // Notes never match an extension's filter, so they aren't asked.
          if (type === "note" && rest.terms.some((t) => t.kind === "filter" && !own.has(t.key))) return null;
          const provider = type === "note" ? this.deps.notes : this.providers.get(type);
          const results = provider ? await Promise.resolve(provider.search(rest, limit)).catch(() => []) : [];
          return results.length ? { type, title, results: results.slice(0, limit) } : null;
        }),
    );
    return sections.filter((s): s is SearchSection => s !== null);
  }
}
