// Live preview: markdown shown as it reads, with the raw text back wherever you're working. A source
// finds, line by line, what to draw: widgets that stand in for text (a checkbox for "- [ ]"), marks and
// line styles. On any line the cursor or a selection touches, the widgets step aside and the raw text
// shows, so typing, Vim motions (w, e, f, x, visual) and selections only ever meet real characters.
import type { Extension, Line, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/** One thing to draw on a line, at document positions. */
export interface Preview {
  from: number;
  to: number;
  decoration: Decoration;
}

/** What to draw on one line. Called for visible lines only. */
export type PreviewSource = (line: Line, view: EditorView) => Preview[];

/** The lines the cursor or a selection is on, by number: they show raw text. */
export function revealedLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  const doc = view.state.doc;
  for (const r of view.state.selection.ranges) {
    for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) lines.add(n);
  }
  return lines;
}

function build(view: EditorView, source: PreviewSource): DecorationSet {
  const revealed = revealedLines(view);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const p of source(line, view)) {
        // A widget (a "point" decoration) stands in for text, so it's left out where the text shows.
        if (p.decoration.point && revealed.has(line.number)) continue;
        ranges.push(p.decoration.range(p.from, p.to));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

/** A live preview drawn from `source`, redrawn as the text, the scroll position or the cursor's line changes. */
export function livePreview(source: PreviewSource): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, source);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view, source);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
