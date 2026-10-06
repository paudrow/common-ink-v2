import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
// CodeMirror needs a page around it; Node's own navigator stays.
Object.assign(globalThis, { window, document: window.document, MutationObserver: window.MutationObserver, requestAnimationFrame: (f: () => void) => setTimeout(f, 0), getComputedStyle: window.getComputedStyle });

const { EditorView } = await import("@codemirror/view");
const { EditorSelection } = await import("@codemirror/state");
const { createState, replaceText } = await import("../web/src/editor.ts");
const { DEFAULTS } = await import("../worker/src/settings.ts");

test("text from the server lands line by line, and the cursor stays on the line it was on", () => {
  const view = new EditorView({ state: createState("one\ntwo\nthree\nfour\n", { json: false, readOnly: false, settings: DEFAULTS, extensions: [], onUpdate: () => {}, onBlur: () => {} }), parent: document.body });
  const pos = view.state.doc.line(3).from + 2;
  view.dispatch({ selection: EditorSelection.cursor(pos) });
  replaceText(view, "ONE\nadded\ntwo\nthree\nfour\n", true);
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  assert.equal(line.text, "three");
  assert.equal(head - line.from, 2);
  assert.equal(view.state.doc.toString(), "ONE\nadded\ntwo\nthree\nfour\n");
  view.destroy();
});

test("a change from the server to one line of a long note with many blank lines lands at once", () => {
  const lines = Array.from({ length: 20_000 }, (_, i) => (i % 10 === 8 ? "" : `- item ${i}`));
  const view = new EditorView({ state: createState(lines.join("\n"), { json: false, readOnly: false, settings: DEFAULTS, extensions: [], onUpdate: () => {}, onBlur: () => {} }), parent: document.body });
  const next = [...lines];
  next[10_000] = "- item 10000, changed";
  const start = performance.now();
  replaceText(view, next.join("\n"), true);
  const took = performance.now() - start;
  assert.equal(view.state.doc.line(10_001).text, "- item 10000, changed");
  assert.equal(view.state.doc.toString(), next.join("\n"));
  assert.ok(took < 1000, `took ${Math.round(took)}ms`);
  view.destroy();
});
