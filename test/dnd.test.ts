import assert from "node:assert/strict";
import { test } from "node:test";
import { dropZone, tabIndexAt } from "../web/src/extensions/workbench/dnd.ts";

test("a drop near a window's edge splits that way; anywhere else is its center", () => {
  const rect = { left: 0, top: 0, width: 400, height: 200 };
  assert.equal(dropZone(rect, 20, 100), "left");
  assert.equal(dropZone(rect, 390, 100), "right");
  assert.equal(dropZone(rect, 200, 10), "up");
  assert.equal(dropZone(rect, 200, 195), "down");
  assert.equal(dropZone(rect, 200, 100), "center");
  assert.equal(dropZone(rect, 120, 100), "center");
});

test("a drop in a tab bar lands before the tab whose middle it's left of", () => {
  const tabs = [
    { left: 0, width: 100 },
    { left: 100, width: 80 },
  ];
  assert.equal(tabIndexAt(tabs, 30), 0);
  assert.equal(tabIndexAt(tabs, 60), 1);
  assert.equal(tabIndexAt(tabs, 150), 2);
  assert.equal(tabIndexAt([], 10), 0);
});

test("a tab dragged in from another window of the app opens its note here, rather than moving one of this window's tabs", async () => {
  const { DRAG_TYPE, dragged, startDrag, endDrag } = await import("../web/src/extensions/workbench/dnd.ts");
  const event = (data: string) => ({ dataTransfer: { types: [DRAG_TYPE, "text/plain"], getData: (t: string) => (t === DRAG_TYPE ? data : "") } }) as unknown as DragEvent;
  const tab = { item: { file: "Plan.md" }, from: { group: "g1", index: 0 } };
  assert.deepEqual(dragged(event(JSON.stringify(tab))), { item: { file: "Plan.md" } }, "from another window: just the note");
  const set: Record<string, string> = {};
  const here = { dataTransfer: { setData: (t: string, v: string) => (set[t] = v), effectAllowed: "" } } as unknown as DragEvent;
  startDrag(here, tab as never, "Plan");
  assert.equal(here.dataTransfer!.effectAllowed, "copyMove", "another window may take a copy");
  assert.deepEqual(dragged(event("")), tab, "while dragging over this page: what it started");
  assert.deepEqual(dragged(event(set[DRAG_TYPE])), tab, "dropped on this page: the tab, to move");
  endDrag();
});

test("a drag of this page's that never ended isn't taken for the next drop from outside", async () => {
  const { DRAG_TYPE, dragged, startDrag } = await import("../web/src/extensions/workbench/dnd.ts");
  const event = (data: string) => ({ dataTransfer: { types: [DRAG_TYPE], getData: (t: string) => (t === DRAG_TYPE ? data : "") } }) as unknown as DragEvent;
  const here = { dataTransfer: { setData: () => {}, effectAllowed: "" } } as unknown as DragEvent;
  // Its tab was drawn again mid-drag, so its dragend never came.
  startDrag(here, { item: { file: "Plan.md" }, from: { group: "g1", index: 0 } } as never, "Plan");
  const outside = { item: { file: "Other.md" }, from: { group: "g1", index: 0 }, drag: "someone-else" };
  assert.deepEqual(dragged(event(JSON.stringify(outside))), { item: { file: "Other.md" } }, "the drop from outside, as it is");
  assert.equal(dragged(event("")), null, "and the old one is forgotten");
});

test("a drop from outside the page opens a note at most: never a settings or code file, a view, or a tab to move", async () => {
  const { DRAG_TYPE, dragged, droppable } = await import("../web/src/extensions/workbench/dnd.ts");
  const event = (data: string) => ({ dataTransfer: { types: [DRAG_TYPE], getData: (t: string) => (t === DRAG_TYPE ? data : "") } }) as unknown as DragEvent;
  for (const payload of [
    { item: { file: ".common-ink/settings.json" }, from: { group: "g1", index: 0 } },
    { item: { file: ".common-ink/layout.json" } },
    { item: { file: ".common-ink/extensions/reading-time/main.js" } },
    { item: { file: ".common-ink/users/x/notes.md" } },
    { item: { view: "extensions" } },
    { item: { file: 123 } },
    { item: { file: "../x.md" } },
    { item: "Shopping.md" },
    { item: null },
    { from: { group: "g1", index: 0 } },
    null,
  ]) {
    assert.equal(dragged(event(JSON.stringify(payload))), null, JSON.stringify(payload));
  }
  assert.equal(dragged(event("{not json")), null);
  assert.deepEqual(dragged(event(JSON.stringify({ item: { file: "Projects/Plan.md" }, from: { group: "g1", index: 2 } }))), { item: { file: "Projects/Plan.md" } });
  // While dragging, the browser hides what's dragged in from outside: it's taken, and read on drop.
  assert.equal(droppable(event("")), true);
  assert.equal(dragged(event("")), null);
  assert.equal(droppable({ dataTransfer: { types: ["text/plain"] } } as unknown as DragEvent), false);
});
