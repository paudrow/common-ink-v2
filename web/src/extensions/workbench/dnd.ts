// Dragging things into windows. Anything that opens in a window drags the same way: as an Openable (a
// file or a view), plus where it came from when it's a tab, so dropping it moves the tab.
import { isNote, parseFilePath } from "common-ink/files";
import type { Direction, GroupId, Openable } from "common-ink/layout";

export const DRAG_TYPE = "application/x-common-ink-openable";

export interface Dragged {
  item: Openable;
  /** The tab being dragged, if it's a tab: dropping it moves it rather than opening a copy. */
  from?: { group: GroupId; index: number };
}

// Browsers only show what's being dragged on drop, so the zones shown while dragging read it from here.
let current: Dragged | null = null;

export function startDrag(e: DragEvent, dragged: Dragged, label: string): void {
  current = dragged;
  e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(dragged));
  // Dropped outside the app, it's just its name.
  e.dataTransfer?.setData("text/plain", label);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = dragged.from ? "move" : "copyMove";
}

export function endDrag(): void {
  current = null;
}

/**
 * Whether a drag is one a window takes: one of this page's, or one marked as ours from outside it.
 * While dragging, a browser shows what's dragged in from outside only on drop, so that's when it's read.
 */
export function droppable(e: DragEvent): boolean {
  return !!current || !!e.dataTransfer?.types.includes(DRAG_TYPE);
}

/**
 * What's being dragged, if it's ours. One of this page's is what it started (a tab moves). One from
 * outside the page, another window of the app or any other site, says what it is in data anyone can
 * write: a note in this workspace is all it may open, never a tab to move, a view, or a settings or
 * code file.
 */
export function dragged(e: DragEvent): Dragged | null {
  if (current) return current;
  if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return null;
  let item: unknown;
  try {
    item = (JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { item?: unknown } | null)?.item;
  } catch {
    return null;
  }
  const file = item && typeof item === "object" ? parseFilePath((item as { file?: unknown }).file) : null;
  return file && isNote(file) && !file.startsWith(".common-ink/") ? { item: { file } } : null;
}

export type Zone = Direction | "center";

/** Where in a window a drop lands: a quarter-width or -height band along an edge splits that way; the rest is the center. */
export function dropZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Zone {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const edges: Array<[Direction, number]> = [
    ["left", fx],
    ["right", 1 - fx],
    ["up", fy],
    ["down", 1 - fy],
  ];
  const [side, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  return distance < 0.25 ? side : "center";
}

/** Where in a tab bar a drop lands: before the first tab whose middle is right of the pointer. */
export function tabIndexAt(tabs: Array<{ left: number; width: number }>, x: number): number {
  const i = tabs.findIndex((t) => x < t.left + t.width / 2);
  return i < 0 ? tabs.length : i;
}
