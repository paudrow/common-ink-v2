// Vim's undo: one change is one step. A change that ends in insert mode (cw…, o…, A…, a visual block's
// I…, or . repeating one) is one step however slowly it's typed, from the command that started it to
// Esc. CodeMirror's history joins only quick edits side by side, so it would make the typing (and the
// deletion before it) several steps. Moving the cursor with the arrows inside insert mode still starts
// a new step, as in Vim. Someone else's change arriving meanwhile isn't in the history at all, so it's
// never part of yours.
import { history, undoDepth } from "@codemirror/commands";
import { EditorState, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** An insert session starts: its edits join the history's steps from this depth on. */
const start = StateEffect.define<number>();
const end = StateEffect.define<null>();

/** The history's depth when the command that went into insert mode began, while in insert mode. */
const session = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(start)) value = e.value;
      else if (e.is(end)) value = null;
    }
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
    const from = tr.startState.field(session, false);
    return from !== null && from !== undefined && undoDepth(tr.startState) > from;
  },
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

/** Told of Vim's mode: insert starts a session from the depth before the key that got there; any other ends it. */
export function modeChanged(view: EditorView, mode: string): void {
  const inSession = view.state.field(session, false) != null;
  if (mode === "insert" && !inSession) view.dispatch({ effects: start.of(beforeKey.get(view) ?? undoDepth(view.state)) });
  else if (mode !== "insert" && inSession) view.dispatch({ effects: end.of(null) });
}

/** The extension: before Vim's own keys, so each key's starting depth is known when Vim acts on it. */
export const insertUndo: Extension = [session, joinSession, quietCursor, keys];
