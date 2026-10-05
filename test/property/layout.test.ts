import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../../worker/src/files.ts";
import {
  closeTab,
  closeTabs,
  cycleGroup,
  cycleTab,
  emptyLayout,
  equalize,
  focusDirection,
  focusGroup,
  groups,
  insertTab,
  keepFile,
  keepTab,
  moveTab,
  moveTabDirection,
  only,
  openTab,
  parseLayout,
  rects,
  resizeFocused,
  resizeSplit,
  selectTab,
  shiftTab,
  showInTab,
  split,
  splitAt,
  type Direction,
  type Layout,
  type Node,
  type Openable,
  type Split,
} from "../../web/src/layout.ts";
import { layoutProblems } from "../../web/src/layout-problems.ts";
import { forAll, type Rng } from "./gen.ts";

const FILES = ["A.md", "B.md", "C.md", "D.md"] as FilePath[];
const ITEMS: Openable[] = [...FILES.map((file) => ({ file })), { view: "history" }, { view: "search" }];
const SIDES: Direction[] = ["left", "right", "up", "down"];

const file = (n: number) => FILES[n % FILES.length];
const item = (n: number) => ITEMS[n % ITEMS.length];
const side = (n: number) => SIDES[n % SIDES.length];
const group = (l: Layout, n: number) => groups(l)[n % groups(l).length];
/** A tab index in a group, sometimes one past its last tab. */
const at = (l: Layout, id: string, n: number) => n % (groups(l).find((g) => g.id === id)!.tabs.length + 1);
const by = (n: number) => (n % 5) - 2;

function splitPaths(node: Node, path: number[] = []): number[][] {
  return node.kind === "group" ? [] : [path, ...node.children.flatMap((c, i) => splitPaths(c, [...path, i]))];
}

/** Each step reads its numbers against the layout it's given, so any subsequence of steps still runs. */
const OPS: Record<string, (l: Layout, n: number[]) => Layout> = {
  openTab: (l, [f, g]) => openTab(l, file(f), group(l, g).id),
  showInTab: (l, [i, g]) => showInTab(l, item(i), group(l, g).id),
  insertTab: (l, [i, g, t]) => insertTab(l, item(i), group(l, g).id, at(l, group(l, g).id, t)),
  closeTab: (l, [g, t]) => closeTab(l, group(l, g).id, at(l, group(l, g).id, t)),
  closeTabs: (l, [g, mask]) => closeTabs(l, group(l, g).id, (_, i) => ((mask >> i) & 1) === 1),
  keepTab: (l, [g, t]) => keepTab(l, group(l, g).id, at(l, group(l, g).id, t)),
  keepFile: (l, [f]) => keepFile(l, file(f)),
  moveTab: (l, [g, t, h, u]) => moveTab(l, { group: group(l, g).id, index: at(l, group(l, g).id, t) }, { group: group(l, h).id, index: at(l, group(l, h).id, u) }),
  moveTabToSide: (l, [g, t, h, s]) => moveTab(l, { group: group(l, g).id, index: at(l, group(l, g).id, t) }, { group: group(l, h).id, side: side(s) }),
  split: (l, [s, f]) => split(l, side(s), f % 2 ? file(f) : undefined),
  splitAt: (l, [g, s, i]) => splitAt(l, group(l, g).id, side(s), i % 4 ? item(i) : null),
  only: (l) => only(l),
  focusGroup: (l, [g]) => focusGroup(l, group(l, g).id),
  selectTab: (l, [g, t]) => selectTab(l, group(l, g).id, at(l, group(l, g).id, t)),
  cycleTab: (l, [b]) => cycleTab(l, by(b)),
  cycleGroup: (l, [b]) => cycleGroup(l, by(b)),
  shiftTab: (l, [b]) => shiftTab(l, by(b)),
  focusDirection: (l, [s]) => focusDirection(l, side(s)),
  moveTabDirection: (l, [s]) => moveTabDirection(l, side(s)),
  resizeSplit: (l, [p, ...n]) => {
    const paths = splitPaths(l.root);
    if (!paths.length) return l;
    const path = paths[p % paths.length];
    const target = path.reduce<Node>((node, i) => (node as Split).children[i], l.root) as Split;
    return resizeSplit(l, path, target.children.map((_, i) => (n[i % n.length] % 12) / 10 - 0.1));
  },
  resizeFocused: (l, [axis, b]) => resizeFocused(l, axis % 2 ? "row" : "column", (b % 13) / 10 - 0.6),
  equalize: (l) => equalize(l),
};

type Step = { op: string; n: number[] };
// Opening and splitting come up more often, so layouts get windows and tabs to work on.
const NAMES = [...Object.keys(OPS), "openTab", "openTab", "showInTab", "split", "splitAt", "moveTabToSide"];
const steps = (r: Rng): Step[] => r.array(1, 40, () => ({ op: r.pick(NAMES), n: r.array(4, 4, () => r.int(0, 99)) }));
const run = (s: Step[], l = emptyLayout()) => s.reduce((l, { op, n }) => OPS[op](l, n), l);

function assertTiles(l: Layout) {
  const all = [...rects(l.root).values()];
  const area = all.reduce((sum, r) => sum + r.w * r.h, 0);
  assert.ok(Math.abs(area - 1) < 1e-9, `the windows' areas add up to ${area}, not 1`);
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(overlap < 1e-9, `windows overlap: ${JSON.stringify([a, b])}`);
    }
  }
}

const saved = (l: Layout) => parseLayout(JSON.parse(JSON.stringify(l)))!;
const sizesOf = (n: Node): number[] => (n.kind === "group" ? [] : [...n.sizes, ...n.children.flatMap(sizesOf)]);
const shapeOf = (n: Node): unknown => (n.kind === "group" ? n : { ...n, sizes: n.sizes.length, children: n.children.map(shapeOf) });

test("after any sequence of window and tab commands, the layout is tidy, saves and reads back as itself, and its windows tile the screen", () => {
  forAll(steps, (s) => {
    let l = emptyLayout();
    for (const [step, { op, n }] of s.entries()) {
      l = OPS[op](l, n);
      assert.deepEqual({ step, problems: layoutProblems(l) }, { step, problems: [] });
      const back = saved(l);
      assert.deepEqual({ ...back, root: shapeOf(back.root) }, { ...l, root: shapeOf(l.root) }, `step ${step} reads back`);
      sizesOf(back.root).forEach((size, i) => assert.ok(Math.abs(size - sizesOf(l.root)[i]) < 1e-12, `step ${step} reads back its sizes`));
      assertTiles(l);
    }
  });
});

test(
  "a layout reads back with exactly the sizes it was saved with",
  () => forAll(steps, (s) => assert.deepEqual(saved(run(s)), run(s))),
);

test("closing the only tab of a window that isn't the last closes that window, and the windows left fill the screen", () => {
  forAll(steps, (s) => {
    let l = run(s);
    const lone = (x: Layout) => (groups(x).length > 1 ? groups(x).filter((g) => g.tabs.length === 1) : []);
    if (!lone(l).length) l = split(l, side(s.length), file(s.length));
    const closing = lone(l)[s.length % lone(l).length];
    const next = closeTab(l, closing.id, 0);
    assert.deepEqual(groups(next), groups(l).filter((g) => g.id !== closing.id), "the other windows stay as they were");
    assert.deepEqual(layoutProblems(next), []);
    assertTiles(next);
  });
});

test("the problems a layout can have are named", () => {
  const g = (id: string, tabs: Openable[] = [], active = 0) => ({ kind: "group" as const, id, tabs, active });
  assert.deepEqual(layoutProblems(emptyLayout()), []);
  assert.deepEqual(
    layoutProblems({
      root: {
        kind: "split",
        dir: "row",
        children: [g("g1", [{ file: FILES[0] }, { file: FILES[0] }], 2), { kind: "split", dir: "row", children: [g("g1")], sizes: [0.4] }],
        sizes: [0.5, 0.4],
      },
      focus: "g9",
    }),
    [
      "root: sizes add up to 0.9",
      "root.0: active 2 of 2 tabs",
      "root.0: the same tab twice",
      "root.1: a row split inside a row split",
      "root.1: a split of 1",
      "root.1: sizes add up to 0.4",
      "root.1.0: group id g1 is used twice",
      'focus "g9" names no group',
    ],
  );
});
