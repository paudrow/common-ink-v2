// The one task input, where a task is typed (the quick-add bar, a row's inline edit): it reads phrases
// as you type, shows the chips they'll become, keeps a clicked phrase as words, and hands the host what
// was typed on Enter. And in a note, phrases on the cursor's task line are underlined until Tab or a
// click makes them tokens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window,
  document: window.document,
  Node: window.Node,
  HTMLElement: window.HTMLElement,
  Window: window.Window,
  KeyboardEvent: window.KeyboardEvent,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
  innerWidth: 1200,
  innerHeight: 800,
});
// jsdom lays nothing out; CodeMirror measures text ranges, which then have no boxes.
Object.assign(window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) });

const { EditorView } = await import("@codemirror/view");
const { EditorState } = await import("@codemirror/state");
const { history, undo } = await import("@codemirror/commands");
const { markdown } = await import("@codemirror/lang-markdown");
const { PLACEHOLDER, taskInput } = await import("../web/src/extensions/tasks/input.ts");
const { quickAddBar } = await import("../web/src/extensions/tasks/bar.ts");
const { today } = await import("../web/src/extensions/tasks/chips.ts");
const { convertPhrases, phrasesAt, phraseTab, taskPhrases } = await import("../web/src/extensions/tasks/edit.ts");
import type { TaskInputOptions } from "../web/src/extensions/tasks/input.ts";

const TODAY = today();
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A task input on the page, and its CodeMirror. */
function mount(opts: Partial<TaskInputOptions> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const input = taskInput({ submit: (text, ignore) => void calls.push(["submit", text, ignore]), cancel: () => void calls.push(["cancel"]), vim: false, ...opts });
  document.body.replaceChildren(input.dom, input.preview);
  const view = EditorView.findFromDOM(input.dom.querySelector(".cm-editor") as HTMLElement)!;
  const type = (text: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length } });
  const key = (k: string, init: KeyboardEventInit = {}) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  return { input, view, calls, type, key };
}

test("a task input lights the phrases it reads and shows the chips they'll become", () => {
  const { input, view, type } = mount();
  assert.equal(view.contentDOM.getAttribute("aria-label"), PLACEHOLDER);
  type("Pay rent every month on the 1st #home");
  assert.deepEqual([...input.dom.querySelectorAll(".qa-hl")].map((n) => [n.textContent, n.className]), [["every month on the 1st", "qa-hl is-rec"]]);
  assert.equal(input.preview.querySelector(".qa-words")!.textContent, "Pay rent #home");
  assert.ok(input.preview.querySelector('.tk[data-field="rec"]'), "a repeat chip");
  assert.equal(input.parsed()!.meta.rec, "1st");
});

test("a click on a lit phrase keeps it as words; Enter hands over the text and the kept phrases; Esc cancels", () => {
  const { input, view, calls, type, key } = mount();
  type("Call mom tomorrow");
  view.dispatch({ selection: { anchor: "Call mom tom".length } });
  view.contentDOM.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(input.dom.querySelectorAll(".qa-hl").length, 0);
  assert.equal(input.parsed()!.meta.due, null);
  key("Enter");
  assert.deepEqual(calls, [["submit", "Call mom tomorrow", ["tomorrow"]]]);
  assert.equal(view.state.doc.toString(), "Call mom tomorrow", "Enter never breaks the line");
  key("Escape");
  assert.deepEqual(calls.at(-1), ["cancel"]);
});

test("phrases already in the text a field opens with stay words: only what you type is read", () => {
  const { input, calls, type, key } = mount({ value: "Call mom tomorrow" });
  assert.equal(input.dom.querySelectorAll(".qa-hl").length, 0);
  key("Enter");
  assert.deepEqual(calls, [["submit", "Call mom tomorrow", ["tomorrow"]]]);
  type(" every week");
  assert.deepEqual([...input.dom.querySelectorAll(".qa-hl")].map((n) => n.textContent), ["every week"]);
});

test("with Vim, the first Esc goes to normal mode and the second leaves; Enter works from either", () => {
  const { view, calls, type, key, input } = mount({ vim: true });
  input.focus();
  type("Water plants daily");
  key("Escape");
  assert.deepEqual(calls, [], "the first Esc is Vim's");
  key("Enter");
  assert.deepEqual(calls, [["submit", "Water plants daily", []]]);
  key("Escape");
  assert.deepEqual(calls.at(-1), ["cancel"]);
  assert.equal(view.state.doc.toString(), "Water plants daily");
});

test("the quick-add bar adds what was typed to the inbox, or with Tab to the note it was opened from", async () => {
  const added: unknown[][] = [];
  const daily = { label: `Journal/${TODAY}`, path: `Journal/${TODAY}.md`, daily: true };
  const bar = quickAddBar({
    add: async (text, ignore, to) => (added.push([text, ignore, to.path]), { path: to.path!, line: 3 }),
    added: () => {},
    open: () => {},
    inbox: () => daily,
    note: "Projects/Launch.md",
  });
  document.body.replaceChildren(bar.root);
  const view = EditorView.findFromDOM(bar.root.querySelector(".cm-editor") as HTMLElement)!;
  const key = (k: string) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  view.dispatch({ changes: { from: 0, insert: "Print badges next fri" } });
  assert.equal(bar.root.querySelector(".qa-hl")!.textContent, "next fri");
  assert.equal(bar.root.querySelector(".qa-where")!.textContent, `→ Journal/${TODAY}`);
  key("Tab");
  assert.equal(bar.root.querySelector(".qa-where")!.textContent, "→ Launch");
  key("Enter");
  await settle();
  assert.deepEqual(added, [["Print badges next fri", [], "Projects/Launch.md"]]);
  assert.equal(view.state.doc.toString(), "", "cleared for the next one");
  assert.equal(bar.root.querySelector(".qa-done")!.textContent, "Added to Projects/Launch");
  bar.destroy();
});

/** A note's state with the cursor on line `n`, at column `ch` (default: the line's end). */
function at(doc: string, n: number, ch = -1) {
  const s = EditorState.create({ doc, extensions: [markdown()] });
  const line = s.doc.line(n);
  return EditorState.create({ doc, extensions: [markdown()], selection: { anchor: ch < 0 ? line.to : line.from + ch } });
}

test("phrases on the cursor's task line are only marked, and become tokens on Tab or a click, in one undoable change", () => {
  const doc = "- [ ] Call mom tomorrow every week\nCall the bank tomorrow\n```\n- [ ] in code tomorrow\n```";
  const spans = phrasesAt(at(doc, 1), "2026-09-28")!;
  assert.deepEqual(spans.phrases.map((p) => [at(doc, 1).sliceDoc(p.from, p.to), p.kind]), [["tomorrow", "due"], ["every week", "rec"]]);
  assert.equal(phrasesAt(at(doc, 2), "2026-09-28"), null, "not a task line");
  assert.equal(phrasesAt(at(doc, 4), "2026-09-28"), null, "in code");
  // Tab: all of them, in one change that one undo takes back.
  let state = EditorState.create({ doc, extensions: [history(), markdown()] });
  state = state.update(convertPhrases(state, 1, "2026-09-28")!).state;
  assert.equal(state.doc.line(1).text, "- [ ] Call mom due:2026-09-29 rec:weekly");
  undo({ state, dispatch: (tr) => void (state = tr.state) });
  assert.equal(state.doc.toString(), doc);
  // A click: just that phrase.
  state = state.update(convertPhrases(state, 1, "2026-09-28", "every week")!).state;
  assert.equal(state.doc.line(1).text, "- [ ] Call mom tomorrow due:2026-09-28 rec:weekly");
  // A ticked task keeps its box; indentation stays.
  const done = EditorState.create({ doc: "  - [x] Filed tomorrow", extensions: [markdown()] });
  assert.equal(done.update(convertPhrases(done, 1, "2026-09-28")!).state.doc.toString(), "  - [x] Filed due:2026-09-29");
});

test("the cursor's task line underlines its phrases; Tab right after one turns the line's phrases into tokens", () => {
  const doc = "- [ ] Call mom tomorrow about the trip every week\nplain line";
  const field = taskPhrases(() => "2026-09-28");
  const marks = (n: number) => {
    const s = EditorState.create({ doc, extensions: [markdown(), field], selection: { anchor: at(doc, n).selection.main.head } });
    const out: string[] = [];
    s.field(field).between(0, s.doc.length, (from, to, d) => void out.push(`${s.sliceDoc(from, to)}|${d.spec.class}|${d.spec.attributes.title}`));
    return out;
  };
  assert.deepEqual(marks(1), ["tomorrow|cm-phrase is-due|Tab or click: due:2026-09-29", "every week|cm-phrase is-rec|Tab or click: rec:weekly"]);
  assert.deepEqual(marks(2), [], "only the cursor's line, and only a task");
  const afterTomorrow = at(doc, 1, "- [ ] Call mom tomorrow".length);
  assert.equal(afterTomorrow.update(phraseTab(afterTomorrow, "2026-09-28")!).state.doc.line(1).text, "- [ ] Call mom about the trip due:2026-09-29 rec:weekly");
  assert.equal(phraseTab(at(doc, 1, "- [ ] Call mom tomorrow about".length), "2026-09-28"), null, "Tab elsewhere is Tab");
  assert.ok(phraseTab(at(doc, 1, "- [ ] Call mom tomorrow ".length), "2026-09-28"), "a space after it still counts");
  assert.equal(phraseTab(at(doc, 2), "2026-09-28"), null);
});
