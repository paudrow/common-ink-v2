// Geometry checks for test levers (docs/TESTING.md): what an eye catches when the page draws wrong, as
// data. Each returns the problems it finds, and none when the page is right. Browser tests assert on
// them, and agents can run them from the console or the probe CLI.
import type { EditorView } from "@codemirror/view";
import * as L from "../layout.ts";

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

const SLACK = 1;
const apart = (a: Rect, b: Rect) => a.right <= b.left + SLACK || b.right <= a.left + SLACK || a.bottom <= b.top + SLACK || b.bottom <= a.top + SLACK;
const within = (inner: Rect, outer: Rect) => inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;
const seen = (r: Rect) => r.width > 0 && r.height > 0;

function textRects(node: Node): Rect[] {
  const range = document.createRange();
  range.selectNodeContents(node);
  return [...range.getClientRects()].filter(seen);
}

const quote = (s: string | null | undefined) => `"${(s ?? "").replace(/\s+/g, " ").trim().slice(0, 50)}"`;

/**
 * Widgets drawn inside a line of text (task chips and checkboxes, list bullets and numbers, inline
 * math): none sits over the line's text or another widget, and a chip's text stays inside its box.
 */
export function overlaps(root: ParentNode = document): string[] {
  const problems: string[] = [];
  for (const line of root.querySelectorAll<HTMLElement>(".cm-line")) {
    const widgets = [...line.querySelectorAll<HTMLElement>('[contenteditable="false"]')].filter(
      (w) => !w.parentElement?.closest('[contenteditable="false"]') && seen(w.getBoundingClientRect()),
    );
    if (!widgets.length) continue;
    const boxes = widgets.map((w) => w.getBoundingClientRect());
    const name = (w: HTMLElement) => quote(w.textContent || w.getAttribute("aria-label") || w.className);
    widgets.forEach((w, i) => {
      // Chips are text in a box; math and pictures draw past their boxes on purpose.
      if (w.matches(".tk") && !textRects(w).every((t) => within(t, boxes[i]))) problems.push(`${name(w)} spills out of its box in ${quote(line.textContent)}`);
      for (let j = i + 1; j < widgets.length; j++) if (!apart(boxes[i], boxes[j])) problems.push(`${name(w)} overlaps ${name(widgets[j])} in ${quote(line.textContent)}`);
    });
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim() || n.parentElement?.closest('[contenteditable="false"]')) continue;
      for (const t of textRects(n)) widgets.forEach((w, i) => !apart(t, boxes[i]) && problems.push(`${name(w)} overlaps the text ${quote(n.textContent)}`));
    }
  }
  return problems;
}

/** Where a line's own text starts: past its indent, and a list marker and checkbox, a heading's #s or a quote's >. */
export function textStart(line: string): number {
  return /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s?)?/.exec(line)![0].length;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * How far each line's text moves sideways when the cursor comes onto it, for the lines given (1-based)
 * or every line on screen. A line that keeps its look as the cursor arrives doesn't move at all.
 */
export async function lineShift(view: EditorView, lines?: number[]): Promise<Array<{ line: number; text: string; dx: number }>> {
  const doc = view.state.doc;
  const numbers = lines ?? view.visibleRanges.flatMap(({ from, to }) => Array.from({ length: doc.lineAt(to).number - doc.lineAt(from).number + 1 }, (_, i) => doc.lineAt(from).number + i));
  const saved = view.state.selection;
  const out: Array<{ line: number; text: string; dx: number }> = [];
  for (const n of numbers) {
    const line = doc.line(n);
    const start = line.from + textStart(line.text);
    if (start >= line.to) continue;
    // Away: the line above, or below the first. Only sideways movement counts, so what that does to heights doesn't matter.
    const away = n > 1 ? doc.line(n - 1).from : n < doc.lines ? doc.line(n + 1).from : null;
    if (away === null) continue;
    view.dispatch({ selection: { anchor: away } });
    await frame();
    const before = view.coordsAtPos(start, 1);
    view.dispatch({ selection: { anchor: start } });
    await frame();
    const after = view.coordsAtPos(start, 1);
    if (before && after && Math.abs(after.left - before.left) > 0.5) out.push({ line: n, text: line.text.slice(0, 60), dx: Math.round((after.left - before.left) * 10) / 10 });
  }
  view.dispatch({ selection: saved });
  return out;
}

/** Each window takes the share of the workbench its layout gives it: none left at a split's old size after the split closed. */
export function layoutFill(layout: L.Layout, host: HTMLElement): string[] {
  const groups = L.groups(layout);
  const els = [...host.querySelectorAll<HTMLElement>("section.group")];
  if (els.length !== groups.length) return [`${els.length} windows on screen for ${groups.length} in the layout`];
  const area = host.getBoundingClientRect();
  // Too narrow for windows side by side, the focused one fills the area and the rest are kept, unseen.
  const shares = host.hasAttribute("data-no-splits") ? new Map(groups.map((g) => [g.id, g.id === layout.focus ? { w: 1, h: 1 } : { w: 0, h: 0 }])) : L.rects(layout.root);
  return groups.flatMap((g, i) => {
    const want = shares.get(g.id)!;
    const got = els[i].getBoundingClientRect();
    const off = Math.max(Math.abs(got.width / area.width - want.w), Math.abs(got.height / area.height - want.h));
    // Borders between windows take a few pixels of each share.
    return off > 0.03 ? [`Window ${g.id} fills ${Math.round((got.width / area.width) * 100)}% × ${Math.round((got.height / area.height) * 100)}% of the workbench; its layout gives it ${Math.round(want.w * 100)}% × ${Math.round(want.h * 100)}%`] : [];
  });
}
