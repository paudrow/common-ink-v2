// Dragging things into windows. Anything that opens in a window drags the same way: as an Openable (a
// file or a view), plus where it came from when it's a tab, so dropping it moves the tab.
import type { Direction, GroupId, Openable } from "./layout.ts";

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

/** What's being dragged, if it's ours. */
export function dragged(e: DragEvent): Dragged | null {
  if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return null;
  const data = e.dataTransfer.getData(DRAG_TYPE);
  if (!data) return current;
  try {
    return JSON.parse(data) as Dragged;
  } catch {
    return current;
  }
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
