import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import { activeDoc, closeTab, showInTab, cycleGroup, cycleTab, emptyLayout, focusDirection, focused, groups, only, openTab, parseLayout, split, type Layout } from "../web/src/layout.ts";

const [a, b, c] = ["A.md", "B.md", "C.md"] as FilePath[];
const shown = (l: Layout) => groups(l).map((g) => `${g.id}:${g.tabs.join(",")}@${g.active}`);

test("opening a file adds a tab after the current one, or shows its tab if it has one", () => {
  let l = openTab(emptyLayout(), a);
  l = openTab(l, b);
  l = openTab(openTab(l, a), c);
  assert.deepEqual(shown(l), ["g1:A.md,C.md,B.md@1"]);
  assert.equal(activeDoc(focused(openTab(l, b))), b);
});

test("closing a tab shows its neighbour, and an empty group closes unless it's the last", () => {
  let l = openTab(openTab(openTab(emptyLayout(), a), b), c);
  l = closeTab(l, "g1", 2);
  assert.deepEqual(shown(l), ["g1:A.md,B.md@1"]);
  l = closeTab(l, "g1", 0);
  assert.deepEqual(shown(l), ["g1:B.md@0"]);
  l = closeTab(l, "g1", 0);
  assert.deepEqual(shown(l), ["g1:@0"]);
  const two = split(openTab(emptyLayout(), a), "right", b);
  const one = closeTab(two, "g2", 0);
  assert.deepEqual(shown(one), ["g1:A.md@0"]);
  assert.equal(one.focus, "g1");
  assert.equal(one.root.kind, "group");
});

test("splitting puts a new group right of or below the focused one, and focuses it", () => {
  let l = split(openTab(emptyLayout(), a), "right");
  assert.deepEqual(shown(l), ["g1:A.md@0", "g2:A.md@0"]);
  assert.equal(l.focus, "g2");
  l = split(l, "right", b);
  assert.equal(l.root.kind === "split" && l.root.children.length, 3, "a split the same way joins its parent");
  l = split(l, "down", c);
  assert.deepEqual(shown(l), ["g1:A.md@0", "g2:A.md@0", "g3:B.md@0", "g4:C.md@0"]);
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

test("gt and gT cycle tabs, wrapping around", () => {
  const l = openTab(openTab(openTab(emptyLayout(), a), b), c);
  assert.equal(activeDoc(focused(cycleTab(l, 1))), a);
  assert.equal(activeDoc(focused(cycleTab(l, -1))), b);
});

test("a saved layout is read back, and anything malformed is refused or cleaned", () => {
  const l = split(openTab(emptyLayout(), a), "down", b);
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(l))), l);
  assert.equal(parseLayout({ root: { kind: "split", dir: "row", children: [] }, focus: "g1" }), null);
  assert.equal(parseLayout("nope"), null);
  assert.deepEqual(parseLayout({ root: { kind: "group", id: "g7", tabs: ["A.md", "../x.md", 3, "A.md"], active: 9 }, focus: "g1" }), {
    root: { kind: "group", id: "g7", tabs: ["A.md"], active: 0 },
    focus: "g7",
  });
});

test(":e shows a file in place of the tab on show, or switches to its tab", () => {
  const l = openTab(openTab(emptyLayout(), a), b);
  assert.deepEqual(shown(showInTab(l, c)), ["g1:A.md,C.md@1"]);
  assert.deepEqual(shown(showInTab(l, a)), ["g1:A.md,B.md@0"]);
  assert.deepEqual(shown(showInTab(emptyLayout(), a)), ["g1:A.md@0"]);
});
