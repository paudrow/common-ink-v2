// Line diffs and three-way merges that stay quick on long notes. node-diff3 finds its longest common
// subsequence in time that grows with every pair of equal lines, and a note's blank lines are all equal:
// a one-line edit to a 10,000-line note took seconds, holding up the workspace meanwhile. So each diff
// leaves out the lines that match at both ends, which an edit of a few lines leaves nearly all of.
import { diffIndices, diffPatch, type IPatchRes } from "node-diff3";

/**
 * Matched lines handed back to each end of a diff while they also appear in what it compares, so the diff
 * can line a repeated line (a blank, a rule) up as it would have with the whole text.
 */
const GIVE_BACK = 10;

/** How many lines a and b share at the start and at the end, less any handed back. */
function sharedEnds(a: readonly string[], b: readonly string[]): [number, number] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const between = new Set([...a.slice(start, a.length - end), ...b.slice(start, b.length - end)]);
  for (let k = 0; k < GIVE_BACK && start > 0 && between.has(a[start - 1]); k++) start--;
  for (let k = 0; k < GIVE_BACK && end > 0 && between.has(a[a.length - end]); k++) end--;
  return [start, end];
}

/** node-diff3's diffPatch from a to b, found between the lines they share at either end. */
export function linePatch(a: string[], b: string[]): IPatchRes<string>[] {
  const [start, end] = sharedEnds(a, b);
  return diffPatch(a.slice(start, a.length - end), b.slice(start, b.length - end)).map(({ buffer1, buffer2 }) => ({
    buffer1: { ...buffer1, offset: buffer1.offset + start },
    buffer2: { ...buffer2, offset: buffer2.offset + start },
  }));
}

interface Hunk {
  side: readonly string[];
  oStart: number;
  oLength: number;
  start: number;
  length: number;
}

/** Where `side` differs from o, as node-diff3's diffIndices(o, side) gives it. */
function hunks(o: string[], side: string[]): Hunk[] {
  const [start, end] = sharedEnds(o, side);
  return diffIndices(o.slice(start, o.length - end), side.slice(start, side.length - end)).map((h) => ({
    side,
    oStart: h.buffer1[0] + start,
    oLength: h.buffer1[1],
    start: h.buffer2[0] + start,
    length: h.buffer2[1],
  }));
}

/**
 * Three-way merge by line of a and b from o, or null when they changed the same lines differently. It's
 * node-diff3's diff3Merge with excludeFalseConflicts, region for region, over hunks found as above.
 */
export function lineMerge(a: string[], o: string[], b: string[]): string[] | null {
  const all = [...hunks(o, a), ...hunks(o, b)].sort((x, y) => x.oStart - y.oStart);
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < all.length; ) {
    const regionStart = all[i].oStart;
    let regionEnd = regionStart + all[i].oLength;
    let next = i + 1;
    for (; next < all.length && all[next].oStart <= regionEnd; next++) regionEnd = Math.max(regionEnd, all[next].oStart + all[next].oLength);
    out.push(...o.slice(at, regionStart));
    if (next === i + 1) {
      const h = all[i];
      out.push(...h.side.slice(h.start, h.start + h.length));
    } else {
      // Each side's lines across the whole region, as diff3 bounds them.
      const across = (side: readonly string[]) => {
        let [lo, hi, oLo, oHi] = [side.length, -1, o.length, -1];
        for (const h of all.slice(i, next)) {
          if (h.side !== side) continue;
          [lo, hi] = [Math.min(lo, h.start), Math.max(hi, h.start + h.length)];
          [oLo, oHi] = [Math.min(oLo, h.oStart), Math.max(oHi, h.oStart + h.oLength)];
        }
        return side.slice(lo + (regionStart - oLo), hi + (regionEnd - oHi));
      };
      const [mine, theirs] = [across(a), across(b)];
      if (mine.length !== theirs.length || mine.some((line, k) => line !== theirs[k])) return null;
      out.push(...mine);
    }
    at = regionEnd;
    i = next;
  }
  out.push(...o.slice(at));
  return out;
}
