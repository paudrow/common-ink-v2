import assert from "node:assert/strict";
import { test } from "node:test";
import { history, historyField, redo, undo, undoDepth } from "@codemirror/commands";
import { Compartment, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { insertUndo, sessionEffects } from "../web/src/extensions/vim/undo.ts";

/** A state with the insert session's history, and edits made a second apart (further than edits are joined otherwise). */
function editor(doc = "abc\n") {
  // As the app's editor has it (editor.ts): no time limit of the history's own on joining, in a slot
  // of its own so it can start afresh.
  const own = history({ newGroupDelay: Number.MAX_SAFE_INTEGER, joinToEvent: () => false });
  const slot = new Compartment();
  let state = EditorState.create({ doc, extensions: [slot.of(own), insertUndo] });
  let time = 1_000_000;
  const go = (spec: TransactionSpec) => (state = state.update({ ...spec, annotations: [Transaction.time.of((time += 1000))] }).state);
  return {
    get state() {
      return state;
    },
    start: () => go({ effects: sessionEffects.start.of(undoDepth(state)) }),
    end: () => go({ effects: sessionEffects.end.of(null) }),
    type: (insert: string, userEvent = "input.type") => go({ changes: { from: state.doc.length - 1, insert }, userEvent }),
    undo: () => undo({ state, dispatch: (tr) => (state = tr.state) }),
    redo: () => redo({ state, dispatch: (tr) => (state = tr.state) }),
    forget: () => go({ effects: slot.reconfigure([own, historyField.init(() => EditorState.create({ extensions: history() }).field(historyField))]) }),
  };
}

test("in an insert session, Enter and a list continued are typing: the change is one undo step", () => {
  for (const enter of ["input", "input.list", "input.paste"]) {
    const e = editor();
    e.start();
    e.type("x");
    e.type("\n", enter);
    e.type("y");
    e.end();
    assert.equal(undoDepth(e.state), 1, enter);
  }
});

test("a task ticked or an embed's form used in insert mode is a step of its own, and the typing after it another", () => {
  for (const event of ["input.task", "delete.task", "input.embed", "input.replace"]) {
    const e = editor();
    e.start();
    e.type("x");
    e.type("[x]", event);
    e.type("y");
    e.end();
    assert.equal(undoDepth(e.state), 3, event);
  }
});

test("outside an insert session, edits a second apart are steps of their own", () => {
  const e = editor();
  e.type("x");
  e.type("\n", "input");
  e.type("y");
  assert.equal(undoDepth(e.state), 3);
});

test("the history started afresh in the middle of an insert session: the rest of that session is one undo step", () => {
  const e = editor();
  e.type("a");
  e.start();
  e.type("x");
  e.forget();
  e.type("y");
  e.type("z");
  e.end();
  assert.equal(undoDepth(e.state), 1);
});

test("in an insert session, an earlier change undone and redone isn't joined to the typing after it", () => {
  const e = editor();
  e.type("P");
  e.start();
  e.undo();
  e.redo();
  e.type("x");
  e.type("y");
  e.end();
  e.undo();
  assert.equal(e.state.doc.toString(), "abcP\n");
});

test("in an insert session, the typing after an undo past where it began is one step", () => {
  const e = editor();
  e.type("P");
  e.start();
  e.undo();
  e.type("x");
  e.type("y");
  e.end();
  assert.equal(e.state.doc.toString(), "abcxy\n");
  e.undo();
  assert.equal(e.state.doc.toString(), "abc\n");
});
