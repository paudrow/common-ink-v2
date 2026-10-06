// Live preview: markdown shown as it reads, with the raw text back wherever you're working. A source
// finds, line by line, what to draw: widgets that stand in for text (a checkbox for "- [ ]"), marks and
// line styles. Where the cursor or a selection is, the widgets step aside and the raw text shows, so
// typing, Vim motions (w, e, f, x, visual) and selections only ever meet real characters: on the whole
// line, or, for a preview that says which markup it belongs to (its span), only when that's touched.
// A line's layout (a list's hanging indent) can say it always stays, so the line never jumps.
// A block preview stands in for whole lines (a table, display math, an embed) the same way: anywhere
// in it, the cursor brings back its raw text.
import { EditorSelection, EditorState, Facet, Prec, StateField, type Extension, type Line, type Range, type StateCommand } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate, type WidgetType } from "@codemirror/view";

/** One thing to draw on a line, at document positions. */
export interface Preview {
  from: number;
  to: number;
  decoration: Decoration;
  /** The markup it stands for (a link, **bold**): it steps aside only when the cursor or a selection touches that, not the whole line. */
  span?: { from: number; to: number };
  /** Drawn even where the text shows: layout that keeps the line from moving (a list's indent and number column). */
  always?: boolean;
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

/** Whether the cursor or a selection is in or at the edge of a range. */
export const touches = (state: EditorState, span: { from: number; to: number }) => state.selection.ranges.some((r) => r.from <= span.to && r.to >= span.from);

function build(view: EditorView, source: PreviewSource): DecorationSet {
  if (!view.state.facet(previewEnabled)) return Decoration.none;
  const revealed = revealedLines(view);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      for (const p of source(line, view)) {
        // What stands in for text (a widget, or hidden markers) is left out where the text shows: the
        // markup it's for, when it says, or else the line. A line's own style (a code block's, a
        // quote's) stays, so the line doesn't jump as the cursor comes.
        const standsIn = p.from < p.to || !!p.decoration.spec.widget;
        const shown = p.span ? touches(view.state, p.span) : revealed.has(line.number);
        if (standsIn && shown && !p.always) continue;
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

/** Every block preview's decorations, for moving the cursor into them and keeping Backspace out of them. */
const blockFields = Facet.define<StateField<DecorationSet>>();

/**
 * A block preview collapses its lines into one widget, and vertical motion (j/k, the arrows) would
 * step straight over it. When a one-step move jumps over collapsed blocks, it lands on the first of
 * their lines going down, or the last going up, which shows that block's text to edit. A block that
 * ends the note (or starts it) has no line past it: the move lands inside it, and that's one step
 * too. A click lands where it was clicked. (Vim's j and k carry no user event, so this can't wait
 * for one.)
 */
/**
 * Whether the key being handled steps one line up or down (j, k, or an arrow, by the character typed).
 * Only such a step goes into a block at a note's very start or end: a G, a count, a search or a click
 * that lands there is where it was sent, though it looks the same as a transaction.
 */
let stepping = false;
const watchSteps = EditorView.domEventObservers({
  keydown(e) {
    stepping = ["j", "k", "ArrowDown", "ArrowUp"].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
    // Over once the key is handled: the move it makes comes while it is.
    queueMicrotask(() => (stepping = false));
  },
});

const stepIntoBlocks = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || tr.selection.ranges.length > 1 || tr.isUserEvent("select.pointer")) return tr;
  const start = tr.startState;
  const doc = start.doc;
  const a = doc.lineAt(start.selection.main.head).number;
  const b = doc.lineAt(tr.selection.main.head).number;
  if (a === b) return tr;
  const down = b > a;
  const [lo, hi] = down ? [a, b] : [b, a];
  let hidden = 0;
  let target: number | null = null;
  /** Whether the move landed inside a block that ends (or starts) the note. */
  let inside = false;
  for (const field of start.facet(blockFields)) {
    start.field(field, false)?.between(doc.line(lo).from, doc.line(hi).to, (from, to, d) => {
      if (!d.spec.block || from === to) return;
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(to).number;
      // Past it, or inside it when it ends the note (going down) or starts it (going up).
      const past = down ? first > a && last < b : last < a && first > b;
      const into = stepping && (down ? first > a && last === doc.lines && first <= b && last >= b : last < a && first === 1 && first <= b && last >= b);
      if (!past && !into) return;
      inside ||= into;
      hidden += Math.min(last, hi) - Math.max(first, lo) + 1;
      if (down) target = target === null ? doc.line(first).from : Math.min(target, doc.line(first).from);
      else target = target === null ? doc.line(last).from : Math.max(target, doc.line(last).from);
    });
  }
  // Only a one-step move: one visible line on, past blocks, or straight into a block at the note's end with
  // no line between. A jump further (G, gg, a count, a search) goes where it was sent.
  const plain = hi - lo - hidden;
  if (target === null || plain !== (inside ? 0 : 1)) return tr;
  const main = tr.selection.main;
  return [tr, { selection: EditorSelection.single(main.empty ? target : main.anchor, target), sequential: true }];
});

/** The collapsed block that line `n` is in, if it's in one now. */
export function collapsedBlockAt(state: EditorState, n: number): { from: number; to: number } | null {
  if (n < 1 || n > state.doc.lines) return null;
  const line = state.doc.line(n);
  let found: { from: number; to: number } | null = null;
  for (const field of state.facet(blockFields)) {
    state.field(field, false)?.between(line.from, line.to, (from, to, d) => {
      if (d.spec.block && from <= line.from && to >= line.to) found = { from, to };
    });
  }
  return found;
}

/**
 * Backspace at the start of the line after a collapsed block, or Delete at the end of the line before
 * one, would join that line onto the block's hidden text. Select the block's text instead: it shows,
 * and a second press deletes it. From an empty line the key works as usual.
 */
const selectBlock =
  (dir: -1 | 1): StateCommand =>
  ({ state, dispatch }) => {
    const sel = state.selection;
    if (sel.ranges.length > 1 || !sel.main.empty) return false;
    const here = state.doc.lineAt(sel.main.head);
    if (!here.length || sel.main.head !== (dir < 0 ? here.from : here.to)) return false;
    const block = collapsedBlockAt(state, here.number + dir);
    if (!block) return false;
    dispatch(state.update({ selection: { anchor: block.from, head: block.to }, scrollIntoView: true }));
    return true;
  };

const blockKeys = Prec.high(
  keymap.of([
    ...["Backspace", "Mod-Backspace", "Alt-Backspace"].map((key) => ({ key, run: selectBlock(-1) })),
    ...["Delete", "Mod-Delete", "Alt-Delete"].map((key) => ({ key, run: selectBlock(1) })),
  ]),
);

/** Block previews' measured heights, by what they show, so the editor places them right before they're drawn again. */
const heights = new Map<string, number>();

/** A block widget's height as last measured, for its `estimatedHeight`; `fallback` before it's been drawn. */
export const blockHeight = (key: string, fallback: number): number => heights.get(key) ?? fallback;

/**
 * Measure a block widget once it's on the page, for blockHeight. Its spacing must be padding, never a
 * margin: CodeMirror measures a block widget without its margins, and a height it gets wrong sends
 * the cursor past blocks when it moves up or down.
 */
export function measureBlock(key: string, dom: HTMLElement): void {
  requestAnimationFrame(() => {
    if (dom.isConnected) heights.set(key, dom.offsetHeight);
  });
}

/** Block previews drawn from `source`, redrawn as the text, the cursor or the parse changes. */
export function blockPreview(source: BlockPreviewSource): Extension {
  // Widgets that replace line breaks have to come from state, not a view plugin.
  const field = StateField.define<DecorationSet>({
    create: (state) => buildBlocks(state, source),
    update: (blocks, tr) =>
      tr.docChanged || tr.selection || tr.reconfigured || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? buildBlocks(tr.state, source) : blocks,
    provide: (f) => EditorView.decorations.from(f),
  });
  return [field, blockFields.of(field), stepIntoBlocks, watchSteps, blockKeys];
}
