// Windows, tabs and splits as data: a tree of splits whose leaves are groups of tabs, and the group
// that has focus. Every change is a pure function from one layout to the next. The layout is saved as
// workspace JSON (.common-ink/layout.json), so it's read back through parseLayout.
import { parseDocPath, type DocPath } from "../../worker/src/docs.ts";

export type GroupId = string;

export interface Group {
  kind: "group";
  id: GroupId;
  tabs: DocPath[];
  /** The index of the tab on show. 0 when there are no tabs. */
  active: number;
}

export interface Split {
  kind: "split";
  dir: "row" | "column";
  children: Node[];
}

export type Node = Group | Split;

export interface Layout {
  root: Node;
  focus: GroupId;
}

export type Direction = "left" | "right" | "up" | "down";

export const LAYOUT_PATH = parseDocPath(".common-ink/layout.json")!;

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

export function activeDoc(group: Group): DocPath | null {
  return group.tabs[group.active] ?? null;
}

/** Replace one group, keeping the rest of the tree. */
function mapGroup(node: Node, id: GroupId, fn: (g: Group) => Node | null): Node | null {
  if (node.kind === "group") return node.id === id ? fn(node) : node;
  const children = node.children.map((c) => mapGroup(c, id, fn)).filter((c): c is Node => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // A split inside a split the same way is one split.
  return { ...node, children: children.flatMap((c) => (c.kind === "split" && c.dir === node.dir ? c.children : [c])) };
}

function withGroup(layout: Layout, id: GroupId, fn: (g: Group) => Node | null): Layout {
  return { ...layout, root: mapGroup(layout.root, id, fn) ?? emptyLayout().root };
}

/** Show a doc in a group: its tab if it has one, or a new tab after the current one. */
export function openTab(layout: Layout, path: DocPath, id: GroupId = layout.focus): Layout {
  const next = withGroup(layout, id, (g) => {
    const at = g.tabs.indexOf(path);
    if (at >= 0) return { ...g, active: at };
    const insert = g.tabs.length ? g.active + 1 : 0;
    return { ...g, tabs: [...g.tabs.slice(0, insert), path, ...g.tabs.slice(insert)], active: insert };
  });
  return { ...next, focus: id };
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

/** Split the focused group: a new group to its right or below it, showing `path` (by default, what the focused group shows). */
export function split(layout: Layout, where: "right" | "down", path?: DocPath): Layout {
  const g = focused(layout);
  const show = path ?? activeDoc(g);
  const id = `g${Math.max(0, ...groups(layout).map((x) => Number(x.id.slice(1)) || 0)) + 1}`;
  const added: Group = { kind: "group", id, tabs: show ? [show] : [], active: 0 };
  const dir = where === "right" ? "row" : "column";
  return { root: mapGroup(layout.root, g.id, (old) => ({ kind: "split", dir, children: [old, added] }))!, focus: id };
}

/** Close every group but the focused one. */
export function only(layout: Layout): Layout {
  return { root: focused(layout), focus: layout.focus };
}

export function focusGroup(layout: Layout, id: GroupId): Layout {
  return groups(layout).some((g) => g.id === id) ? { ...layout, focus: id } : layout;
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

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each group sits in a unit square, with splits dividing space evenly. */
function rects(node: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<GroupId, Rect>()): Map<GroupId, Rect> {
  if (node.kind === "group") return out.set(node.id, r);
  const n = node.children.length;
  node.children.forEach((c, i) =>
    rects(c, node.dir === "row" ? { x: r.x + (r.w * i) / n, y: r.y, w: r.w / n, h: r.h } : { x: r.x, y: r.y + (r.h * i) / n, w: r.w, h: r.h / n }, out),
  );
  return out;
}

/** Focus the nearest group in a direction (Vim's Ctrl-W h, j, k, l). */
export function focusDirection(layout: Layout, direction: Direction): Layout {
  const all = rects(layout.root);
  const from = all.get(layout.focus)!;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const eps = 1e-9;
  let best: { id: GroupId; d: number } | null = null;
  for (const [id, r] of all) {
    if (id === layout.focus) continue;
    const ahead =
      direction === "left" ? r.x + r.w <= from.x + eps : direction === "right" ? r.x >= from.x + from.w - eps : direction === "up" ? r.y + r.h <= from.y + eps : r.y >= from.y + from.h - eps;
    const overlaps = direction === "left" || direction === "right" ? r.y < from.y + from.h - eps && r.y + r.h > from.y + eps : r.x < from.x + from.w - eps && r.x + r.w > from.x + eps;
    if (!ahead || !overlaps) continue;
    const d = Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    if (!best || d < best.d) best = { id, d };
  }
  return best ? { ...layout, focus: best.id } : layout;
}

/** A layout read from workspace JSON, or null if it isn't one. Tabs that aren't doc paths are dropped. */
export function parseLayout(value: unknown): Layout | null {
  const ids = new Set<string>();
  const node = (v: unknown): Node | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (o.kind === "group" && typeof o.id === "string" && /^g\d+$/.test(o.id) && !ids.has(o.id) && Array.isArray(o.tabs)) {
      ids.add(o.id);
      const tabs = [...new Set(o.tabs.map(parseDocPath).filter((p): p is DocPath => p !== null))];
      const active = Number.isInteger(o.active) ? Math.min(Math.max(0, o.active as number), Math.max(0, tabs.length - 1)) : 0;
      return { kind: "group", id: o.id, tabs, active };
    }
    if (o.kind === "split" && (o.dir === "row" || o.dir === "column") && Array.isArray(o.children) && o.children.length >= 2) {
      const children = o.children.map(node);
      return children.every((c) => c !== null) ? { kind: "split", dir: o.dir, children: children as Node[] } : null;
    }
    return null;
  };
  const o = value as { root?: unknown; focus?: unknown } | null;
  const root = node(o?.root);
  if (!root) return null;
  const layout: Layout = { root, focus: typeof o?.focus === "string" ? o.focus : "" };
  return groups(layout).some((g) => g.id === layout.focus) ? layout : { ...layout, focus: groups(layout)[0].id };
}
