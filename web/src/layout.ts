// Windows, tabs and splits as data: a tree of splits whose leaves are groups of tabs, and the group
// that has focus. Each split knows how it shares its space. Every change is a pure function from one
// layout to the next. The layout is saved as a JSON file (.common-ink/layout.json) and read back
// through parseLayout.
import { parseFilePath, type FilePath } from "../../worker/src/files.ts";

export type GroupId = string;

/** Anything that opens in a window: a file, or a view that an extension draws (such as History). */
export type Openable = { file: FilePath } | { view: string };

/**
 * A tab: what it shows, and whether it's a preview. A preview tab (in italics) is the one the next
 * note you open replaces, as in VSCode; editing it, double-clicking it or Keep Open keeps it.
 */
export type Tab = Openable & { preview?: true };

export interface Group {
  kind: "group";
  id: GroupId;
  tabs: Tab[];
  /** The index of the tab on show. 0 when there are no tabs. */
  active: number;
}

export interface Split {
  kind: "split";
  dir: "row" | "column";
  children: Node[];
  /** Each child's share of the space, adding up to 1. */
  sizes: number[];
}

export type Node = Group | Split;

export interface Layout {
  root: Node;
  focus: GroupId;
}

export type Direction = "left" | "right" | "up" | "down";

export const LAYOUT_PATH = parseFilePath(".common-ink/layout.json")!;

/** The smallest share a window can be resized to. */
const MIN_SIZE = 0.1;

export const fileTab = (file: FilePath): Openable => ({ file });

/** One string per openable thing, for comparing and for keys. */
export const openableKey = (o: Openable) => ("file" in o ? `file:${o.file}` : `view:${o.view}`);

/** What a tab shows, without its preview mark. */
export const openableOf = (t: Tab): Openable => ("file" in t ? { file: t.file } : { view: t.view });
const same = (a: Openable, b: Openable) => openableKey(a) === openableKey(b);

export function emptyLayout(): Layout {
  return { root: { kind: "group", id: "g1", tabs: [], active: 0 }, focus: "g1" };
}

/** Every group, left to right and top to bottom. */
export function groups(layout: Layout): Group[] {
  const out: Group[] = [];
  const walk = (n: Node) => (n.kind === "group" ? out.push(n) : n.children.forEach(walk));
  walk(layout.root);
  return out;
}

export function focused(layout: Layout): Group {
  return groups(layout).find((g) => g.id === layout.focus)!;
}

export function activeTab(group: Group): Tab | null {
  return group.tabs[group.active] ?? null;
}

/** The file the group shows, if it's showing a file. */
export function activeFile(group: Group): FilePath | null {
  const tab = activeTab(group);
  return tab && "file" in tab ? tab.file : null;
}

const even = (n: number) => Array.from({ length: n }, () => 1 / n);

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  // Sizes that add up to 1, give or take a float's rounding, are kept as they are: a layout read back is the one written.
  if (Math.abs(total - 1) < 1e-9) return sizes;
  return total > 0 ? sizes.map((s) => s / total) : even(sizes.length);
}

/** A split, tidied: no empty children, no split of one, and a split inside a split the same way joins it. */
function makeSplit(dir: Split["dir"], parts: Array<{ node: Node; size: number }>): Node | null {
  const flat = parts.flatMap(({ node, size }) =>
    node.kind === "split" && node.dir === dir ? node.children.map((c, i) => ({ node: c, size: size * node.sizes[i] })) : [{ node, size }],
  );
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0].node;
  return { kind: "split", dir, children: flat.map((p) => p.node), sizes: normalize(flat.map((p) => p.size)) };
}

/** Replace one group, keeping the rest of the tree. */
function mapGroup(node: Node, id: GroupId, fn: (g: Group) => Node | null): Node | null {
  if (node.kind === "group") return node.id === id ? fn(node) : node;
  const parts = node.children.flatMap((c, i) => {
    const mapped = mapGroup(c, id, fn);
    return mapped ? [{ node: mapped, size: node.sizes[i] }] : [];
  });
  return makeSplit(node.dir, parts);
}

function withGroup(layout: Layout, id: GroupId, fn: (g: Group) => Node | null): Layout {
  return { ...layout, root: mapGroup(layout.root, id, fn) ?? emptyLayout().root };
}

/** Put a kept tab in a group at an index (by default after the one on show) and show it. If the group has it already, keep and show it. */
export function insertTab(layout: Layout, item: Openable, id: GroupId = layout.focus, index?: number): Layout {
  const kept = openableOf(item);
  const next = withGroup(layout, id, (g) => {
    const at = g.tabs.findIndex((t) => same(t, kept));
    if (at >= 0) return { ...g, tabs: g.tabs.map((t, i) => (i === at ? kept : t)), active: at };
    const insert = Math.min(Math.max(0, index ?? (g.tabs.length ? g.active + 1 : 0)), g.tabs.length);
    return { ...g, tabs: [...g.tabs.slice(0, insert), kept, ...g.tabs.slice(insert)], active: insert };
  });
  return { ...next, focus: id };
}

/** Show a file in a new tab, or its tab if the group has one. */
export function openTab(layout: Layout, path: FilePath, id: GroupId = layout.focus): Layout {
  return insertTab(layout, fileTab(path), id);
}

/**
 * Show something in a preview tab, as VSCode does (and Vim's `:e`): its tab if the group has one;
 * otherwise in place of the group's preview tab; otherwise in a new preview tab after the one on show.
 */
export function showInTab(layout: Layout, item: Openable | FilePath, id: GroupId = layout.focus): Layout {
  const it: Tab = { ...(typeof item === "string" ? fileTab(item) : openableOf(item)), preview: true };
  const next = withGroup(layout, id, (g) => {
    const at = g.tabs.findIndex((t) => same(t, it));
    if (at >= 0) return { ...g, active: at };
    const preview = g.tabs.findIndex((t) => t.preview);
    if (preview >= 0) return { ...g, tabs: g.tabs.map((t, i) => (i === preview ? it : t)), active: preview };
    const insert = g.tabs.length ? g.active + 1 : 0;
    return { ...g, tabs: [...g.tabs.slice(0, insert), it, ...g.tabs.slice(insert)], active: insert };
  });
  return { ...next, focus: id };
}

/** Keep a preview tab open: it's no longer the one the next opened note replaces. */
export function keepTab(layout: Layout, id: GroupId, index: number): Layout {
  return withGroup(layout, id, (g) => (g.tabs[index]?.preview ? { ...g, tabs: g.tabs.map((t, i) => (i === index ? openableOf(t) : t)) } : g));
}

/** Keep every preview tab showing a file (editing a file keeps it open, wherever it shows). */
export function keepFile(layout: Layout, path: FilePath): Layout {
  let next = layout;
  for (const g of groups(layout)) g.tabs.forEach((t, i) => t.preview && "file" in t && t.file === path && (next = keepTab(next, g.id, i)));
  return next;
}

/** Close the tabs of a group that `which` picks, by position. */
export function closeTabs(layout: Layout, id: GroupId, which: (tab: Tab, index: number) => boolean): Layout {
  const g = groups(layout).find((x) => x.id === id);
  if (!g) return layout;
  const indexes = g.tabs.flatMap((t, i) => (which(t, i) ? [i] : [])).reverse();
  return indexes.reduce((l, i) => closeTab(l, id, i), layout);
}

/** Close a tab. A group left with no tabs closes too, unless it's the only one. */
export function closeTab(layout: Layout, id: GroupId, index: number): Layout {
  const only = groups(layout).length === 1;
  const next = withGroup(layout, id, (g) => {
    const tabs = g.tabs.filter((_, i) => i !== index);
    if (!tabs.length && !only) return null;
    const active = index < g.active || g.active >= tabs.length ? Math.max(0, g.active - 1) : g.active;
    return { ...g, tabs, active };
  });
  const remaining = groups(next);
  if (remaining.some((g) => g.id === layout.focus)) return next;
  // The focused group closed: focus the group that took its place.
  const before = groups(layout).findIndex((g) => g.id === id);
  return { ...next, focus: remaining[Math.min(before, remaining.length - 1)].id };
}

/**
 * Move a tab: to another position in its group, to another group, or (with `side`) into a new group
 * split off that side of the target. A group the move empties closes.
 */
export function moveTab(layout: Layout, from: { group: GroupId; index: number }, to: { group: GroupId; index?: number; side?: Direction }): Layout {
  const source = groups(layout).find((g) => g.id === from.group);
  const item = source?.tabs[from.index];
  if (!source || !item) return layout;
  if (to.side) {
    if (from.group === to.group && source.tabs.length === 1) return layout;
    const split = splitAt(layout, to.group, to.side, item);
    return { ...closeTabKeepingGroup(split, from.group, from.index), focus: split.focus };
  }
  if (from.group === to.group) {
    const tabs = source.tabs.filter((_, i) => i !== from.index);
    const wanted = to.index ?? tabs.length + 1;
    const index = Math.min(Math.max(0, wanted > from.index ? wanted - 1 : wanted), tabs.length);
    tabs.splice(index, 0, item);
    return { ...withGroup(layout, from.group, (g) => ({ ...g, tabs, active: index })), focus: from.group };
  }
  const target = groups(layout).find((g) => g.id === to.group);
  if (!target) return layout;
  const already = target.tabs.findIndex((t) => same(t, item));
  const added = already >= 0 ? selectTab(layout, to.group, already) : insertTab(layout, item, to.group, to.index ?? target.tabs.length);
  return { ...closeTabKeepingGroup(added, from.group, from.index), focus: to.group };
}

function closeTabKeepingGroup(layout: Layout, id: GroupId, index: number): Layout {
  const focus = layout.focus;
  const next = closeTab(layout, id, index);
  return groups(next).some((g) => g.id === focus) ? { ...next, focus } : next;
}

const nextId = (layout: Layout) => `g${Math.max(0, ...groups(layout).map((x) => Number(x.id.slice(1)) || 0)) + 1}`;

/** Split a group: a new group on one side of it, showing `item`, with focus. */
export function splitAt(layout: Layout, id: GroupId, side: Direction, item: Openable | null): Layout {
  const added: Group = { kind: "group", id: nextId(layout), tabs: item ? [item] : [], active: 0 };
  const dir = side === "left" || side === "right" ? "row" : "column";
  const halves = (old: Node) =>
    side === "left" || side === "up"
      ? [
          { node: added, size: 0.5 },
          { node: old, size: 0.5 },
        ]
      : [
          { node: old, size: 0.5 },
          { node: added, size: 0.5 },
        ];
  return { root: mapGroup(layout.root, id, (old) => makeSplit(dir, halves(old)))!, focus: added.id };
}

/** Split the focused group: a new group on one side, showing `path` (by default, what the focused group shows). */
export function split(layout: Layout, where: Direction, path?: FilePath): Layout {
  const g = focused(layout);
  return splitAt(layout, g.id, where, path ? fileTab(path) : activeTab(g));
}

/** Close every group but the focused one. */
export function only(layout: Layout): Layout {
  return { root: focused(layout), focus: layout.focus };
}

export function focusGroup(layout: Layout, id: GroupId): Layout {
  return groups(layout).some((g) => g.id === id) ? { ...layout, focus: id } : layout;
}

/** Show a group's tab by index and focus the group. */
export function selectTab(layout: Layout, id: GroupId, index: number): Layout {
  const next = withGroup(layout, id, (g) => (index >= 0 && index < g.tabs.length ? { ...g, active: index } : g));
  return { ...next, focus: id };
}

/** The next or previous tab in the focused group, wrapping around. */
export function cycleTab(layout: Layout, by: number): Layout {
  return withGroup(layout, layout.focus, (g) => (g.tabs.length ? { ...g, active: (g.active + by + g.tabs.length * 2) % g.tabs.length } : g));
}

/** The next or previous group, wrapping around (Vim's Ctrl-W w). */
export function cycleGroup(layout: Layout, by: number): Layout {
  const all = groups(layout);
  const at = all.findIndex((g) => g.id === layout.focus);
  return { ...layout, focus: all[(at + by + all.length) % all.length].id };
}

/** Move the focused group's tab on show by `by` places within the group (Vim's :tabmove +1 and -1). */
export function shiftTab(layout: Layout, by: number): Layout {
  const g = focused(layout);
  if (!g.tabs.length) return layout;
  const to = Math.min(Math.max(0, g.active + by), g.tabs.length - 1);
  return moveTab(layout, { group: g.id, index: g.active }, { group: g.id, index: to > g.active ? to + 1 : to });
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each group sits in a unit square. */
export function rects(node: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<GroupId, Rect>()): Map<GroupId, Rect> {
  if (node.kind === "group") return out.set(node.id, r);
  let at = 0;
  node.children.forEach((c, i) => {
    const s = node.sizes[i];
    rects(c, node.dir === "row" ? { x: r.x + r.w * at, y: r.y, w: r.w * s, h: r.h } : { x: r.x, y: r.y + r.h * at, w: r.w, h: r.h * s }, out);
    at += s;
  });
  return out;
}

/** The nearest group in a direction from a group, if there is one. */
export function neighbor(layout: Layout, id: GroupId, direction: Direction): GroupId | null {
  const all = rects(layout.root);
  const from = all.get(id)!;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const eps = 1e-9;
  let best: { id: GroupId; d: number } | null = null;
  for (const [other, r] of all) {
    if (other === id) continue;
    const ahead =
      direction === "left" ? r.x + r.w <= from.x + eps : direction === "right" ? r.x >= from.x + from.w - eps : direction === "up" ? r.y + r.h <= from.y + eps : r.y >= from.y + from.h - eps;
    const overlaps = direction === "left" || direction === "right" ? r.y < from.y + from.h - eps && r.y + r.h > from.y + eps : r.x < from.x + from.w - eps && r.x + r.w > from.x + eps;
    if (!ahead || !overlaps) continue;
    const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (!best || d < best.d) best = { id: other, d };
  }
  return best?.id ?? null;
}

/** Focus the nearest group in a direction (Vim's Ctrl-W h, j, k, l). */
export function focusDirection(layout: Layout, direction: Direction): Layout {
  const id = neighbor(layout, layout.focus, direction);
  return id ? { ...layout, focus: id } : layout;
}

/**
 * Move the focused group's tab on show to the group that way, or into a new group split off that side
 * if there's none (Vim's Ctrl-W H, J, K, L, for one tab).
 */
export function moveTabDirection(layout: Layout, direction: Direction): Layout {
  const g = focused(layout);
  if (!g.tabs.length) return layout;
  const target = neighbor(layout, g.id, direction);
  const from = { group: g.id, index: g.active };
  return target ? moveTab(layout, from, { group: target }) : moveTab(layout, from, { group: g.id, side: direction });
}

/** Set the sizes of a split, found by its path of child indexes from the root. */
export function resizeSplit(layout: Layout, path: number[], sizes: number[]): Layout {
  const set = (node: Node, depth: number): Node => {
    if (node.kind !== "split") return node;
    if (depth === path.length) return sizes.length === node.children.length ? { ...node, sizes: normalize(sizes.map((s) => Math.max(MIN_SIZE / 2, s))) } : node;
    return { ...node, children: node.children.map((c, i) => (i === path[depth] ? set(c, depth + 1) : c)) };
  };
  return { ...layout, root: set(layout.root, 0) };
}

/**
 * Grow or shrink the focused group along an axis by `by` (a share of its split), taking the space from
 * its neighbour (Vim's Ctrl-W >, <, + and -).
 */
export function resizeFocused(layout: Layout, axis: Split["dir"], by: number): Layout {
  const find = (node: Node, path: number[]): number[] | null => {
    if (node.kind === "group") return node.id === layout.focus ? path : null;
    for (let i = 0; i < node.children.length; i++) {
      const found = find(node.children[i], [...path, i]);
      if (found) return found;
    }
    return null;
  };
  const path = find(layout.root, [])!;
  // The nearest split along the axis that holds the focused group.
  for (let depth = path.length - 1; depth >= 0; depth--) {
    let node = layout.root;
    for (let i = 0; i < depth; i++) node = (node as Split).children[path[i]];
    if (node.kind === "split" && node.dir === axis) {
      const i = path[depth];
      const j = i + 1 < node.children.length ? i + 1 : i - 1;
      const sizes = [...node.sizes];
      const change = Math.max(-(sizes[i] - MIN_SIZE), Math.min(by, sizes[j] - MIN_SIZE));
      sizes[i] += change;
      sizes[j] -= change;
      return resizeSplit(layout, path.slice(0, depth), sizes);
    }
  }
  return layout;
}

/** Every split shares its space evenly (Vim's Ctrl-W =). */
export function equalize(layout: Layout): Layout {
  const level = (node: Node): Node => (node.kind === "group" ? node : { ...node, children: node.children.map(level), sizes: even(node.children.length) });
  return { ...layout, root: level(layout.root) };
}

function parseTab(v: unknown): Tab | null {
  const o = parseOpenable(v);
  return o && v && typeof v === "object" && (v as { preview?: unknown }).preview === true ? { ...o, preview: true } : o;
}

function parseOpenable(v: unknown): Openable | null {
  // Layouts saved before views could open in windows list tabs as paths.
  if (typeof v === "string") {
    const path = parseFilePath(v);
    return path ? { file: path } : null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.file === "string") {
    const path = parseFilePath(o.file);
    return path ? { file: path } : null;
  }
  // A view's id names it, and for views made on demand also what they show (such as a file and revision).
  return typeof o.view === "string" && /^[^\n]{1,400}$/.test(o.view) ? { view: o.view } : null;
}

/** A layout read from its JSON file, or null if it isn't one. Tabs that aren't openable are dropped. */
export function parseLayout(value: unknown): Layout | null {
  const ids = new Set<string>();
  const node = (v: unknown): Node | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (o.kind === "group" && typeof o.id === "string" && /^g\d+$/.test(o.id) && !ids.has(o.id) && Array.isArray(o.tabs)) {
      ids.add(o.id);
      const tabs: Tab[] = [];
      for (const t of o.tabs.map(parseTab)) if (t && !tabs.some((x) => same(x, t))) tabs.push(t.preview && tabs.some((x) => x.preview) ? openableOf(t) : t);
      const active = Number.isInteger(o.active) ? Math.min(Math.max(0, o.active as number), Math.max(0, tabs.length - 1)) : 0;
      return { kind: "group", id: o.id, tabs, active };
    }
    if (o.kind === "split" && (o.dir === "row" || o.dir === "column") && Array.isArray(o.children) && o.children.length >= 1) {
      const children = o.children.map(node);
      if (!children.every((c) => c !== null)) return null;
      const sizes = Array.isArray(o.sizes) && o.sizes.length === children.length && o.sizes.every((s) => typeof s === "number" && s > 0) ? (o.sizes as number[]) : even(children.length);
      // Tidied as any split is: one child stands alone, a split the same way joins its parent, sizes add up to 1.
      return makeSplit(o.dir, children.map((c, i) => ({ node: c as Node, size: sizes[i] })));
    }
    return null;
  };
  const o = value as { root?: unknown; focus?: unknown } | null;
  const root = node(o?.root);
  if (!root) return null;
  const layout: Layout = { root, focus: typeof o?.focus === "string" ? o.focus : "" };
  return groups(layout).some((g) => g.id === layout.focus) ? layout : { ...layout, focus: groups(layout)[0].id };
}
