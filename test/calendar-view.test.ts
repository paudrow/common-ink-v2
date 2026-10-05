import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, dragRange, monthWeeks, period, placeDay, snap, startOfWeek, step, title } from "../web/src/extensions/calendar/model.ts";

const MONDAY = 0;
const SUNDAY = 6;

test("each view's period, and stepping it on and back", () => {
  assert.deepEqual(period("week", "2026-10-08", MONDAY), { start: "2026-10-05", days: 7 });
  assert.deepEqual(period("week", "2026-10-08", SUNDAY), { start: "2026-10-04", days: 7 });
  assert.deepEqual(period("3day", "2026-10-08", MONDAY), { start: "2026-10-08", days: 3 });
  assert.deepEqual(period("month", "2026-02-14", MONDAY), { start: "2026-02-01", days: 28 });
  assert.deepEqual(period("year", "2028-06-01", MONDAY), { start: "2028-01-01", days: 366 });
  assert.equal(step("week", "2026-10-08", 1, MONDAY), "2026-10-12");
  assert.equal(step("3day", "2026-10-08", -1, MONDAY), "2026-10-05");
  assert.equal(step("month", "2026-01-31", 1, MONDAY), "2026-02-01");
  assert.equal(step("year", "2026-10-08", -1, MONDAY), "2025-01-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(startOfWeek("2026-10-04", MONDAY), "2026-09-28");
});

test("the toolbar's title for each view", () => {
  assert.equal(title("week", "2026-10-08", MONDAY, "en-US"), "Oct 5 – 11, 2026");
  assert.equal(title("week", "2026-10-29", MONDAY, "en-US"), "Oct 26 – Nov 1, 2026");
  assert.equal(title("week", "2026-12-30", MONDAY, "en-US"), "Dec 28, 2026 – Jan 3, 2027");
  assert.equal(title("month", "2026-10-08", MONDAY, "en-US"), "October 2026");
  assert.equal(title("year", "2026-10-08", MONDAY, "en-US"), "2026");
});

test("overlapping events sit side by side, and only as narrow as their busiest moment", () => {
  const placed = placeDay([
    { id: "a", start: 540, end: 600 },
    { id: "b", start: 570, end: 630 },
    { id: "c", start: 600, end: 660 },
    { id: "d", start: 720, end: 750 },
  ]);
  assert.deepEqual(
    placed.map((p) => `${p.id} ${p.column}/${p.columns}`),
    ["a 0/2", "b 1/2", "c 0/2", "d 0/1"],
  );
  // A five-minute event is drawn 25 minutes tall, so one starting right after it sits beside it.
  assert.deepEqual(placeDay([{ id: "x", start: 540, end: 545 }, { id: "y", start: 550, end: 600 }]).map((p) => `${p.id} ${p.column}/${p.columns}`), ["x 0/2", "y 1/2"]);
});

test("drags snap to a quarter hour, either way, and make at least a quarter hour", () => {
  assert.equal(snap(547), 540);
  assert.equal(snap(553), 555);
  assert.deepEqual(dragRange(612, 548), { start: 540, end: 615 });
  assert.deepEqual(dragRange(600, 601), { start: 600, end: 615 });
});

test("a month is drawn as whole weeks", () => {
  const weeks = monthWeeks("2026-10-15", MONDAY);
  assert.equal(weeks.length, 5);
  assert.deepEqual([weeks[0][0], weeks.at(-1)!.at(-1)], ["2026-09-28", "2026-11-01"]);
  assert.equal(monthWeeks("2026-02-01", SUNDAY).length, 4, "February 2026 starts on a Sunday and fills four weeks");
});
