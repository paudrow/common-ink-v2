import { test } from "node:test";
import assert from "node:assert/strict";
import { endsLabel, formatRule, nextDue, occurrences, parseRule, ruleLabel, ruleProblem } from "../web/src/extensions/tasks/recurrence.ts";

const next = (token: string, due: string | null, done = "2026-01-01") => nextDue(parseRule(token)!, due, done);
const three = (token: string, from: string) => occurrences(parseRule(token)!, from, 3);

test("an RRULE can end with COUNT or UNTIL, and a rule's ends read as words", () => {
  const counted = parseRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=6;COUNT=5")!;
  assert.deepEqual([counted.count, counted.until], [5, undefined]);
  assert.equal(formatRule(counted), "RRULE:FREQ=MONTHLY;BYMONTHDAY=6;COUNT=5");
  assert.equal(parseRule("RRULE:FREQ=WEEKLY;UNTIL=20270630T000000Z")!.until, "2027-06-30");
  assert.equal(formatRule(parseRule("RRULE:FREQ=WEEKLY;UNTIL=20270630")!), "RRULE:FREQ=WEEKLY;UNTIL=20270630");
  assert.deepEqual(["RRULE:FREQ=WEEKLY;COUNT=0", "RRULE:FREQ=WEEKLY;UNTIL=2027", "RRULE:FREQ=WEEKLY;UNTIL=20270231"].map(parseRule), [null, null, null]);
  assert.deepEqual([endsLabel({ times: 5, until: null }), endsLabel({ times: null, until: "2027-06-30" }), endsLabel({ times: 2, until: "2027-06-30" }), endsLabel({ times: null, until: null })], ["5 left", "until Jun 30", "2 left · until Jun 30", ""]);
  assert.deepEqual([endsLabel({ times: 5, until: null }, true), endsLabel({ times: 1, until: null }, true), endsLabel({ times: null, until: "2027-06-30" }, true)], [", 5 more times", ", this is the last time", ", until June 30, 2027"]);
});

test("every token reads to a rule and writes back as itself", () => {
  const tokens = [
    "daily", "weekly", "monthly", "yearly", "3d", "2w", "2m",
    "mon,thu", "2w-mon,thu", "6th", "last-day", "1st-tue", "1st-tue,3rd-tue", "last-fri", "2nd-mon",
    "mar-1", "1st-mon-mar", "day-50", "after-1m", "after-10d", "after-2w",
    "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2WE",
  ];
  for (const t of tokens) assert.equal(formatRule(parseRule(t)!), t, t);
  assert.deepEqual(["1y", "+1w", "1d"].map((t) => formatRule(parseRule(t)!)), ["yearly", "weekly", "daily"]); // a gap of one is written as its word; todo.txt's +1w reads as ours (from the due date)
  assert.equal(formatRule(parseRule("RRULE:FREQ=WEEKLY;BYDAY=MO,TH")!), "mon,thu"); // an RRULE we have a word for
  assert.deepEqual(["2 weeks", "after-1st-tue", "RRULE:FREQ=HOURLY", "RRULE:FREQ=DAILY;COUNT=0", "0d", "32nd", "5th-sun-feb-x"].map(parseRule), [null, null, null, null, null, null, null]);
});

test("from the due date: a bill due on the 6th and paid early is next due on the 6th", () => {
  assert.equal(next("6th", "2026-10-06", "2026-10-04"), "2026-11-06");
  assert.equal(next("monthly", "2026-10-06", "2026-10-04"), "2026-11-06");
  assert.equal(next("2w", "2026-10-06"), "2026-10-20");
  assert.equal(next("yearly", "2026-10-06"), "2027-10-06");
  assert.equal(next("3d", "2026-10-06T09:30"), "2026-10-09T09:30"); // the time of day stays
  assert.equal(next("weekly", null, "2026-10-04"), "2026-10-11"); // no due date: from the day it was done
});

test("from completion: dog medicine given on the 8th is next due on the 8th of next month", () => {
  assert.equal(next("after-1m", "2026-10-01", "2026-10-08"), "2026-11-08");
  assert.equal(next("after-10d", "2026-10-01", "2026-10-08"), "2026-10-18");
  assert.equal(next("after-1m", null, "2026-01-31"), "2026-02-28"); // a month after the 31st is the month's last day
  assert.equal(ruleProblem("after-1st-tue"), "\"after-\" repeats a gap after it's done (after-1m, after-10d), not a calendar rule");
  assert.equal(ruleProblem("RRULE:FREQ=MONTHLY;BYDAY=1TU"), null);
});

test("weekdays, and every other week", () => {
  assert.deepEqual(three("mon,thu", "2026-10-01"), ["2026-10-05", "2026-10-08", "2026-10-12"]); // Oct 1 2026 is a Thursday
  assert.deepEqual(three("2w-mon,thu", "2026-10-01"), ["2026-10-12", "2026-10-15", "2026-10-26"]);
});

test("the nth weekday of the month, and a 5th Tuesday that some months don't have", () => {
  assert.deepEqual(three("1st-tue,3rd-tue", "2026-10-06"), ["2026-10-20", "2026-11-03", "2026-11-17"]);
  assert.deepEqual(three("last-fri", "2026-10-01"), ["2026-10-30", "2026-11-27", "2026-12-25"]);
  assert.deepEqual(three("RRULE:FREQ=MONTHLY;BYDAY=5TU", "2026-09-29"), ["2026-12-29", "2027-03-30", "2027-06-29"]);
});

test("month ends and Feb 29 skip the months and years that don't have the day (RFC 5545)", () => {
  assert.deepEqual(three("monthly", "2026-01-31"), ["2026-03-31", "2026-05-31", "2026-07-31"]);
  assert.deepEqual(three("last-day", "2026-01-31"), ["2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.deepEqual(three("31st", "2026-01-31"), ["2026-03-31", "2026-05-31", "2026-07-31"]);
  assert.deepEqual(three("yearly", "2024-02-29"), ["2028-02-29", "2032-02-29", "2036-02-29"]);
  assert.deepEqual(three("feb-29", "2096-02-29"), ["2104-02-29", "2108-02-29", "2112-02-29"]); // 2100 isn't a leap year
});

test("yearly on a date, on the nth weekday of a month, and on a day of the year", () => {
  assert.deepEqual(three("mar-1", "2026-10-01"), ["2027-03-01", "2028-03-01", "2029-03-01"]);
  assert.deepEqual(three("1st-mon-mar", "2026-10-01"), ["2027-03-01", "2028-03-06", "2029-03-05"]);
  assert.deepEqual(three("day-50", "2026-10-01"), ["2027-02-19", "2028-02-19", "2029-02-19"]);
});

test("dates stay dates across a daylight-saving change, whatever the machine's time zone", () => {
  const was = process.env.TZ;
  for (const tz of ["America/New_York", "Europe/London", "Australia/Sydney"]) {
    process.env.TZ = tz;
    assert.deepEqual(three("daily", "2026-03-07"), ["2026-03-08", "2026-03-09", "2026-03-10"], tz);
    assert.deepEqual(three("weekly", "2026-10-25"), ["2026-11-01", "2026-11-08", "2026-11-15"], tz);
    assert.deepEqual(three("sun", "2026-03-28"), ["2026-03-29", "2026-04-05", "2026-04-12"], tz);
  }
  process.env.TZ = was;
});

test("a rule says what it does, short for a chip and long for the editor", () => {
  const both = (t: string) => [ruleLabel(parseRule(t)!), ruleLabel(parseRule(t)!, true)];
  assert.deepEqual(both("1st-tue,3rd-tue"), ["1st & 3rd Tue", "Every month on the 1st and 3rd Tuesday"]);
  assert.deepEqual(both("last-fri"), ["Last Fri", "Every month on the last Friday"]);
  assert.deepEqual(both("mar-1"), ["Mar 1", "Every year on March 1"]);
  assert.deepEqual(both("after-1m"), ["Monthly after done", "A month after it's done"]);
  assert.deepEqual(both("2w-mon,thu"), ["Every 2 wks: Mon, Thu", "Every 2 weeks on Monday and Thursday"]);
  assert.deepEqual(both("day-50"), ["Day 50", "Every year on day 50"]);
  assert.deepEqual(both("6th"), ["6th", "Every month on the 6th"]);
  assert.deepEqual(both("2w"), ["Every 2 weeks", "Every 2 weeks"]);
  assert.deepEqual(both("RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=2WE"), ["Every 2 mos: 2nd Wed", "Every 2 months on the 2nd Wednesday"]);
});
