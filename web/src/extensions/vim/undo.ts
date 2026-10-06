// Vim's undo: one change is one step. A change that ends in insert mode (cw…, o…, A…, a visual block's
// I…, or . repeating one) is one step however slowly it's typed, from the command that started it to
// Esc. CodeMirror's history joins only quick edits side by side, so it would make the typing (and the
// deletion before it) several steps. Moving the cursor with the arrows inside insert mode still starts
// a new step, as in Vim. Someone else's change arriving meanwhile isn't in the history at all, so it's
// never part of yours.
import { history, undoDepth } from "@codemirror/commands";
import { EditorState, StateEffect, StateField, Transaction, type Annotation, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** An insert session starts: its edits join the history's steps from this depth on. */
const start = StateEffect.define<number>();
const end = StateEffect.define<null>();

/**
 * An edit in insert mode that isn't typing: a task ticked, an embed's form, a note's text replaced, a
 * drop. Vim starts a new step for what isn't typed, so it's a step of its own, and the typing after it
 * starts another.
 */
const notTyping = (tr: Transaction) => ["input.task", "delete.task", "input.embed", "input.replace", "move"].some((e) => tr.isUserEvent(e));

/** While in insert mode: the history's depth when the command that went into it began, and whether the last edit wasn't typing. */
const session = StateField.define<{ from: number; broke: boolean } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(start)) value = { from: e.value, broke: false };
      else if (e.is(end)) value = null;
    }
    if (value && tr.docChanged && tr.annotation(Transaction.addToHistory) !== false) value = { ...value, broke: notTyping(tr) };
    return value;
  },
});

/** The depth before each key, for the command that key runs: `c` deletes before insert mode starts. */
const beforeKey = new WeakMap<EditorView, number>();

/**
 * Join the session's edits: an edit in insert mode joins the step before it when that step was made
 * since the session's command began.
 */
const joinSession = history({
  joinToEvent: (tr) => {
    const now = tr.startState.field(session, false);
    return !!now && !now.broke && !notTyping(tr) && undoDepth(tr.startState) > now.from;
  },
});

/** The kinds of edit CodeMirror's history joins at all: anything else (Enter's "input", a list's "input.list") never is. */
const JOINABLE = /^(input\.type|delete)($|\.)/;

/**
 * Typing in insert mode that the history wouldn't join because of its kind (Enter, a list continued,
 * a paste) is told as typing: "input" becomes "input.type", "input.list" "input.type.list". It's still
 * an "input" to anything that asks, such as a list's renumbering.
 */
const asTyping = EditorState.transactionFilter.of((tr) => {
  const event = tr.annotation(Transaction.userEvent);
  if (!event || !tr.docChanged || JOINABLE.test(event) || !/^input($|\.)/.test(event) || notTyping(tr)) return tr;
  if (tr.startState.field(session, false) == null || tr.annotation(Transaction.addToHistory) === false) return tr;
  // A transaction's annotations aren't in its typings; every one but its kind is kept.
  const others = ((tr as unknown as { annotations: readonly Annotation<unknown>[] }).annotations ?? []).filter((a) => a.type !== Transaction.userEvent);
  return {
    changes: tr.changes,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: [...others, Transaction.userEvent.of(`input.type${event.slice("input".length)}`)],
  };
});

/**
 * Vim moves the cursor as it goes into insert mode (and back out), which the history would keep as a
 * stop between the deletion and the typing. Only the cursor moves you make (arrows, clicks) are kept.
 */
const quietCursor = EditorState.transactionFilter.of((tr) => {
  const inSession = tr.startState.field(session, false) != null;
  if (!inSession || tr.docChanged || !tr.selection || tr.annotation(Transaction.userEvent)) return tr;
  return [tr, { annotations: Transaction.addToHistory.of(false) }];
});

const keys = EditorView.domEventHandlers({
  keydown: (_e, view) => {
    beforeKey.set(view, undoDepth(view.state));
    return false;
  },
});

/** For tests: start or end an insert session as Vim's mode change would, from this history depth. */
export const sessionEffects = { start, end };

/** Told of Vim's mode: insert starts a session from the depth before the key that got there; any other ends it. */
export function modeChanged(view: EditorView, mode: string): void {
  const inSession = view.state.field(session, false) != null;
  if (mode === "insert" && !inSession) view.dispatch({ effects: start.of(beforeKey.get(view) ?? undoDepth(view.state)) });
  else if (mode !== "insert" && inSession) view.dispatch({ effects: end.of(null) });
}

/** The extension: before Vim's own keys, so each key's starting depth is known when Vim acts on it. */
export const insertUndo: Extension = [session, joinSession, quietCursor, asTyping, keys];
