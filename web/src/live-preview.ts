// Live preview: markdown shown as it reads, with the raw text back wherever you're working. A source
// finds, line by line, what to draw: widgets that stand in for text (a checkbox for "- [ ]"), marks and
// line styles. On any line the cursor or a selection touches, the widgets step aside and the raw text
// shows, so typing, Vim motions (w, e, f, x, visual) and selections only ever meet real characters.
// A block preview stands in for whole lines (a table, display math, an embed) the same way: anywhere
// in it, the cursor brings back its raw text.
import { Facet, StateField, type EditorState, type Extension, type Line, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate, type WidgetType } from "@codemirror/view";

/** One thing to draw on a line, at document positions. */
export interface Preview {
  from: number;
  to: number;
  decoration: Decoration;
}

/** What to draw on one line. Called for visible lines only. */
export type PreviewSource = (line: Line, view: EditorView) => Preview[];

/** Whether live previews draw at all: the "editor.livePreview" setting. Off, every line is raw text. */
export const previewEnabled = Facet.define<boolean, boolean>({ combine: (values) => values.at(-1) ?? true });

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
  if (!view.state.facet(previewEnabled)) return Decoration.none;
  const revealed = revealedLines(view);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const p of source(line, view)) {
        // What stands in for text (a widget, or hidden markers) is left out where the text shows. A
        // line's own style (a code block's, a quote's) stays, so the line doesn't jump as the cursor comes.
        if (revealed.has(line.number) && (p.from < p.to || p.decoration.spec.widget)) continue;
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
        const switched = u.startState.facet(previewEnabled) !== u.state.facet(previewEnabled);
        // The parser finishing more of a long note counts too: sources may read its syntax tree.
        const parsed = syntaxTree(u.startState) !== syntaxTree(u.state);
        // Settings applied (a reconfiguration) can change what a source draws, so they redraw too.
        const reconfigured = u.transactions.some((tr) => tr.reconfigured);
        // So can state a source keeps (a code block's Wrap), changed by an effect.
        const effects = u.transactions.some((tr) => tr.effects.length > 0);
        if (u.docChanged || u.viewportChanged || u.selectionSet || switched || parsed || reconfigured || effects) this.decorations = build(u.view, source);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** A widget that stands in for whole lines, from the start of `from`'s line to the end of `to`'s. */
export interface BlockPreview {
  from: number;
  to: number;
  widget: WidgetType;
}

/** What to draw as blocks, over the whole document. */
export type BlockPreviewSource = (state: EditorState) => BlockPreview[];

function buildBlocks(state: EditorState, source: BlockPreviewSource): DecorationSet {
  if (!state.facet(previewEnabled)) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const b of source(state)) {
    const from = state.doc.lineAt(b.from).from;
    const to = state.doc.lineAt(b.to).to;
    // The cursor or a selection anywhere in it, or touching it, shows the raw text.
    if (state.selection.ranges.some((r) => r.from <= to && r.to >= from)) continue;
    ranges.push(Decoration.replace({ widget: b.widget, block: true }).range(from, to));
  }
  return Decoration.set(ranges, true);
}

/** Block previews drawn from `source`, redrawn as the text, the cursor or the parse changes. */
export function blockPreview(source: BlockPreviewSource): Extension {
  // Widgets that replace line breaks have to come from state, not a view plugin.
  return StateField.define<DecorationSet>({
    create: (state) => buildBlocks(state, source),
    update: (blocks, tr) =>
      tr.docChanged || tr.selection || tr.reconfigured || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? buildBlocks(tr.state, source) : blocks,
    provide: (field) => EditorView.decorations.from(field),
  });
}
