// The list edits (model.ts) applied to an editor: on the items the cursor or selection is on, as one
// change that undo takes back whole, with the cursor kept on its item, where it was in the text.
import { codeFolding, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as M from "./model.ts";

const linesOf = (state: EditorState) => state.doc.toString().split("\n");

/**
 * The change that turns the note's lines into `next` (which has as many lines), as one replacement of
 * the lines that differ. Null if none do.
 */
export function changeFor(state: EditorState, next: readonly string[]): { from: number; to: number; insert: string } | null {
  const old = linesOf(state);
  if (old.length !== next.length) return { from: 0, to: state.doc.length, insert: next.join("\n") };
  let a = 0;
  while (a < old.length && old[a] === next[a]) a++;
  if (a === old.length) return null;
  let b = old.length - 1;
  while (b > a && old[b] === next[b]) b--;
  return { from: state.doc.line(a + 1).from, to: state.doc.line(b + 1).to, insert: next.slice(a, b + 1).join("\n") };
}

/**
 * Where the cursor was: its line, and how far into the line's text (past its indent) it was. Over a
 * selection (Vim's >> selects the line, and the next line's start), it's the first selected line's first
 * character, as Vim leaves it.
 */
function cursorOf(state: EditorState) {
  const { head, from, empty } = state.selection.main;
  const line = state.doc.lineAt(empty ? head : from);
  const indent = /^[ \t]*/.exec(line.text)![0].length;
  return { line: line.number - 1, offset: empty ? head - line.from - indent : 0 };
}

/** The cursor put back on line `line` of `lines`, as far into its text as it was. */
function cursorAt(lines: readonly string[], line: number, offset: number): number {
  let pos = 0;
  for (let i = 0; i < line; i++) pos += lines[i].length + 1;
  const indent = /^[ \t]*/.exec(lines[line])![0].length;
  return pos + Math.min(Math.max(indent + offset, 0), lines[line].length);
}

/** Apply new lines to the editor, with the cursor on `line` (offset as it was). */
function apply(view: EditorView, next: readonly string[], line: number, offset: number): boolean {
  const changes = changeFor(view.state, next);
  if (!changes) return true;
  view.dispatch({ changes, selection: EditorSelection.cursor(cursorAt(next, line, offset)), scrollIntoView: true, userEvent: "input.list" });
  return true;
}

/** The selected lines' range, by line index. A selection that ends at the start of a line (a whole line, as Vim's >> makes) doesn't take that line. */
function selectedLines(state: EditorState) {
  const { from, to } = state.selection.main;
  const first = state.doc.lineAt(from).number - 1;
  const end = state.doc.lineAt(to);
  return { first, last: Math.max(first, end.number - 1 - (to === end.from && to > from ? 1 : 0)) };
}

/** Whether every line with text in the range is in a list item: a range that isn't (>ip over a paragraph and a list) shifts as text. */
const allInItems = (lines: readonly string[], first: number, last: number) => lines.slice(first, last + 1).every((l, i) => M.isBlank(l) || M.itemAt(lines, first + i) !== null);

/** Says, quietly, why an edit didn't happen. */
export type Say = (why: string) => void;

/**
 * Indent the items on the selected lines, with their children, as Workflowy does: each goes under the
 * item above it at its level, one level deeper and no more. The first item of a list, or the first child
 * under a parent, has nothing above to nest under, so it stays; and if the first selected item can't
 * indent, none of them do, so a selection moves as a block or not at all. False if no line is in an item.
 */
export function indentItems(view: EditorView, say: Say = () => {}): boolean {
  let lines = linesOf(view.state);
  const { first, last } = selectedLines(view.state);
  const items = M.itemsIn(lines, first, last);
  if (!items.length || !allInItems(lines, first, last)) return false;
  if (!M.indent(lines, items[0])) {
    say("Can't indent: nothing above to nest under");
    return true;
  }
  const cursor = cursorOf(view.state);
  // Top down: the first goes under the one above it, and the rest join it there as its siblings.
  for (const i of items) lines = M.indent(lines, i)?.lines ?? lines;
  return apply(view, lines, cursor.line, cursor.offset);
}

/** Dedent the items on the selected lines out of their parents, as an outliner does. One at the top stays. */
export function dedentItems(view: EditorView, say: Say = () => {}): boolean {
  let lines = linesOf(view.state);
  const { first, last } = selectedLines(view.state);
  const items = M.itemsIn(lines, first, last);
  if (!items.length || !allInItems(lines, first, last)) return false;
  if (items.every((i) => !M.dedent(lines, i))) {
    say("Can't dedent: it's already at the top");
    return true;
  }
  const cursor = cursorOf(view.state);
  const own = M.itemAt(lines, cursor.line) ?? items[0];
  const within = cursor.line - own;
  let at = own;
  // Bottom up, so each keeps its order after its parent.
  for (const i of [...items].reverse()) {
    const edit = M.dedent(lines, i);
    if (!edit) continue;
    if (i === own) at = edit.at;
    else if (i > own && edit.at <= at) at += M.subtreeEnd(edit.lines, edit.at) - edit.at;
    lines = edit.lines;
  }
  return apply(view, lines, at + within, cursor.offset);
}

/** Move the cursor's item, with its children, past its sibling above (-1) or below (1). */
export function moveItem(view: EditorView, by: -1 | 1): boolean {
  const lines = linesOf(view.state);
  const cursor = cursorOf(view.state);
  const i = M.itemAt(lines, cursor.line);
  if (i === null) return false;
  const edit = by < 0 ? M.moveUp(lines, i) : M.moveDown(lines, i);
  if (!edit) return true;
  return apply(view, edit.lines, edit.at + (cursor.line - i), cursor.offset);
}

/** Make the items on the selected lines bullets, numbered or tasks. */
export function convertItems(view: EditorView, kind: M.Kind): boolean {
  const lines = linesOf(view.state);
  const { first, last } = selectedLines(view.state);
  const cursor = cursorOf(view.state);
  const at = M.itemAt(lines, first);
  const next = M.convert(lines, at !== null && at < first ? at : first, last, kind);
  // The cursor stays on its text: past the marker, which may have changed width.
  const was = M.parseItem(lines[cursor.line]);
  const now = M.parseItem(next[cursor.line]);
  const offset = was && now ? cursor.offset + (now.contentStart - now.indent) - (was.contentStart - was.indent) : cursor.offset;
  return apply(view, next, cursor.line, offset);
}

/** Enter on an item with nothing in it: it moves out a level, or, at the top, stops being an item. */
export function enterOnEmptyItem(view: EditorView): boolean {
  const sel = view.state.selection;
  if (sel.ranges.length > 1 || !sel.main.empty) return false;
  const lines = linesOf(view.state);
  const line = view.state.doc.lineAt(sel.main.head).number - 1;
  if (!M.isEmptyItem(lines[line])) return false;
  const out = M.dedent(lines, line);
  if (out && M.parentOf(lines, line) !== null) return apply(view, out.lines, out.at, Number.MAX_SAFE_INTEGER);
  const next = [...lines];
  next[line] = "";
  return apply(view, M.renumberAround(next, [line]), line, 0);
}

/** The range folding item `i` hides: from the end of its line to the end of its last child. */
export function foldRangeOf(state: EditorState, i: number): { from: number; to: number } | null {
  const children = M.childrenRange(linesOf(state), i);
  return children ? { from: state.doc.line(i + 1).to, to: state.doc.line(children.to + 1).to } : null;
}

/** Whether item `i`'s children are folded away. */
export function isFolded(state: EditorState, i: number): boolean {
  const from = state.doc.line(i + 1).to;
  let found = false;
  foldedRanges(state).between(from, from, (a) => {
    if (a === from) found = true;
  });
  return found;
}

/** Fold item `i`'s children away, or bring them back. False if it has none. */
export function toggleFoldAt(view: EditorView, i: number): boolean {
  const range = foldRangeOf(view.state, i);
  if (!range) return false;
  view.dispatch({ effects: (isFolded(view.state, i) ? unfoldEffect : foldEffect).of(range) });
  return true;
}

/** Fold or unfold the cursor's item. */
export function toggleFold(view: EditorView): boolean {
  const lines = linesOf(view.state);
  const i = M.itemAt(lines, cursorOf(view.state).line);
  return i !== null && toggleFoldAt(view, i);
}

/** Folded children show as a quiet "…" after their item. */
export const folding = codeFolding({
  placeholderDOM: (_view, onclick) => {
    const more = document.createElement("span");
    more.className = "cm-list-folded";
    more.textContent = "…";
    more.title = "Folded: click to unfold";
    more.addEventListener("click", onclick);
    return more;
  },
});

/**
 * After an edit you make (typing, deleting, pasting), numbered lists near it are numbered in order
 * again, in the same undo step. Changes from the server are left as they are.
 */
export const renumberOnEdit = EditorState.transactionFilter.of((tr: Transaction): Transaction | readonly (Transaction | TransactionSpec)[] => {
  if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
  const doc = tr.newDoc;
  const touched: number[] = [];
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) touched.push(n - 1);
  });
  // Only when a numbered item is at or next to the change.
  const numbered = (n: number) => n >= 0 && n < doc.lines && /^\s*\d{1,9}[.)](\s|$)/.test(doc.line(n + 1).text);
  if (!touched.some((n) => numbered(n - 1) || numbered(n) || numbered(n + 1))) return tr;
  const lines = doc.toString().split("\n");
  const next = M.renumberAround(lines, touched);
  if (next.every((l, i) => l === lines[i])) return tr;
  const changes = changeFor(EditorState.create({ doc }), next)!;
  return [tr, { changes, sequential: true }];
});
