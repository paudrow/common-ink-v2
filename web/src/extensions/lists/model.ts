// Lists as lines of text, edited the way an outliner edits them: an item moves, indents and dedents with
// its children (its subtree), numbers follow their place, and a marker width that changes takes its
// children along so they stay its children. Every function takes the note's lines and gives back new
// ones; nothing here knows about editors.

export type Kind = "bullet" | "number" | "todo";

export interface Item {
  /** The column its marker starts at (tabs count as 4). */
  indent: number;
  /** The marker as written: "-", "*", "+", "3." or "3)". */
  marker: string;
  kind: Kind;
  /** Its number, for a numbered item. */
  number?: number;
  /** Where its text starts: after the marker, its spaces, and a todo's box. */
  contentStart: number;
  /** Where the marker and its spaces end: children are indented at least this far. */
  markerEnd: number;
}

const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)/;
const BOX = /^\[[ xX]\](?:[ \t]+|$)/;

const columns = (ws: string) => [...ws].reduce((n, c) => n + (c === "\t" ? 4 : 1), 0);

export const isBlank = (line: string) => /^\s*$/.test(line);

export const indentOf = (line: string) => columns(/^[ \t]*/.exec(line)![0]);

/** The list item a line starts, if it starts one. */
export function parseItem(line: string): Item | null {
  if (RULE.test(line)) return null;
  const m = ITEM.exec(line);
  if (!m) return null;
  const box = BOX.exec(line.slice(m[0].length));
  return {
    indent: columns(m[1]),
    marker: m[2],
    kind: box ? "todo" : m[3] ? "number" : "bullet",
    number: m[3] ? Number(m[3]) : undefined,
    markerEnd: m[0].length,
    contentStart: m[0].length + (box ? box[0].length : 0),
  };
}

/** Whether an item has nothing written after its marker (and box). */
export const isEmptyItem = (line: string) => {
  const item = parseItem(line);
  return !!item && isBlank(line.slice(item.contentStart));
};

/** The end (exclusive) of item `i`'s subtree: it, and every line after it indented further, blank lines between included but not after. */
export function subtreeEnd(lines: readonly string[], i: number): number {
  const base = indentOf(lines[i]);
  let end = i + 1;
  for (let j = i + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) continue;
    if (indentOf(lines[j]) <= base) break;
    end = j + 1;
  }
  return end;
}

/** The item before `i` at its level, under the same parent, if there is one. */
export function previousSibling(lines: readonly string[], i: number): number | null {
  const base = indentOf(lines[i]);
  for (let j = i - 1; j >= 0; j--) {
    if (isBlank(lines[j])) continue;
    const at = indentOf(lines[j]);
    const item = parseItem(lines[j]);
    if (item && at === base) return j;
    if (at < base) return null;
    // Deeper lines are an earlier sibling's children; same-level text is its lazy continuation.
  }
  return null;
}

/** The item after `i`'s subtree at its level, if there is one. */
export function nextSibling(lines: readonly string[], i: number): number | null {
  const base = indentOf(lines[i]);
  for (let j = subtreeEnd(lines, i); j < lines.length; j++) {
    if (isBlank(lines[j])) continue;
    return parseItem(lines[j]) && indentOf(lines[j]) === base ? j : null;
  }
  return null;
}

/** The item `i` is a child of, if any. */
export function parentOf(lines: readonly string[], i: number): number | null {
  const base = indentOf(lines[i]);
  for (let j = i - 1; j >= 0; j--) {
    if (isBlank(lines[j])) continue;
    if (indentOf(lines[j]) < base) return parseItem(lines[j]) ? j : null;
  }
  return null;
}

/** The item a line belongs to: the item it starts, or the one whose text or children it's part of. */
export function itemAt(lines: readonly string[], line: number): number | null {
  for (let j = line; j >= 0; j--) {
    if (isBlank(lines[j]) && j !== line) continue;
    if (parseItem(lines[j]) && subtreeEnd(lines, j) > line) return j;
    if (!isBlank(lines[j]) && indentOf(lines[j]) === 0 && !parseItem(lines[j])) return null;
  }
  return null;
}

/** Lines shifted right (or left, for a negative `by`) by `by` columns; blank lines stay as they are. */
function shift(lines: readonly string[], by: number): string[] {
  return lines.map((line) => {
    if (isBlank(line) || by === 0) return line;
    const ws = /^[ \t]*/.exec(line)![0];
    return " ".repeat(Math.max(0, columns(ws) + by)) + line.slice(ws.length);
  });
}

/** A line with its leading whitespace as spaces, so columns and characters agree. */
const spaced = (line: string) => {
  const ws = /^[ \t]*/.exec(line)![0];
  return " ".repeat(columns(ws)) + line.slice(ws.length);
};

/** Item `i`'s marker rewritten; its children shift by the change in its width, to stay its children. */
export function setMarker(lines: readonly string[], i: number, marker: string): string[] {
  const line = spaced(lines[i]);
  const item = parseItem(line)!;
  const gap = /^[ \t]*/.exec(line.slice(item.indent + item.marker.length))![0] || " ";
  const rest = line.slice(item.markerEnd);
  const head = `${" ".repeat(item.indent)}${marker}${gap}`;
  const end = subtreeEnd(lines, i);
  const by = head.length - item.markerEnd;
  return [...lines.slice(0, i), `${head}${rest}`, ...shift(lines.slice(i + 1, end), by), ...lines.slice(end)];
}

export interface Edit {
  lines: string[];
  /** Where the item that was edited is now. */
  at: number;
}

/** Indent item `i` (and its children) under the item before it. Null if it's first at its level. */
export function indent(lines: readonly string[], i: number): Edit | null {
  const prev = previousSibling(lines, i);
  if (prev === null) return null;
  const prevItem = parseItem(spaced(lines[prev]))!;
  const by = prevItem.markerEnd - indentOf(lines[i]);
  const end = subtreeEnd(lines, i);
  let next = [...lines.slice(0, i), ...shift(lines.slice(i, end), by), ...lines.slice(end)];
  // The first item of a new numbered list under its parent counts from 1.
  const item = parseItem(next[i])!;
  if (item.number !== undefined && previousSibling(next, i) === null) next = setMarker(next, i, `1${item.marker.slice(-1)}`);
  return { lines: renumberAround(next, [prev, i]), at: i };
}

/**
 * Dedent item `i` (and its children) out of its parent, as an outliner does: it becomes the item after
 * its parent, and the items after it stay its parent's. Null if it isn't in a parent.
 */
export function dedent(lines: readonly string[], i: number): Edit | null {
  const parent = parentOf(lines, i);
  const end = subtreeEnd(lines, i);
  if (parent === null) {
    // Indented, but under no item: just move it left.
    const at = indentOf(lines[i]);
    return at ? { lines: [...lines.slice(0, i), ...shift(lines.slice(i, end), -at), ...lines.slice(end)], at: i } : null;
  }
  const parentEnd = subtreeEnd(lines, parent);
  const block = shift(lines.slice(i, end), indentOf(lines[parent]) - indentOf(lines[i]));
  const without = [...lines.slice(0, i), ...lines.slice(end)];
  const to = parentEnd - (end - i);
  const next = [...without.slice(0, to), ...block, ...without.slice(to)];
  return { lines: renumberAround(next, [parent, i, to]), at: to };
}

/** Swap item `i`'s subtree with the one before it at its level. Null if it's first. */
export function moveUp(lines: readonly string[], i: number): Edit | null {
  const prev = previousSibling(lines, i);
  if (prev === null) return null;
  const end = subtreeEnd(lines, i);
  const prevEnd = subtreeEnd(lines, prev);
  const between = lines.slice(prevEnd, i);
  let next = [...lines.slice(0, prev), ...lines.slice(i, end), ...between, ...lines.slice(prev, prevEnd), ...lines.slice(end)];
  // A numbered list keeps the number it starts from: the item moved up takes the number of its new place.
  const was = parseItem(lines[prev]);
  const moved = parseItem(next[prev]);
  if (was?.number !== undefined && moved?.number !== undefined) next = setMarker(next, prev, `${was.number}${moved.marker.slice(-1)}`);
  return { lines: renumberAround(next, [prev]), at: prev };
}

/** Swap item `i`'s subtree with the one after it at its level. Null if it's last. */
export function moveDown(lines: readonly string[], i: number): Edit | null {
  const next = nextSibling(lines, i);
  if (next === null) return null;
  const moved = moveUp(lines, next)!;
  // It's now after the subtree that was below it.
  return { lines: moved.lines, at: i + (subtreeEnd(lines, next) - next) + (next - subtreeEnd(lines, i)) };
}

/** Items `from` to `to` (line numbers) made bullets ("- "), numbered ("1. ") or todos ("- [ ] "), keeping their text. */
export function convert(lines: readonly string[], from: number, to: number, kind: Kind): string[] {
  let out = [...lines];
  for (let i = from; i <= to; i++) {
    const item = parseItem(out[i]);
    if (!item || item.kind === kind) continue;
    const line = spaced(out[i]);
    // The box goes or comes first, with the marker as it is; then the marker changes, children with it.
    out[i] = `${line.slice(0, item.indent)}${item.marker} ${kind === "todo" ? "[ ] " : ""}${line.slice(item.contentStart)}`;
    const delim = /[.)]$/.exec(item.marker)?.[0] ?? ".";
    out = setMarker(out, i, kind === "number" ? `${item.number ?? 1}${delim}` : "-");
  }
  return renumberAround(out, Array.from({ length: to - from + 1 }, (_, k) => from + k));
}

/**
 * Numbered lists numbered in order, counting from each list's first number, for the lists at every
 * level that the given lines are in or next to. Other lists are left as they're written.
 */
export function renumberAround(lines: readonly string[], touched: readonly number[]): string[] {
  let out = [...lines];
  const near = new Set(touched.flatMap((t) => [t - 1, t, t + 1]));
  for (let i = 0; i < out.length; i++) {
    const item = parseItem(out[i]);
    if (item?.kind !== "number" && !(item?.kind === "todo" && item.number !== undefined)) continue;
    // The first item of a run of numbered siblings starts it.
    const prev = previousSibling(out, i);
    if (prev !== null && parseItem(out[prev])?.number !== undefined) continue;
    const run: number[] = [];
    for (let j: number | null = i; j !== null && parseItem(out[j])?.number !== undefined; j = nextSibling(out, j)) run.push(j);
    if (!run.some((j) => [...near].some((t) => t >= j && t < subtreeEnd(out, j)))) continue;
    let n = item.number!;
    for (const j of run) {
      const it = parseItem(out[j])!;
      const want = `${n}${it.marker.slice(-1)}`;
      if (it.marker !== want) out = setMarker(out, j, want);
      n++;
    }
  }
  return out;
}

/** The top-level items among lines `from` to `to`: those not inside another one in the range. */
export function itemsIn(lines: readonly string[], from: number, to: number): number[] {
  const out: number[] = [];
  let covered = -1;
  for (let i = from; i <= to; i++) {
    if (i < covered || !parseItem(lines[i])) continue;
    out.push(i);
    covered = subtreeEnd(lines, i);
  }
  if (!out.length) {
    const at = itemAt(lines, from);
    if (at !== null) out.push(at);
  }
  return out;
}

/** The lines `foldable` would hide under item `i`: its children, if it has any. */
export function childrenRange(lines: readonly string[], i: number): { from: number; to: number } | null {
  const end = subtreeEnd(lines, i);
  return end > i + 1 ? { from: i + 1, to: end - 1 } : null;
}
