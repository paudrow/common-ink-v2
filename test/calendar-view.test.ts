import assert from "node:assert/strict";
import { test } from "node:test";
import type { Occurrence } from "common-ink/calendar";
import { addMonths, dragRange, monthWeeks, period, placeDay, snap, startOfWeek, step, title } from "../web/src/extensions/calendar/model.ts";
import { dropped } from "../web/src/extensions/calendar/views.ts";

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

test("the event editor goes beside its event, and stays on screen when the event is off it", async () => {
  Object.assign(globalThis, { window: { innerWidth: 1200, innerHeight: 800 } });
  const { place } = await import("../web/src/extensions/calendar/editor.ts");
  const at = (left: number, top: number) => ({ left, right: left + 130, top, bottom: top + 36, width: 130, height: 36 }) as DOMRect;
  const placed = (rect: DOMRect) => {
    const box = { getBoundingClientRect: () => ({ width: 366, height: 455 }), style: { left: "", top: "" } } as unknown as HTMLElement;
    place(box, rect);
    return [box.style.left, box.style.top];
  };
  assert.deepEqual(placed(at(300, 200)), ["438px", "200px"], "to its right");
  assert.deepEqual(placed(at(900, 200)), ["526px", "200px"], "to its left, with no room on the right");
  assert.deepEqual(placed(at(2480, 200)), ["826px", "200px"], "an event off to the right: at the right edge");
  assert.deepEqual(placed(at(-900, 700)), ["8px", "337px"], "an event off to the left and low: at the left edge, all of it on screen");
});

function inNewYork(check: () => void) {
  const was = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    check();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

const timed = (start: string, end: string): Occurrence => ({ address: "event:sample/personal/x", id: "x", calendar: "personal", title: "X", status: "confirmed", allDay: false, start, end });

test("a dropped event keeps its wall-clock times across a month's end and the nights the clocks change", () => {
  inNewYork(() => {
    // 14:30–15:15 on Saturday 31 October, the night before the clocks go back, dropped on Sunday at 16:15.
    const halloween = timed("2026-10-31T18:30:00.000Z", "2026-10-31T19:15:00.000Z");
    assert.deepEqual(dropped(halloween, { kind: "move", startDay: "2026-10-31", day: "2026-11-01", start: 975, end: 1020 }), { allDay: false, startDay: "2026-11-01", start: 975, endDay: "2026-11-01", end: 1020 });
    // Dragged late on the same day, it ends past midnight, on the next day.
    assert.deepEqual(dropped(halloween, { kind: "move", startDay: "2026-10-31", day: "2026-10-31", start: 1410, end: 1455 }), { allDay: false, startDay: "2026-10-31", start: 1410, endDay: "2026-11-01", end: 15 });
    // 01:30–03:30 on 8 March, across the hour the clocks skip, moved a day on: the same times on the clock.
    const springForward = timed("2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z");
    assert.deepEqual(dropped(springForward, { kind: "move", startDay: "2026-03-08", day: "2026-03-09", start: 90, end: 210 }), { allDay: false, startDay: "2026-03-09", start: 90, endDay: "2026-03-09", end: 210 });
    // 22:30–23:30 on Saturday 7 March, already Sunday in UTC, moved on to the night the clocks go forward.
    const saturdayNight = timed("2026-03-08T03:30:00.000Z", "2026-03-08T04:30:00.000Z");
    assert.deepEqual(dropped(saturdayNight, { kind: "move", startDay: "2026-03-07", day: "2026-03-08", start: 1350, end: 1410 }), { allDay: false, startDay: "2026-03-08", start: 1350, endDay: "2026-03-08", end: 1410 });
    // 09:00–10:00 on 28 February: its end dragged to 11:30, and the event moved over the month's end.
    const february = timed("2026-02-28T14:00:00.000Z", "2026-02-28T15:00:00.000Z");
    assert.deepEqual(dropped(february, { kind: "resize", startDay: "2026-02-28", day: "2026-02-28", start: 540, end: 690 }), { allDay: false, startDay: "2026-02-28", start: 540, endDay: "2026-02-28", end: 690 });
    assert.deepEqual(dropped(february, { kind: "move", startDay: "2026-02-28", day: "2026-03-01", start: 540, end: 600 }), { allDay: false, startDay: "2026-03-01", start: 540, endDay: "2026-03-01", end: 600 });
  });
});

test("an event that runs past midnight keeps its length when it's moved, and a resize changes only its end", () => {
  inNewYork(() => {
    // 22:00 on Monday 5 October to 02:00 on Tuesday: drawn as a part on each day.
    const late = timed("2026-10-06T02:00:00.000Z", "2026-10-06T06:00:00.000Z");
    assert.deepEqual(dropped(late, { kind: "resize", startDay: "2026-10-06", day: "2026-10-06", start: 0, end: 180 }), { allDay: false, startDay: "2026-10-05", start: 1320, endDay: "2026-10-06", end: 180 }, "Tuesday's end dragged to 03:00");
    assert.deepEqual(dropped(late, { kind: "resize", startDay: "2026-10-05", day: "2026-10-05", start: 1320, end: 1380 }), { allDay: false, startDay: "2026-10-05", start: 1320, endDay: "2026-10-05", end: 1380 }, "Monday's end dragged to 23:00");
    assert.deepEqual(dropped(late, { kind: "move", startDay: "2026-10-05", day: "2026-10-05", start: 1380, end: 1440 }), { allDay: false, startDay: "2026-10-05", start: 1380, endDay: "2026-10-06", end: 180 }, "Monday's part an hour later");
    assert.deepEqual(dropped(late, { kind: "move", startDay: "2026-10-06", day: "2026-10-07", start: 60, end: 180 }), { allDay: false, startDay: "2026-10-06", start: 1380, endDay: "2026-10-07", end: 180 }, "Tuesday's part to Wednesday at 01:00");
  });
});
