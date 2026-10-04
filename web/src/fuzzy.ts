// Fuzzy matching for the command bar: the query's characters, in order, anywhere in the text. Matches at
// the start of words and runs of consecutive characters score higher.

/** A score (higher is better), or null if `text` doesn't contain the query's characters in order. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 0;
  let best: number | null = null;
  // Try each place the first character appears, so "plan" finds the "Plan" in "Projects/Plan".
  for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
    const score = scoreFrom(q, t, start);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best === null ? null : best - t.length / 100;
}

function scoreFrom(q: string, t: string, start: number): number | null {
  let score = 0;
  let last = start - 2;
  let at = start;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return null;
    score += 1;
    if (at === last + 1) score += 3;
    if (at === 0 || /[\s/_.-]/.test(t[at - 1])) score += 2;
    last = at;
    at++;
  }
  return score;
}

/** The items that match, best first; ties keep their order. */
export function fuzzyFilter<T>(query: string, items: readonly T[], text: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, score: fuzzyScore(query, text(item)) }))
    .filter((m): m is { item: T; i: number; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.item);
}
