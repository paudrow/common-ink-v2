import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
// CodeMirror needs a page around it; Node's own navigator stays.
Object.assign(globalThis, {
  window,
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
});

const { EditorView } = await import("@codemirror/view");
const { EditorSelection } = await import("@codemirror/state");
const { todosPreview, CHECKED_FOR_MS } = await import("../web/src/plugins/todos/widgets.ts");

const TODAY = "2026-10-04";
const NOTE = ["# Chores", "- [ ] Call mum due:2026-10-05", "- [ ] Water the plants due:2026-10-04 every:3days", "- [x] Fix the bike light", "Some text"].join("\n");

function editor(doc = NOTE) {
  const view = new EditorView({ doc, extensions: [todosPreview(() => TODAY)], parent: document.body });
  return view;
}

const boxes = (view: InstanceType<typeof EditorView>) => [...view.contentDOM.querySelectorAll<HTMLElement>(".todo-box")];
const press = (el: HTMLElement) => el.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
const lineText = (view: InstanceType<typeof EditorView>, n: number) => view.state.doc.line(n).text;

test("todos show as checkboxes and chips, except on the line the cursor is on, which shows its text", () => {
  const view = editor();
  assert.equal(view.state.selection.main.head, 0, "the cursor starts on the heading");
  assert.deepEqual(
    boxes(view).map((b) => b.getAttribute("aria-checked")),
    ["false", "false", "true"],
  );
  assert.deepEqual(
    [...view.contentDOM.querySelectorAll(".todo-chip")].map((c) => c.textContent),
    ["Tomorrow", "Today", "↻ every 3 days"],
  );
  assert.ok(view.contentDOM.querySelector(".cm-todo-done .cm-todo-done-text"), "a done todo is muted and struck through");
  // Move to Call mum's line: its raw text shows, and the others keep their widgets.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 8 } });
  assert.equal(boxes(view).length, 2);
  assert.match(view.contentDOM.querySelectorAll(".cm-line")[1].textContent!, /^- \[ \] Call mum due:2026-10-05$/);
  view.destroy();
});

test("pressing a checkbox checks the todo off as one edit, without moving the cursor or taking focus", () => {
  const view = editor();
  const cursor = view.state.doc.line(5).from + 2;
  view.dispatch({ selection: { anchor: cursor } });
  assert.equal(view.hasFocus, false);
  press(boxes(view)[0]);
  assert.equal(lineText(view, 2), "- [x] Call mum due:2026-10-05");
  assert.equal(view.state.selection.main.head, cursor);
  assert.equal(view.hasFocus, false);
  assert.equal(boxes(view)[0].getAttribute("aria-checked"), "true");
  press(boxes(view)[0]);
  assert.equal(lineText(view, 2), "- [ ] Call mum due:2026-10-05", "and back on");
  view.destroy();
});

test("a recurring todo shows checked for a moment, then moves to its next due date on the same line", async () => {
  const view = editor();
  const before = view.state.doc.lines;
  const box = boxes(view)[1];
  press(box);
  assert.equal(box.getAttribute("aria-checked"), "true");
  assert.equal(lineText(view, 3), "- [ ] Water the plants due:2026-10-04 every:3days", "not yet");
  await new Promise((r) => setTimeout(r, CHECKED_FOR_MS + 50));
  assert.equal(lineText(view, 3), "- [ ] Water the plants due:2026-10-07 every:3days");
  assert.equal(view.state.doc.lines, before, "no line added");
  assert.equal(boxes(view)[1].getAttribute("aria-checked"), "false");
  assert.equal(view.contentDOM.querySelectorAll(".todo-chip")[1].textContent, "Wed");
  view.destroy();
});

test("pressing a chip puts the cursor on its text, which then shows raw", () => {
  const view = editor();
  const chip = view.contentDOM.querySelector<HTMLElement>(".todo-chip")!;
  press(chip);
  const line = view.state.doc.line(2);
  assert.equal(view.state.selection.main.head, line.from + line.text.indexOf("due:"));
  assert.equal(view.contentDOM.querySelectorAll(".cm-line")[1].querySelector(".todo-chip"), null);
  view.destroy();
});

test("a selection across lines shows them all raw", () => {
  const view = editor();
  view.dispatch({ selection: EditorSelection.single(view.state.doc.line(2).from, view.state.doc.line(3).to) });
  assert.equal(boxes(view).length, 1, "only the done todo, outside the selection, is drawn");
  view.destroy();
});
