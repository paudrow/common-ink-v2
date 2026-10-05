// Task edits in the editor, and what the editor offers on a task line. An edit is the task line
// rewritten by the token writer, as a transaction, so it lands in the undo history like typing does.
// Phrases quick-add would read ("tomorrow", "every week") are only marked on the cursor's task line;
// Tab or a click turns them into tokens.
// No DOM here: the widgets that draw these are in widgets.ts.
import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type WidgetType } from "@codemirror/view";
import { parseQuickAdd, type QuickKind } from "./quickadd.ts";
import { editTaskLine, localDate, parseTask, patchProblem, TASK_LINE, type TaskPatch } from "./tasks.ts";

/**
 * The change that applies `patch` to the task on line `n`, or null if nothing would change. Throws
 * if the line is no longer `expected` (the note changed while the chip's editor was open), or if the
 * patch can't be written as tokens.
 */
export function taskLineEdit(state: EditorState, n: number, expected: string, patch: TaskPatch, today = localDate(Date.now())): TransactionSpec | null {
  const line = n <= state.doc.lines ? state.doc.line(n) : null;
  if (!line || line.text !== expected) throw new Error("That task changed while you were editing it. Click its chip again.");
  const problem = patchProblem(patch);
  if (problem) throw new Error(problem);
  const next = editTaskLine(line.text, patch, today);
  if (next === line.text) return null;
  return { changes: { from: line.from, to: line.to, insert: next }, userEvent: "input.task" };
}

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "HTMLBlock", "CommentBlock"]);
const inCode = (state: EditorState, pos: number) => {
  for (let n: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent as typeof n) if (CODE.has(n.name)) return true;
  return false;
};

/** Whether `pos` is in a task's text: on a task line, past its checkbox, and not in code. */
export function inTaskText(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const m = line.text.match(TASK_LINE);
  return !!m && pos >= line.to - m[4].length && !inCode(state, pos);
}

/** Whether the line at `from` is a task line outside code (its tokens draw as chips). */
export const isTaskLine = (state: EditorState, from: number) => TASK_LINE.test(state.doc.lineAt(from).text) && !inCode(state, from);

export type HintField = "due" | "rec" | "assignees" | "tags" | "priority";
/** The hint's words, in the order they show, and the field each one's editor sets. */
export const HINTS: Array<[string, HintField]> = [
  ["due", "due"],
  ["repeat", "rec"],
  ["@", "assignees"],
  ["#", "tags"],
  ["!", "priority"],
];

/**
 * Where the task line's tools go: the end of the line the cursor is on, if it's a task (and the
 * editor takes edits). `missing` is the fields the task doesn't have yet, which the hint offers.
 */
export function taskToolsAt(state: EditorState): { line: number; pos: number; missing: HintField[] } | null {
  const { head, anchor } = state.selection.main;
  const line = state.doc.lineAt(head);
  if (state.readOnly || state.doc.lineAt(anchor).number !== line.number || !inTaskText(state, line.to)) return null;
  const m = parseTask(line.text)!.meta;
  const has: Record<HintField, boolean> = { due: !!m.due, rec: !!m.rec, assignees: m.assignees.length > 0, tags: m.tags.length > 0, priority: !!m.priority };
  return { line: line.number, pos: line.to, missing: HINTS.map(([, f]) => f).filter((f) => !has[f]) };
}

/** The task line's tools as a decoration at the end of the cursor's line: drawn, never part of the document. */
export function taskTools(widget: (missing: HintField[]) => WidgetType) {
  const build = (state: EditorState): DecorationSet => {
    const at = taskToolsAt(state);
    return at ? Decoration.set([Decoration.widget({ widget: widget(at.missing), side: 1 }).range(at.pos)]) : Decoration.none;
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) => (tr.docChanged || tr.selection || tr.startState.readOnly !== tr.state.readOnly ? build(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * The phrases quick-add would read on the cursor's task line ("tomorrow", "every week"), where they
 * are in the document. They're only marked (a dotted underline): nothing changes until Tab or a
 * click turns them into tokens (convertPhrases). Null off a task line, or in code.
 */
export function phrasesAt(state: EditorState, today: string): { line: number; phrases: Array<{ from: number; to: number; kind: QuickKind; token: string }> } | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const m = line.text.match(TASK_LINE);
  if (!m || state.readOnly || !inTaskText(state, line.to)) return null;
  const at = line.to - m[4].length;
  const q = parseQuickAdd(m[4], today, [], { targets: false });
  return q.spans.length ? { line: line.number, phrases: q.spans.map((s) => ({ from: at + s.from, to: at + s.to, kind: s.kind, token: s.token })) } : null;
}

/** The dotted underline under the cursor's task line's phrases, titled with what each would become. */
export function taskPhrases(today: () => string = () => localDate(Date.now())) {
  const build = (state: EditorState): DecorationSet => {
    const at = phrasesAt(state, today());
    return at ? Decoration.set(at.phrases.map((p) => Decoration.mark({ class: `cm-phrase is-${p.kind}`, attributes: { title: `Tab or click: ${p.token}` } }).range(p.from, p.to))) : Decoration.none;
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) => (tr.docChanged || tr.selection || tr.startState.readOnly !== tr.state.readOnly ? build(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}

/**
 * What Tab does on a task line with phrases: with the cursor in one, or just after it (a space
 * after counts), it turns the line's phrases into tokens. Null anywhere else, so Tab does what it would.
 */
export function phraseTab(state: EditorState, today: string): TransactionSpec | null {
  const at = phrasesAt(state, today);
  const head = state.selection.main.head;
  const touching = at?.phrases.some((p) => (head > p.from && head <= p.to) || (head === p.to + 1 && state.sliceDoc(p.to, head) === " "));
  return at && touching && state.selection.main.empty ? convertPhrases(state, at.line, today) : null;
}

/**
 * Turn the phrases on task line `n` into tokens (just `only`, the one clicked, if given), as one
 * transaction: the checkbox, its indent and the rest of the line stay. Null if there's nothing to turn.
 */
export function convertPhrases(state: EditorState, n: number, today: string, only?: string): TransactionSpec | null {
  const line = state.doc.line(n);
  const m = line.text.match(TASK_LINE);
  if (!m || !inTaskText(state, line.to)) return null;
  const read = parseQuickAdd(m[4], today, [], { targets: false });
  const keep = only === undefined ? [] : read.spans.map((s) => m[4].slice(s.from, s.to)).filter((p) => p.toLowerCase() !== only.toLowerCase());
  if (!read.spans.length || keep.length === read.spans.length) return null;
  const text = parseQuickAdd(m[4], today, keep, { targets: false }).line.match(TASK_LINE)![4];
  return { changes: { from: line.to - m[4].length, to: line.to, insert: text }, userEvent: "input.task" };
}
