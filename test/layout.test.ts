import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import {
  activeFile,
  closeTab,
  closeTabs,
  cycleGroup,
  cycleTab,
  emptyLayout,
  equalize,
  focusDirection,
  focused,
  groups,
  insertTab,
  keepFile,
  keepTab,
  moveTab,
  moveTabDirection,
  only,
  openTab,
  parseLayout,
  resizeFocused,
  selectTab,
  shiftTab,
  showInTab,
  split,
  splitAt,
  type Layout,
} from "../web/src/layout.ts";

const [a, b, c] = ["A.md", "B.md", "C.md"] as FilePath[];
const shown = (l: Layout) => groups(l).map((g) => `${g.id}:${g.tabs.map((t) => (t.preview ? "*" : "") + ("file" in t ? t.file : `view:${t.view}`)).join(",")}@${g.active}`);
const sizes = (l: Layout) => (l.root.kind === "split" ? l.root.sizes.map((s) => Math.round(s * 100) / 100) : []);

test("opening a file adds a tab after the current one, or shows its tab if it has one", () => {
  let l = openTab(emptyLayout(), a);
  l = openTab(l, b);
  l = openTab(openTab(l, a), c);
  assert.deepEqual(shown(l), ["g1:A.md,C.md,B.md@1"]);
  assert.equal(activeFile(focused(openTab(l, b))), b);
});

test(":e and quick open show a file in the preview tab, or a new one; opened tabs are kept", () => {
  const kept = openTab(openTab(emptyLayout(), a), b);
  const previewed = showInTab(kept, c);
  assert.deepEqual(shown(previewed), ["g1:A.md,B.md,*C.md@2"], "no preview tab yet: a new one after the tab on show");
  assert.deepEqual(shown(showInTab(previewed, a)), ["g1:A.md,B.md,*C.md@0"], "a tab it has already just shows");
  const d = "D.md" as FilePath;
  assert.deepEqual(shown(showInTab(selectTab(previewed, "g1", 0), d)), ["g1:A.md,B.md,*D.md@2"], "the preview tab is the one replaced");
  assert.deepEqual(shown(showInTab(emptyLayout(), { view: "history" })), ["g1:*view:history@0"]);
});

test("a preview tab is kept by Keep Open, by editing its file, or by opening it in a tab", () => {
  const l = showInTab(openTab(emptyLayout(), a), b);
  assert.deepEqual(shown(keepTab(l, "g1", 1)), ["g1:A.md,B.md@1"]);
  assert.deepEqual(shown(keepFile(split(l, "right"), b)), ["g1:A.md,B.md@1", "g2:B.md@0"]);
  assert.deepEqual(shown(openTab(l, b)), ["g1:A.md,B.md@1"]);
  assert.deepEqual(shown(showInTab(keepTab(l, "g1", 1), c)), ["g1:A.md,B.md,*C.md@2"], "a kept tab is never replaced");
  const saved = JSON.parse(JSON.stringify(l));
  assert.deepEqual(saved.root.tabs, [{ file: "A.md" }, { file: "B.md", preview: true }], "the preview mark is saved in the layout");
  assert.deepEqual(parseLayout(saved), l);
  const twoPreviews = parseLayout({ root: { kind: "group", id: "g1", tabs: [{ file: "A.md", preview: true }, { file: "B.md", preview: true }], active: 0 }, focus: "g1" });
  assert.deepEqual(twoPreviews && shown(twoPreviews), ["g1:*A.md,B.md@0"], "a group has at most one preview tab");
});

test("closing others, to the right, to the left, saved ones or all", () => {
  const l = openTab(openTab(openTab(openTab(emptyLayout(), a), b), c), "D.md" as FilePath);
  const at = (i: number) => (_: unknown, j: number) => j === i;
  assert.deepEqual(shown(closeTabs(l, "g1", (_, i) => i !== 1)), ["g1:B.md@0"]);
  assert.deepEqual(shown(closeTabs(l, "g1", (_, i) => i > 1)), ["g1:A.md,B.md@1"]);
  assert.deepEqual(shown(closeTabs(l, "g1", (_, i) => i < 1)), ["g1:B.md,C.md,D.md@2"]);
  assert.deepEqual(shown(closeTabs(l, "g1", () => true)), ["g1:@0"]);
  assert.deepEqual(shown(closeTabs(l, "g1", at(9))), shown(l));
});

test("closing a tab shows its neighbour, and an empty group closes unless it's the last", () => {
  let l = openTab(openTab(openTab(emptyLayout(), a), b), c);
  l = closeTab(l, "g1", 2);
  assert.deepEqual(shown(l), ["g1:A.md,B.md@1"]);
  l = closeTab(l, "g1", 0);
  assert.deepEqual(shown(l), ["g1:B.md@0"]);
  l = closeTab(l, "g1", 0);
  assert.deepEqual(shown(l), ["g1:@0"]);
  const one = closeTab(split(openTab(emptyLayout(), a), "right", b), "g2", 0);
  assert.deepEqual(shown(one), ["g1:A.md@0"]);
  assert.equal(one.focus, "g1");
  assert.equal(one.root.kind, "group");
});

test("splitting puts a new group on any side and focuses it; a split the same way joins its parent", () => {
  let l = split(openTab(emptyLayout(), a), "right");
  assert.deepEqual(shown(l), ["g1:A.md@0", "g2:A.md@0"]);
  assert.equal(l.focus, "g2");
  l = split(l, "right", b);
  assert.equal(l.root.kind === "split" && l.root.children.length, 3);
  assert.deepEqual(sizes(l), [0.5, 0.25, 0.25], "the new window takes half of the one it split");
  l = split(l, "down", c);
  assert.deepEqual(shown(l), ["g1:A.md@0", "g2:A.md@0", "g3:B.md@0", "g4:C.md@0"]);
  assert.deepEqual(shown(splitAt(openTab(emptyLayout(), a), "g1", "left", { file: b })), ["g2:B.md@0", "g1:A.md@0"]);
  assert.deepEqual(shown(only(l)), ["g4:C.md@0"]);
});

test("Ctrl-W h, j, k and l move focus to the group that way", () => {
  // g1 | g2 over g3
  let l = split(openTab(emptyLayout(), a), "right", b);
  l = split(l, "down", c);
  assert.equal(l.focus, "g3");
  assert.equal(focusDirection(l, "up").focus, "g2");
  assert.equal(focusDirection(l, "left").focus, "g1");
  assert.equal(focusDirection(l, "down").focus, "g3");
  assert.equal(focusDirection({ ...l, focus: "g1" }, "right").focus, "g2");
  assert.equal(cycleGroup(l, 1).focus, "g1");
});

test("gt and gT cycle tabs, and :tabmove shifts one", () => {
  const l = openTab(openTab(openTab(emptyLayout(), a), b), c);
  assert.equal(activeFile(focused(cycleTab(l, 1))), a);
  assert.equal(activeFile(focused(cycleTab(l, -1))), b);
  assert.deepEqual(shown(shiftTab(l, -1)), ["g1:A.md,C.md,B.md@1"]);
  assert.deepEqual(shown(shiftTab(shiftTab(l, -1), 1)), ["g1:A.md,B.md,C.md@2"]);
});

test("dragging a tab moves it within its bar, to another window, or into a new split", () => {
  const three = openTab(openTab(openTab(emptyLayout(), a), b), c);
  assert.deepEqual(shown(moveTab(three, { group: "g1", index: 0 }, { group: "g1", index: 3 })), ["g1:B.md,C.md,A.md@2"]);
  assert.deepEqual(shown(moveTab(three, { group: "g1", index: 2 }, { group: "g1", index: 0 })), ["g1:C.md,A.md,B.md@0"]);
  const two = split(three, "right", a);
  // B to the right window, which already has A.
  const moved = moveTab(two, { group: "g1", index: 1 }, { group: "g2", index: 0 });
  assert.deepEqual(shown(moved), ["g1:A.md,C.md@1", "g2:B.md,A.md@0"]);
  assert.equal(moved.focus, "g2");
  // A onto a window that has it already: the tab there shows, and the dragged one goes.
  assert.deepEqual(shown(moveTab(two, { group: "g1", index: 0 }, { group: "g2" })), ["g1:B.md,C.md@1", "g2:A.md@0"]);
  // The only tab of a window, dropped on another: its window closes.
  assert.deepEqual(shown(moveTab(two, { group: "g2", index: 0 }, { group: "g1" })), ["g1:A.md,B.md,C.md@0"]);
  // Onto a window's bottom edge: a new window below it.
  const below = moveTab(three, { group: "g1", index: 2 }, { group: "g1", side: "down" });
  assert.deepEqual(shown(below), ["g1:A.md,B.md@1", "g2:C.md@0"]);
  assert.equal(below.root.kind === "split" && below.root.dir, "column");
  // A window's only tab can't split off itself.
  const single = openTab(emptyLayout(), a);
  assert.equal(moveTab(single, { group: "g1", index: 0 }, { group: "g1", side: "left" }), single);
});

test("Ctrl-W H, J, K and L move the tab on show to the window that way, or split one off", () => {
  const l = openTab(openTab(emptyLayout(), a), b);
  const right = moveTabDirection(l, "right");
  assert.deepEqual(shown(right), ["g1:A.md@0", "g2:B.md@0"]);
  assert.deepEqual(shown(moveTabDirection(right, "left")), ["g1:A.md,B.md@1"]);
});

test("a dragged file opens as a tab at the drop point, or shows its tab if it's open there", () => {
  const l = openTab(openTab(emptyLayout(), a), b);
  assert.deepEqual(shown(insertTab(l, { file: c }, "g1", 0)), ["g1:C.md,A.md,B.md@0"]);
  assert.deepEqual(shown(insertTab(l, { file: a }, "g1", 2)), ["g1:A.md,B.md@0"]);
});

test("windows resize along their split, never below a tenth, and Ctrl-W = evens them out", () => {
  let l = split(openTab(emptyLayout(), a), "right", b);
  l = resizeFocused(l, "row", 0.2);
  assert.deepEqual(sizes(l), [0.3, 0.7]);
  l = resizeFocused(l, "row", 0.9);
  assert.deepEqual(sizes(l), [0.1, 0.9]);
  assert.equal(resizeFocused(l, "column", 0.1), l, "no split that way: nothing to resize");
  assert.deepEqual(sizes(equalize(l)), [0.5, 0.5]);
});

test("a saved layout is read back, and anything malformed is refused or cleaned", () => {
  const l = resizeFocused(split(openTab(emptyLayout(), a), "down", b), "column", 0.1);
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(l))), l);
  assert.equal(parseLayout({ root: { kind: "split", dir: "row", children: [], sizes: [] }, focus: "g1" }), null);
  assert.equal(parseLayout("nope"), null);
  assert.deepEqual(parseLayout({ root: { kind: "group", id: "g7", tabs: ["A.md", "../x.md", 3, { file: "A.md" }, { view: "history" }], active: 9 }, focus: "g1" }), {
    root: { kind: "group", id: "g7", tabs: [{ file: "A.md" }, { view: "history" }], active: 1 },
    focus: "g7",
  });
  const noSizes = parseLayout({ root: { kind: "split", dir: "row", children: [{ kind: "group", id: "g1", tabs: [], active: 0 }, { kind: "group", id: "g2", tabs: [], active: 0 }] }, focus: "g2" });
  assert.deepEqual(noSizes && sizes(noSizes), [0.5, 0.5]);
});
