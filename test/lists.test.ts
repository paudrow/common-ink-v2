import assert from "node:assert/strict";
import { test } from "node:test";
import * as M from "../web/src/extensions/lists/model.ts";

const L = (text: string) => text.split("\n");
const T = (lines: string[]) => lines.join("\n");

test("a line is an item with a kind, a marker and where its text starts; rules and plain text aren't", () => {
  assert.deepEqual(M.parseItem("  - [x] Done"), { indent: 2, marker: "-", kind: "todo", number: undefined, markerEnd: 4, contentStart: 8 });
  assert.deepEqual(M.parseItem("12) Twelve"), { indent: 0, marker: "12)", kind: "number", number: 12, markerEnd: 4, contentStart: 4 });
  assert.equal(M.parseItem("- - -"), null);
  assert.equal(M.parseItem("-not an item"), null);
  assert.equal(M.parseItem("Text"), null);
  assert.ok(M.isEmptyItem("  - "));
  assert.ok(M.isEmptyItem("3."));
  assert.ok(M.isEmptyItem("- [ ] "));
  assert.ok(!M.isEmptyItem("- x"));
});

const TREE = L(`- a
  - a1
    - a1x
  - a2
- b

- c
  text of c
Paragraph`);

test("an item's subtree is it and what's indented under it; siblings and parents are found past it", () => {
  assert.equal(M.subtreeEnd(TREE, 0), 4);
  assert.equal(M.subtreeEnd(TREE, 1), 3);
  assert.equal(M.subtreeEnd(TREE, 4), 5, "a blank line after isn't part of it");
  assert.equal(M.subtreeEnd(TREE, 6), 8, "c's continuation is");
  assert.equal(M.previousSibling(TREE, 4), 0);
  assert.equal(M.previousSibling(TREE, 3), 1);
  assert.equal(M.previousSibling(TREE, 1), null);
  assert.equal(M.nextSibling(TREE, 0), 4);
  assert.equal(M.nextSibling(TREE, 4), 6, "across a blank line");
  assert.equal(M.nextSibling(TREE, 6), null);
  assert.equal(M.parentOf(TREE, 2), 1);
  assert.equal(M.parentOf(TREE, 0), null);
  assert.equal(M.itemAt(TREE, 7), 6, "a continuation line belongs to its item");
  assert.equal(M.itemAt(TREE, 8), null);
});

test("a paragraph between two lists makes them two lists, up and down alike", () => {
  const lines = L("1. t0\n\nParagraph\n\n1. t1\n1. t2");
  assert.equal(M.previousSibling(lines, 4), null, "t1 starts its own list");
  assert.equal(M.nextSibling(lines, 0), null);
  assert.equal(M.moveUp(lines, 4), null, "so it can't move up past the paragraph");
  assert.equal(M.indent(lines, 4), null, "or indent under the list before it");
  assert.deepEqual(M.renumberAround(lines, [5]), L("1. t0\n\nParagraph\n\n1. t1\n2. t2"), "and numbers on its own");
});

test("indent: an item and its children go under the item before it; the first item can't", () => {
  const e = M.indent(L("- a\n- b\n  - b1\n- c"), 1)!;
  assert.equal(T(e.lines), "- a\n  - b\n    - b1\n- c");
  assert.equal(e.at, 1);
  assert.equal(M.indent(L("- a\n- b"), 0), null);
  assert.equal(T(M.indent(L("1. one\n2. two"), 1)!.lines), "1. one\n   1. two", "under a numbered item, as far as its text, and numbered from 1 there");
});

test("dedent: an item leaves its parent and comes right after it; the items after it stay the parent's", () => {
  const e = M.dedent(TREE, 1)!;
  assert.equal(T(e.lines.slice(0, 5)), "- a\n  - a2\n- a1\n  - a1x\n- b");
  assert.equal(e.at, 2);
  assert.equal(T(M.dedent(L("- a\n  - b"), 1)!.lines), "- a\n- b", "the last child just moves left");
  assert.equal(M.dedent(L("- a"), 0), null);
});

test("moving an item up or down swaps it, with its children, with its sibling, keeping blank lines between", () => {
  const up = M.moveUp(TREE, 4)!;
  assert.equal(T(up.lines.slice(0, 5)), "- b\n- a\n  - a1\n    - a1x\n  - a2");
  assert.equal(up.at, 0);
  const down = M.moveDown(TREE, 0)!;
  assert.equal(T(down.lines.slice(0, 5)), "- b\n- a\n  - a1\n    - a1x\n  - a2");
  assert.equal(down.at, 1);
  const loose = M.moveDown(L("- x\n\n- y\n"), 0)!;
  assert.equal(T(loose.lines), "- y\n\n- x\n");
  assert.equal(loose.at, 2);
  assert.equal(M.moveUp(TREE, 0), null);
  assert.equal(M.moveDown(TREE, 6), null);
});

test("numbered lists renumber at every level as items move, and a wider number takes its children along", () => {
  const list = L("1. one\n2. two\n   1. inner\n   2. inner too\n3. three");
  assert.equal(T(M.moveUp(list, 4)!.lines), "1. one\n2. three\n3. two\n   1. inner\n   2. inner too");
  assert.equal(T(M.renumberAround(L("3. a\n3. b\n3. c"), [1])), "3. a\n4. b\n5. c", "counting from the list's first number");
  const nine = L(Array.from({ length: 9 }, (_, i) => `${i + 1}. item`).join("\n") + "\n1. ten\n   - child");
  assert.equal(T(M.renumberAround(nine, [9]).slice(9)), "10. ten\n    - child");
  assert.equal(T(M.renumberAround(L("1. a\n1. b\n\nText\n\n1. x\n1. y"), [0])), "1. a\n2. b\n\nText\n\n1. x\n1. y", "lists far from the edit stay as written");
});

test("converting between bullets, numbers and todos keeps the text and the children", () => {
  const list = L("- a\n  - child\n- b");
  assert.equal(T(M.convert(list, 0, 0, "number")), "1. a\n   - child\n- b", "its children move with its wider marker");
  assert.equal(T(M.convert(list, 0, 2, "number")), "1. a\n   1. child\n2. b", "a selection converts every item in it");
  assert.equal(T(M.convert(list, 0, 0, "todo")), "- [ ] a\n  - child\n- b");
  assert.equal(T(M.convert(L("- [x] done\n- [ ] not"), 0, 1, "bullet")), "- done\n- not");
  assert.equal(T(M.convert(L("1. a\n2. b"), 0, 1, "bullet")), "- a\n- b");
});

test("the items in a selection are its top-level ones; a line inside an item picks the item", () => {
  assert.deepEqual(M.itemsIn(TREE, 0, 4), [0, 4]);
  assert.deepEqual(M.itemsIn(TREE, 1, 3), [1, 3]);
  assert.deepEqual(M.itemsIn(TREE, 7, 7), [6]);
  assert.deepEqual(M.childrenRange(TREE, 0), { from: 1, to: 3 });
  assert.equal(M.childrenRange(TREE, 4), null);
});

// In an editor: the keys and commands, and how lists are drawn.
const { JSDOM } = await import("jsdom");
const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window,
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  getComputedStyle: window.getComputedStyle,
  Window: window.Window,
});
const { EditorView } = await import("@codemirror/view");
const { EditorSelection } = await import("@codemirror/state");
const { runScopeHandlers } = await import("@codemirror/view");
const { createState, addMarkdownSyntax } = await import("../web/src/editor.ts");
const { DEFAULTS } = await import("../worker/src/settings.ts");
addMarkdownSyntax((await import("@lezer/markdown")).GFM);
const lists = (await import("../web/src/extensions/lists/index.ts")).default;
const edit = await import("../web/src/extensions/lists/edit.ts");
import type { ExtensionContext } from "../web/src/extension-api.ts";

const added: unknown[] = [];
const commands = new Map<string, () => unknown>();
const status: string[] = [];
let focused: InstanceType<typeof EditorView> | null = null;
lists.activate({
  editor: { extend: (e: unknown) => void added.push(e), focused: () => focused },
  commands: { register: (id: string, run: () => unknown) => void commands.set(id, run) },
  statusBar: { set: (id: string, text: string) => void (id === "lists.message" && text && status.push(text)) },
} as unknown as ExtensionContext);

function editor(doc: string, cursor: number | string) {
  const view = new EditorView({ state: createState(doc, { json: false, readOnly: false, settings: DEFAULTS, extensions: added as never, onUpdate: () => {}, onBlur: () => {} }), parent: document.body });
  view.dispatch({ selection: EditorSelection.cursor(typeof cursor === "number" ? cursor : doc.indexOf(cursor)) });
  focused = view;
  return view;
}

const key = (view: InstanceType<typeof EditorView>, name: string, extra: Partial<KeyboardEventInit> = {}) =>
  runScopeHandlers(view, new window.KeyboardEvent("keydown", { key: name, ...extra }) as unknown as KeyboardEvent, "editor");

const lineOfCursor = (view: InstanceType<typeof EditorView>) => view.state.doc.lineAt(view.state.selection.main.head).text;

test("Tab and Shift-Tab indent and dedent an item with its children, the cursor staying in its text", () => {
  const view = editor("- a\n- b\n  - b1\n- c", "b\n");
  assert.ok(key(view, "Tab"));
  assert.equal(view.state.doc.toString(), "- a\n  - b\n    - b1\n- c");
  assert.equal(lineOfCursor(view), "  - b");
  assert.equal(view.state.selection.main.head - view.state.doc.lineAt(view.state.selection.main.head).from, 4, "still just before b");
  assert.ok(key(view, "Tab", { shiftKey: true }));
  assert.equal(view.state.doc.toString(), "- a\n- b\n  - b1\n- c");
  view.destroy();
});

test("Alt-Up and Alt-Down move an item past its sibling, with its children; numbers follow", () => {
  const view = editor("1. one\n2. two\n   - detail\n3. three", "two");
  assert.ok(key(view, "ArrowUp", { altKey: true }));
  assert.equal(view.state.doc.toString(), "1. two\n   - detail\n2. one\n3. three");
  assert.equal(lineOfCursor(view), "1. two");
  assert.ok(key(view, "ArrowDown", { altKey: true }));
  assert.ok(key(view, "ArrowDown", { altKey: true }));
  assert.equal(view.state.doc.toString(), "1. one\n2. three\n3. two\n   - detail");
  view.destroy();
});

test("Enter on an empty item steps out a level, then out of the list", () => {
  const view = editor("- a\n  - ", "  - ".length + 4);
  assert.ok(key(view, "Enter"));
  assert.equal(view.state.doc.toString(), "- a\n- ");
  assert.ok(key(view, "Enter"));
  assert.equal(view.state.doc.toString(), "- a\n");
  view.destroy();
  const going = editor("1. x", 4);
  assert.ok(key(going, "Enter"));
  assert.equal(going.state.doc.toString(), "1. x\n2. ", "on an item with text, the list carries on");
  going.destroy();
});

test("deleting a numbered item renumbers the rest, in the same undo step", () => {
  const view = editor("1. a\n2. b\n3. c", 0);
  const line = view.state.doc.line(2);
  view.dispatch({ changes: { from: line.from, to: line.to + 1 }, userEvent: "delete" });
  assert.equal(view.state.doc.toString(), "1. a\n2. c");
  view.destroy();
});

test("the commands convert items, and fold an item's children away and back", () => {
  const view = editor("- a\n  - child\n- b", "a");
  commands.get("lists.toNumbers")!();
  assert.equal(view.state.doc.toString(), "1. a\n   - child\n- b");
  commands.get("lists.toTodos")!();
  assert.equal(view.state.doc.toString(), "- [ ] a\n  - child\n- b");
  commands.get("lists.toggleFold")!();
  assert.ok(edit.isFolded(view.state, 0));
  assert.ok(view.dom.querySelector(".cm-list-folded"), "a … where they were");
  commands.get("lists.toggleFold")!();
  assert.ok(!edit.isFolded(view.state, 0));
  view.destroy();
});

test("lists are drawn with bullets by depth, numbers in a column and hanging indents, and keep that layout under the cursor", () => {
  const view = editor("- top\n  - inner\n    text of inner\n1. one\n- [ ] todo\n\nEnd", "End");
  const lines = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
  assert.equal(lines[0].querySelector(".cm-list-bullet")?.textContent, "•");
  assert.ok(lines[0].querySelector(".cm-list-bullet.parent"), "a bullet with children folds them");
  assert.equal(lines[1].querySelector(".cm-list-bullet")?.textContent, "◦");
  assert.equal(lines[1].style.getPropertyValue("--list-depth"), "1");
  assert.ok(lines[2].classList.contains("cm-list-cont"), "a continuation hangs under its text");
  assert.equal(lines[3].querySelector(".cm-list-number")?.textContent, "1.");
  assert.equal(lines[4].querySelector(".cm-list-bullet"), null, "a todo's box is the Todos extension's");
  assert.ok(lines[4].classList.contains("cm-list-line"));
  // The cursor on an item's text: its line is laid out the same, bullet and all.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 6 } });
  const inner = () => view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")[1];
  assert.ok(inner().classList.contains("cm-list-line"), "its hanging indent stays");
  assert.equal(inner().style.getPropertyValue("--list-depth"), "1");
  assert.equal(inner().querySelector(".cm-list-bullet")?.textContent, "◦");
  // On its marker, the bullet is its "-", in the same box.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 2 } });
  assert.equal(inner().querySelector(".cm-list-bullet.raw")?.textContent, "-");
  assert.ok(inner().classList.contains("cm-list-line"));
  // A number is always its own text, whatever the cursor's doing.
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
  assert.equal(view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")[3].querySelector(".cm-list-number")?.textContent, "1.");
  view.destroy();
});

test("smart indent: only under the item above, one level at a time; a refused indent says why, quietly, and changes nothing", () => {
  const view = editor("1. one\n2. two\n3. three", "one");
  status.length = 0;
  assert.ok(key(view, "Tab"), "the key is taken, so no tab is typed");
  assert.equal(view.state.doc.toString(), "1. one\n2. two\n3. three", "the first item has nothing to nest under");
  assert.deepEqual(status, ["Can't indent: nothing above to nest under"]);
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("two") } });
  assert.ok(key(view, "Tab"));
  assert.equal(view.state.doc.toString(), "1. one\n   1. two\n2. three", "under the item above, renumbered at both levels");
  assert.ok(key(view, "Tab"));
  assert.equal(view.state.doc.toString(), "1. one\n   1. two\n2. three", "no double indent: it's the first child now");
  assert.equal(status.at(-1), "Can't indent: nothing above to nest under");
  view.dispatch({ selection: { anchor: 0 } });
  assert.ok(key(view, "Tab", { shiftKey: true }));
  assert.equal(view.state.doc.toString(), "1. one\n   1. two\n2. three", "the top level can't dedent");
  assert.equal(status.at(-1), "Can't dedent: it's already at the top");
  view.destroy();
});

test("a selection indents as a block: under the item above the first, or not at all", () => {
  const view = editor("- a\n- b\n- c\n- d", "b");
  view.dispatch({ selection: EditorSelection.range(view.state.doc.toString().indexOf("b"), view.state.doc.toString().indexOf("c") + 1) });
  assert.ok(key(view, "Tab"));
  assert.equal(view.state.doc.toString(), "- a\n  - b\n  - c\n- d", "b and c both go under a, as siblings");
  view.dispatch({ selection: EditorSelection.range(0, view.state.doc.toString().indexOf("c") + 1) });
  assert.ok(key(view, "Tab"));
  assert.equal(view.state.doc.toString(), "- a\n  - b\n  - c\n- d", "a can't indent, so none of them do");
  view.destroy();
});

test("Alt-Right and Alt-Left indent and dedent a list item; off a list, they decline, so the key moves by word as usual", () => {
  const view = editor("Some text here\n\n- a\n- b", "text");
  assert.equal(commands.get("lists.indentItem")!(), false, "not on a list: the key's own job");
  assert.equal(view.state.doc.toString(), "Some text here\n\n- a\n- b");
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("b") } });
  assert.equal(commands.get("lists.indentItem")!(), true);
  assert.equal(view.state.doc.toString(), "Some text here\n\n- a\n  - b");
  assert.equal(commands.get("lists.dedentItem")!(), true);
  assert.equal(view.state.doc.toString(), "Some text here\n\n- a\n- b");
  view.destroy();
});

test("indenting over a whole-line selection (Vim's >>) leaves the cursor on that line's marker, as Vim does", () => {
  const view = editor("- a\n- b\n- c", "b");
  const b = view.state.doc.line(2);
  view.dispatch({ selection: EditorSelection.range(b.from, view.state.doc.line(3).from) });
  edit.indentItems(view);
  assert.equal(view.state.doc.toString(), "- a\n  - b\n- c");
  assert.equal(lineOfCursor(view), "  - b", "on its own line, not the next");
  assert.equal(view.state.selection.main.head - view.state.doc.line(2).from, 2, "at its marker");
  view.destroy();
});
