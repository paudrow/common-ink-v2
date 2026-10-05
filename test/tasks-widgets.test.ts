import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { TaskEnv } from "../web/src/extensions/tasks/widgets.ts";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
// CodeMirror needs a page around it; Node's own navigator stays.
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  Window: window.Window,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
  innerWidth: 1200,
  innerHeight: 800,
});

// A chip's editor gives the note its focus back when it closes, and CodeMirror measures then: jsdom has no layout.
Object.assign(window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) });

const { EditorView } = await import("@codemirror/view");
const { EditorSelection } = await import("@codemirror/state");
const { undo, history } = await import("@codemirror/commands");
const { tasksPreview, CHECKED_FOR_MS } = await import("../web/src/extensions/tasks/widgets.ts");
const { dayPicks } = await import("../web/src/extensions/tasks/complete.ts");

const TODAY = "2026-10-04";
const NOTE = ["# Chores", "- [ ] Call mum due:2026-10-05 !high", "- [ ] Water the plants due:2026-10-04 rec:3d", "- [x] Fix the bike light done:2026-10-01", "Some text"].join("\n");

const said: string[] = [];
const env: TaskEnv = {
  today: () => TODAY,
  chips: () => true,
  people: async () => ["jane", "sam"],
  tags: async () => ["home"],
  showPerson: () => {},
  say: (m) => void said.push(m),
  path: () => "Chores.md",
};

function editor(doc = NOTE, e = env) {
  return new EditorView({ doc, extensions: [history(), tasksPreview(e)], parent: document.body });
}

type View = InstanceType<typeof EditorView>;
const boxes = (view: View) => [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-checkbox")];
const chips = (view: View, n?: number) => [...(n === undefined ? view.contentDOM : view.contentDOM.querySelectorAll(".cm-line")[n - 1]).querySelectorAll<HTMLElement>(".tk")].map((c) => c.textContent);
const press = (el: Element) => el.dispatchEvent(new window.MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
const click = (el: Element) => el.dispatchEvent(new window.MouseEvent("click", { button: 0, bubbles: true, cancelable: true }));
const lineText = (view: View, n: number) => view.state.doc.line(n).text;
const popover = () => document.querySelector<HTMLElement>(".chip-pop");

test("a task's box and each token draw where they're written; a token shows raw only while the cursor touches it", () => {
  const view = editor();
  assert.deepEqual(boxes(view).map((b) => b.getAttribute("aria-checked")), ["false", "false", "true"]);
  assert.deepEqual(chips(view, 2), ["Tomorrow", "High"]);
  assert.deepEqual(chips(view, 3), ["Today", "Every 3 days"]);
  assert.ok(view.contentDOM.querySelectorAll(".cm-line")[3].querySelector(".cm-task-done"), "a done task is muted and struck through");
  // On Call mum's words, its box and chips stay: the line reads as it did.
  const call = view.state.doc.line(2);
  view.dispatch({ selection: { anchor: call.from + 8 } });
  assert.equal(boxes(view).length, 3);
  assert.deepEqual(chips(view, 2), ["Tomorrow", "High"]);
  // On its date, the date is its markdown.
  view.dispatch({ selection: { anchor: call.from + call.text.indexOf("due:") + 2 } });
  assert.deepEqual(chips(view, 2), ["High"]);
  assert.match(view.contentDOM.querySelectorAll(".cm-line")[1].textContent!, /due:2026-10-05/);
  view.destroy();
});

test("the cursor's task line ends with its ⚙ and a hint of the fields it doesn't have", () => {
  const view = editor();
  assert.equal(view.contentDOM.querySelector(".cm-task-tools"), null, "not off a task line");
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 8 } });
  const tools = view.contentDOM.querySelector(".cm-task-tools")!;
  assert.ok(tools.querySelector(".cm-task-gear"));
  assert.deepEqual([...tools.querySelectorAll(".cm-hint-word")].map((w) => w.textContent), ["repeat", "@", "#"]);
  view.destroy();
});

test("pressing a box ticks a task with done: as one edit, without moving the cursor or taking focus", () => {
  const view = editor();
  const cursor = () => view.state.selection.main.head - view.state.doc.line(5).from;
  view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 2 } });
  press(boxes(view)[0]);
  assert.equal(lineText(view, 2), `- [x] Call mum due:2026-10-05 !high done:${TODAY}`);
  assert.equal(cursor(), 2, "the cursor stays where it was in its line");
  assert.equal(view.hasFocus, false);
  press(boxes(view)[0]);
  assert.equal(lineText(view, 2), "- [ ] Call mum due:2026-10-05 !high", "and back open, its stamp gone");
  view.destroy();
});

test("a repeating task shows ticked for a moment, then moves on to its next date on the same line; one undo takes it back", async () => {
  const view = editor();
  const before = view.state.doc.lines;
  const box = boxes(view)[1];
  press(box);
  assert.equal(box.getAttribute("aria-checked"), "true");
  assert.equal(lineText(view, 3), "- [ ] Water the plants due:2026-10-04 rec:3d", "not yet");
  await new Promise((r) => setTimeout(r, CHECKED_FOR_MS + 50));
  assert.equal(lineText(view, 3), "- [ ] Water the plants due:2026-10-07 rec:3d");
  assert.equal(view.state.doc.lines, before, "no line added");
  assert.equal(boxes(view)[1].getAttribute("aria-checked"), "false");
  undo(view);
  assert.equal(lineText(view, 3), "- [ ] Water the plants due:2026-10-04 rec:3d");
  view.destroy();
});

test("pressing a chip opens its editor; a pick rewrites only that token, and undo takes it back", async () => {
  const view = editor();
  const high = [...view.contentDOM.querySelectorAll<HTMLElement>(".tk")].find((c) => c.dataset.field === "priority")!;
  press(high);
  const pop = popover()!;
  assert.equal(pop.getAttribute("aria-label"), "Priority");
  click([...pop.querySelectorAll(".fp-item")].find((b) => b.textContent!.startsWith("Low"))!);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lineText(view, 2), "- [ ] Call mum due:2026-10-05 !low");
  assert.equal(popover(), null, "it closes");
  undo(view);
  assert.equal(lineText(view, 2), "- [ ] Call mum due:2026-10-05 !high");
  // The due date's editor: Clear takes the token out, with the space before it.
  press([...view.contentDOM.querySelectorAll<HTMLElement>(".tk")].find((c) => c.dataset.field === "due")!);
  click([...popover()!.querySelectorAll(".fp-item")].find((b) => b.textContent === "Clear")!);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lineText(view, 2), "- [ ] Call mum !high");
  view.destroy();
});

test("a repeat's editor offers its quick picks and Skip this one", async () => {
  const view = editor();
  press([...view.contentDOM.querySelectorAll<HTMLElement>(".tk")].find((c) => c.dataset.field === "rec")!);
  const items = [...popover()!.querySelectorAll(".fp-item")].map((b) => b.textContent);
  assert.deepEqual(items.slice(0, 6), ["Daily", "Every weekday", "Weekly", "Every 2 weeks", "Monthly", "Yearly"]);
  assert.ok(items.some((t) => t!.startsWith("Skip this one")));
  click([...popover()!.querySelectorAll(".fp-item")].find((b) => b.textContent === "Weekly")!);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lineText(view, 3), "- [ ] Water the plants due:2026-10-04 rec:weekly");
  view.destroy();
});

test("with chips off, tokens read as the text they are; the box still draws", () => {
  const view = editor(NOTE, { ...env, chips: () => false });
  assert.deepEqual(chips(view), []);
  assert.equal(boxes(view).length, 3);
  view.destroy();
});

test("a selection across lines shows its boxes raw", () => {
  const view = editor();
  view.dispatch({ selection: EditorSelection.single(view.state.doc.line(2).from, view.state.doc.line(3).to) });
  assert.equal(boxes(view).length, 1, "only the done task, outside the selection, is drawn");
  view.destroy();
});

test("due: completes with today, tomorrow, the days of the coming week, and next week", () => {
  assert.deepEqual(dayPicks("2026-10-04").map((d) => `${d.label} ${d.date}`), [
    "Today 2026-10-04",
    "Tomorrow 2026-10-05",
    "Next Tuesday 2026-10-06",
    "Next Wednesday 2026-10-07",
    "Next Thursday 2026-10-08",
    "Next Friday 2026-10-09",
    "Next Saturday 2026-10-10",
    "Next week 2026-10-11",
  ]);
});
