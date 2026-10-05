import assert from "node:assert/strict";
import { test } from "node:test";
import { findTarget, instantOf, occurrences, parseEvent, planDelete, planUpdate, wallTimeAt, type CalendarEvent, type Range } from "../worker/src/calendar.ts";

const LA = "America/Los_Angeles";
const at = (calendar: string, id: string) => `event:sample/${calendar}/${id}`;
const range = (from: string, to: string, zone = "UTC"): Range => ({ from: Date.parse(from), to: Date.parse(to), zone });
const ev = (e: Record<string, unknown>) => {
  const parsed = parseEvent({ calendar: "work", status: "confirmed", ...e });
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
};
const brief = (os: ReturnType<typeof occurrences>) => os.map((o) => `${o.id} ${o.start}`);

test("wall times turn into instants in their zone, across a daylight-saving change", () => {
  assert.equal(new Date(instantOf("2026-10-26T09:00:00", LA)).toISOString(), "2026-10-26T16:00:00.000Z");
  assert.equal(new Date(instantOf("2026-11-02T09:00:00", LA)).toISOString(), "2026-11-02T17:00:00.000Z");
  // 2:30 on the night clocks go forward doesn't exist; it's read as an hour later.
  assert.equal(new Date(instantOf("2027-03-14T02:30:00", LA)).toISOString(), "2027-03-14T10:30:00.000Z");
  assert.equal(wallTimeAt(Date.parse("2026-11-02T17:00:00Z"), LA), "2026-11-02T09:00:00");
});

test("a weekly series keeps its wall time across daylight saving, with ids as Google writes them", () => {
  const standup = ev({ id: "standup", title: "Standup", start: "2026-10-26T09:00", end: "2026-10-26T09:15", timeZone: LA, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] });
  assert.deepEqual(brief(occurrences([standup], range("2026-10-25T00:00Z", "2026-11-10T00:00Z"), at)), [
    "standup_20261026T160000Z 2026-10-26T16:00:00.000Z",
    "standup_20261102T170000Z 2026-11-02T17:00:00.000Z",
    "standup_20261109T170000Z 2026-11-09T17:00:00.000Z",
  ]);
  assert.equal(occurrences([standup], range("2026-11-02T00:00Z", "2026-11-03T00:00Z"), at)[0].address, "event:sample/work/standup_20261102T170000Z");
});

test("a changed occurrence replaces the one it was, a cancelled one is gone, and EXDATE skips a day", () => {
  const series = ev({ id: "s", title: "Review", start: "2026-10-05T15:00", end: "2026-10-05T15:30", timeZone: "UTC", recurrence: ["RRULE:FREQ=DAILY;COUNT=5", "EXDATE:20261008T150000Z"] });
  const moved = ev({ id: "s_20261006T150000Z", title: "Review (late)", start: "2026-10-06T17:00", end: "2026-10-06T17:30", timeZone: "UTC", series: "s", originalStart: "2026-10-06T15:00" });
  const cancelled = ev({ id: "s_20261007T150000Z", title: "Review", start: "2026-10-07T15:00", end: "2026-10-07T15:30", timeZone: "UTC", series: "s", originalStart: "2026-10-07T15:00", status: "cancelled" });
  const os = occurrences([series, moved, cancelled], range("2026-10-01T00:00Z", "2026-11-01T00:00Z"), at);
  assert.deepEqual(brief(os), ["s_20261005T150000Z 2026-10-05T15:00:00.000Z", "s_20261006T150000Z 2026-10-06T17:00:00.000Z", "s_20261009T150000Z 2026-10-09T15:00:00.000Z"]);
  assert.deepEqual([os[1].title, os[1].changed, os[1].series], ["Review (late)", true, "s"]);
});

test("all-day and floating events fall on the viewer's days", () => {
  const offsite = ev({ id: "off", title: "Offsite", allDay: true, start: "2026-10-08", end: "2026-10-10" });
  const lunch = ev({ id: "lunch", title: "Lunch", start: "2026-10-08T12:00", end: "2026-10-08T13:00" });
  const tokyo = range("2026-10-09T00:00+09:00", "2026-10-10T00:00+09:00", "Asia/Tokyo");
  assert.deepEqual(brief(occurrences([offsite, lunch], tokyo, at)), ["off 2026-10-08"]);
  assert.deepEqual(brief(occurrences([lunch], range("2026-10-08T00:00-07:00", "2026-10-09T00:00-07:00", LA), at)), ["lunch 2026-10-08T19:00:00.000Z"]);
});

test("a floating series has the same occurrence ids wherever it's seen from, at the viewer's wall time", () => {
  const lunch = ev({ id: "lunch", title: "Lunch", start: "2026-10-05T12:00", end: "2026-10-05T13:00", recurrence: ["RRULE:FREQ=DAILY;COUNT=2", "EXDATE:20261006T120000"] });
  const moved = ev({ id: "lunch_20261005T120000", title: "Late lunch", start: "2026-10-05T13:00", end: "2026-10-05T14:00", series: "lunch", originalStart: "2026-10-05T12:00" });
  assert.deepEqual(brief(occurrences([lunch, moved], range("2026-10-04T00:00Z", "2026-10-08T00:00Z", "Asia/Tokyo"), at)), ["lunch_20261005T120000 2026-10-05T04:00:00.000Z"]);
  assert.deepEqual(brief(occurrences([lunch], range("2026-10-04T00:00Z", "2026-10-08T00:00Z", LA), at)), ["lunch_20261005T120000 2026-10-05T19:00:00.000Z"]);
  assert.equal(findTarget([lunch], "lunch_20261005T120000", LA)?.kind, "occurrence");
});

test("a series that never ends costs nothing far from now", () => {
  const daily = ev({ id: "d", title: "Walk", start: "2016-01-01T07:00", end: "2016-01-01T07:30", timeZone: "UTC", recurrence: ["RRULE:FREQ=DAILY"] });
  assert.deepEqual(brief(occurrences([daily], range("2036-01-01T00:00Z", "2036-01-02T00:00Z"), at)), ["d_20360101T070000Z 2036-01-01T07:00:00.000Z"]);
});

const series = () => ev({ id: "s", title: "Standup", start: "2026-10-05T09:00", end: "2026-10-05T09:15", timeZone: "UTC", recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"] });
const ids = ["new1"];
const newId = () => ids.shift() ?? "more";

test("editing this occurrence makes a changed occurrence of its own", () => {
  const events = [series()];
  const target = findTarget(events, "s_20261007T090000Z")!;
  assert.equal(target.kind, "occurrence");
  const ops = planUpdate(events, target, { title: "Standup (moved)", timing: { allDay: false, start: "2026-10-07T10:00:00", end: "2026-10-07T10:15:00", timeZone: "UTC" } }, "this", newId);
  assert.deepEqual(ops, [
    {
      op: "put",
      created: true,
      event: { id: "s_20261007T090000Z", calendar: "work", title: "Standup (moved)", status: "confirmed", allDay: false, start: "2026-10-07T10:00:00", end: "2026-10-07T10:15:00", timeZone: "UTC", series: "s", originalStart: "2026-10-07T09:00:00" },
    },
  ]);
});

test("editing all occurrences moves the series by as much as this one moved", () => {
  const events = [series()];
  const ops = planUpdate(events, findTarget(events, "s_20261012T090000Z")!, { timing: { allDay: false, start: "2026-10-12T09:30:00", end: "2026-10-12T10:00:00", timeZone: "UTC" } }, "all", newId);
  assert.equal(ops.length, 1);
  assert.deepEqual([ops[0].event.start, ops[0].event.end, ops[0].event.recurrence], ["2026-10-05T09:30:00", "2026-10-05T10:00:00", ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]]);
});

test("editing this and following splits the series where it is, and drops changed occurrences after it", () => {
  const later = ev({ id: "s_20261021T090000Z", title: "Standup", start: "2026-10-21T11:00", end: "2026-10-21T11:15", timeZone: "UTC", series: "s", originalStart: "2026-10-21T09:00" });
  const events = [series(), later];
  ids.splice(0, ids.length, "s2");
  const ops = planUpdate(events, findTarget(events, "s_20261014T090000Z")!, { title: "Sync" }, "following", newId);
  assert.deepEqual(
    ops.map((o) => [o.op, o.event.id, o.event.title, o.event.start, o.event.recurrence]),
    [
      ["put", "s", "Standup", "2026-10-05T09:00:00", ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261014T085959Z"]],
      ["put", "s2", "Sync", "2026-10-14T09:00:00", ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]],
      ["delete", "s_20261021T090000Z", "Standup", "2026-10-21T11:00:00", undefined],
    ],
  );
  const after = [ops[0].event, ops[1].event];
  assert.deepEqual(
    brief(occurrences(after, range("2026-10-05T00:00Z", "2026-10-20T00:00Z"), at)),
    ["s_20261005T090000Z 2026-10-05T09:00:00.000Z", "s_20261007T090000Z 2026-10-07T09:00:00.000Z", "s_20261012T090000Z 2026-10-12T09:00:00.000Z", "s2_20261014T090000Z 2026-10-14T09:00:00.000Z", "s2_20261019T090000Z 2026-10-19T09:00:00.000Z"],
  );
});

test("a series with COUNT splits its count between the two parts", () => {
  const counted = ev({ id: "c", title: "Course", allDay: true, start: "2026-10-05", end: "2026-10-06", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"] });
  ids.splice(0, ids.length, "c2");
  const ops = planUpdate([counted], findTarget([counted], "c_20261019")!, { title: "Course, part 2" }, "following", newId);
  assert.deepEqual(ops.map((o) => o.event.recurrence), [["RRULE:FREQ=WEEKLY;COUNT=2"], ["RRULE:FREQ=WEEKLY;COUNT=4"]]);
});

test("deleting cancels one occurrence, ends the series before one, or removes it all", () => {
  const events = [series()];
  assert.deepEqual(
    planDelete(events, findTarget(events, "s_20261007T090000Z")!, "this").map((o) => [o.op, o.event.id, o.event.status]),
    [["put", "s_20261007T090000Z", "cancelled"]],
  );
  assert.deepEqual(
    planDelete(events, findTarget(events, "s_20261007T090000Z")!, "following").map((o) => [o.op, o.event.recurrence]),
    [["put", ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261007T085959Z"]]],
  );
  assert.deepEqual(
    planDelete(events, findTarget(events, "s_20261007T090000Z")!, "all").map((o) => [o.op, o.event.id]),
    [["delete", "s"]],
  );
  assert.equal(findTarget(events, "s_20261008T090000Z"), null, "not an occurrence: Thursdays aren't in the rule");
});

test("events are read at the boundary: bad ones say what's wrong", () => {
  assert.equal(parseEvent({ id: "a", calendar: "c", start: "2026-10-05T10:00", end: "2026-10-05T09:00" }), "An event can't end before it starts");
  assert.equal(parseEvent({ id: "a", calendar: "c", allDay: true, start: "2026-10-05", end: "2026-10-05" }), "An all-day event ends on a later day than it starts (the day after its last)");
  assert.equal(parseEvent({ id: "a", calendar: "c", start: "2026-10-05T09:00", end: "2026-10-05T10:00", timeZone: "Mars/Olympus" }), '"Mars/Olympus" isn\'t a time zone, like America/New_York');
  assert.deepEqual(parseEvent({ id: "a", calendar: "c", title: "Hi", start: "2026-10-05T09:00", end: "2026-10-05T10:00", extra: 1 }), {
    id: "a",
    calendar: "c",
    title: "Hi",
    status: "confirmed",
    allDay: false,
    start: "2026-10-05T09:00:00",
    end: "2026-10-05T10:00:00",
  });
});

export type { CalendarEvent };
