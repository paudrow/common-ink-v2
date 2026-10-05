// Where daily notes live: one definition, which Tasks asks the Daily notes extension for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyPath, dayOfPath, initialText, nearestDay } from "../web/src/extensions/daily/daily.ts";

test("a day's note is in the daily.folder setting's folder, named by its date, and starts with just its date", () => {
  assert.equal(dailyPath("Journal", "2026-10-05"), "Journal/2026-10-05.md");
  assert.equal(dailyPath(" /Days/ ", "2026-10-05"), "Days/2026-10-05.md");
  assert.equal(dailyPath("", "2026-10-05"), "Journal/2026-10-05.md", "a blank folder is Journal");
  assert.equal(dayOfPath("Journal", "Journal/2026-10-05.md"), "2026-10-05");
  assert.equal(dayOfPath("Journal", "Other/2026-10-05.md"), null);
  assert.equal(dayOfPath("Journal", "Journal/Plans.md"), null);
  assert.equal(initialText("2026-10-05"), "# 2026-10-05\n");
});

test("the previous and next day's note are the nearest ones there are, skipping days with none", () => {
  const days = ["2026-10-01", "2026-10-05", "2026-10-09"];
  assert.equal(nearestDay(days, "2026-10-05", -1), "2026-10-01");
  assert.equal(nearestDay(days, "2026-10-05", 1), "2026-10-09");
  assert.equal(nearestDay(days, "2026-10-07", -1), "2026-10-05", "from a day with no note");
  assert.equal(nearestDay(days, "2026-10-01", -1), null);
});
