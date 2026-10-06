import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undoDepth } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { insertUndo, sessionEffects } from "../web/src/extensions/vim/undo.ts";

/** A state with the insert session's history, and edits made a second apart (further than edits are joined otherwise). */
function editor(doc = "abc\n") {
  // As the app's editor has it (editor.ts): no time limit of the history's own on joining.
  let state = EditorState.create({ doc, extensions: [history({ newGroupDelay: Number.MAX_SAFE_INTEGER, joinToEvent: () => false }), insertUndo] });
  let time = 1_000_000;
  const go = (spec: TransactionSpec) => (state = state.update({ ...spec, annotations: [Transaction.time.of((time += 1000))] }).state);
  return {
    get state() {
      return state;
    },
    start: () => go({ effects: sessionEffects.start.of(undoDepth(state)) }),
    end: () => go({ effects: sessionEffects.end.of(null) }),
    type: (insert: string, userEvent = "input.type") => go({ changes: { from: state.doc.length - 1, insert }, userEvent }),
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
