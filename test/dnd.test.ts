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
