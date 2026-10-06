// The recurrence examples of RFC 5545, section 3.8.5.3, expanded the way the calendar expands a
// series (occurrences in worker/src/calendar.ts). Each starts at 09:00 in New York, as the RFC's do,
// and lists its days there. Rules this engine doesn't read (BYWEEKNO, BYDAY=20MO, HOURLY and
// MINUTELY) are left out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { occurrences, wallTimeAt, type CalendarEvent } from "../worker/src/calendar.ts";

const NY = "America/New_York";

/** The days a series starting at 09:00 on `start` happens on, up to `until`, from its RRULE (and any EXDATE) lines. */
function days(start: string, lines: string[], until: string): string[] {
  const series = { id: "s", calendar: "c", title: "", status: "confirmed", allDay: false, start: `${start}T09:00:00`, end: `${start}T10:00:00`, timeZone: NY, recurrence: lines } as CalendarEvent;
  const from = Date.parse(`${start}T00:00:00Z`) - 86_400_000;
  const to = Date.parse(`${until}T23:59:59Z`) + 86_400_000;
  const found = occurrences([series], { from, to, zone: NY }, (_c, id) => id).map((o) => wallTimeAt(Date.parse(o.start), NY));
  assert.ok(found.every((w) => w.endsWith("T09:00:00")), `every occurrence is at 09:00 in New York: ${found.filter((w) => !w.endsWith("T09:00:00"))}`);
  return found.map((w) => w.slice(0, 10)).filter((d) => d <= until);
}

const ymd = (year: number, list: string) => list.split(" ").map((md) => `${year}-${md}`);

const vectors: Array<[string, string, string[], string, string[]]> = [
  ["daily for 10 occurrences", "1997-09-02", ["RRULE:FREQ=DAILY;COUNT=10"], "1998-12-31", ymd(1997, "09-02 09-03 09-04 09-05 09-06 09-07 09-08 09-09 09-10 09-11")],
  ["every 10 days, 5 occurrences", "1997-09-02", ["RRULE:FREQ=DAILY;INTERVAL=10;COUNT=5"], "1998-12-31", ymd(1997, "09-02 09-12 09-22 10-02 10-12")],
  ["every other day, the first ones", "1997-09-02", ["RRULE:FREQ=DAILY;INTERVAL=2"], "1997-09-12", ymd(1997, "09-02 09-04 09-06 09-08 09-10 09-12")],
  ["weekly for 10 occurrences", "1997-09-02", ["RRULE:FREQ=WEEKLY;COUNT=10"], "1998-12-31", ymd(1997, "09-02 09-09 09-16 09-23 09-30 10-07 10-14 10-21 10-28 11-04")],
  ["every other week, week starting Sunday", "1997-09-02", ["RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU"], "1997-11-30", ymd(1997, "09-02 09-16 09-30 10-14 10-28 11-11 11-25")],
  ["weekly on Tuesday and Thursday for five weeks, by UNTIL", "1997-09-02", ["RRULE:FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH"], "1998-12-31", ymd(1997, "09-02 09-04 09-09 09-11 09-16 09-18 09-23 09-25 09-30 10-02")],
  ["weekly on Tuesday and Thursday for five weeks, by COUNT", "1997-09-02", ["RRULE:FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH"], "1998-12-31", ymd(1997, "09-02 09-04 09-09 09-11 09-16 09-18 09-23 09-25 09-30 10-02")],
  [
    "every other week on Monday, Wednesday and Friday until December 24",
    "1997-09-01",
    ["RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR"],
    "1998-12-31",
    ymd(1997, "09-01 09-03 09-05 09-15 09-17 09-19 09-29 10-01 10-03 10-13 10-15 10-17 10-27 10-29 10-31 11-10 11-12 11-14 11-24 11-26 11-28 12-08 12-10 12-12 12-22"),
  ],
  ["every other week on Tuesday and Thursday, 8 occurrences", "1997-09-02", ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH"], "1998-12-31", ymd(1997, "09-02 09-04 09-16 09-18 09-30 10-02 10-14 10-16")],
  ["monthly on the first Friday, 10 occurrences", "1997-09-05", ["RRULE:FREQ=MONTHLY;COUNT=10;BYDAY=1FR"], "1998-12-31", [...ymd(1997, "09-05 10-03 11-07 12-05"), ...ymd(1998, "01-02 02-06 03-06 04-03 05-01 06-05")]],
  ["monthly on the first Friday until December 24", "1997-09-05", ["RRULE:FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR"], "1998-12-31", ymd(1997, "09-05 10-03 11-07 12-05")],
  ["every other month on the first and last Sunday, 10 occurrences", "1997-09-07", ["RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU"], "1998-12-31", [...ymd(1997, "09-07 09-28 11-02 11-30"), ...ymd(1998, "01-04 01-25 03-01 03-29 05-03 05-31")]],
  ["monthly on the second-to-last Monday for 6 months", "1997-09-22", ["RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=-2MO"], "1998-12-31", [...ymd(1997, "09-22 10-20 11-17 12-22"), ...ymd(1998, "01-19 02-16")]],
  ["monthly on the third-to-last day", "1997-09-28", ["RRULE:FREQ=MONTHLY;BYMONTHDAY=-3"], "1998-02-28", [...ymd(1997, "09-28 10-29 11-28 12-29"), ...ymd(1998, "01-29 02-26")]],
  ["monthly on the 2nd and 15th, 10 occurrences", "1997-09-02", ["RRULE:FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15"], "1998-12-31", [...ymd(1997, "09-02 09-15 10-02 10-15 11-02 11-15 12-02 12-15"), ...ymd(1998, "01-02 01-15")]],
  ["monthly on the first and last day, 10 occurrences", "1997-09-30", ["RRULE:FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1"], "1998-12-31", [...ymd(1997, "09-30 10-01 10-31 11-01 11-30 12-01 12-31"), ...ymd(1998, "01-01 01-31 02-01")]],
  ["every 18 months on the 10th to 15th, 10 occurrences", "1997-09-10", ["RRULE:FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15"], "2000-12-31", [...ymd(1997, "09-10 09-11 09-12 09-13 09-14 09-15"), ...ymd(1999, "03-10 03-11 03-12 03-13")]],
  ["every Tuesday, every other month", "1997-09-02", ["RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=TU"], "1998-01-31", [...ymd(1997, "09-02 09-09 09-16 09-23 09-30 11-04 11-11 11-18 11-25"), ...ymd(1998, "01-06 01-13 01-20 01-27")]],
  ["yearly in June and July, 10 occurrences", "1997-06-10", ["RRULE:FREQ=YEARLY;COUNT=10;BYMONTH=6,7"], "2002-12-31", [1997, 1998, 1999, 2000, 2001].flatMap((y) => ymd(y, "06-10 07-10"))],
  ["every other year in January, February and March, 10 occurrences", "1997-03-10", ["RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3"], "2004-12-31", [...ymd(1997, "03-10"), ...[1999, 2001, 2003].flatMap((y) => ymd(y, "01-10 02-10 03-10"))]],
  [
    "every third year on the 1st, 100th and 200th day, 10 occurrences",
    "1997-01-01",
    ["RRULE:FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200"],
    "2007-12-31",
    [...ymd(1997, "01-01 04-10 07-19"), ...ymd(2000, "01-01 04-09 07-18"), ...ymd(2003, "01-01 04-10 07-19"), ...ymd(2006, "01-01")],
  ],
  ["every Thursday in March", "1997-03-13", ["RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=TH"], "1999-12-31", [...ymd(1997, "03-13 03-20 03-27"), ...ymd(1998, "03-05 03-12 03-19 03-26"), ...ymd(1999, "03-04 03-11 03-18 03-25")]],
  [
    "every Thursday, but only in June, July and August",
    "1997-06-05",
    ["RRULE:FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8"],
    "1997-12-31",
    ymd(1997, "06-05 06-12 06-19 06-26 07-03 07-10 07-17 07-24 07-31 08-07 08-14 08-21 08-28"),
  ],
  ["every Friday the 13th, without the start", "1997-09-02", ["EXDATE;TZID=America/New_York:19970902T090000", "RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13"], "2000-12-31", [...ymd(1998, "02-13 03-13 11-13"), ...ymd(1999, "08-13"), ...ymd(2000, "10-13")]],
  [
    "the first Saturday after the first Sunday of the month",
    "1997-09-13",
    ["RRULE:FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13"],
    "1998-06-30",
    [...ymd(1997, "09-13 10-11 11-08 12-13"), ...ymd(1998, "01-10 02-07 03-07 04-11 05-09 06-13")],
  ],
  ["every 4 years, the first Tuesday after a Monday in November", "1996-11-05", ["RRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8"], "2004-12-31", ["1996-11-05", "2000-11-07", "2004-11-02"]],
  ["the third of each month's Tuesdays, Wednesdays and Thursdays, for 3 months", "1997-09-04", ["RRULE:FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3"], "1998-12-31", ymd(1997, "09-04 10-07 11-06")],
  ["the second-to-last weekday of the month", "1997-09-29", ["RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2"], "1998-03-31", [...ymd(1997, "09-29 10-30 11-27 12-30"), ...ymd(1998, "01-29 02-26 03-30")]],
  ["weeks starting Monday change which days an every-other-week rule picks", "1997-08-05", ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO"], "1998-12-31", ymd(1997, "08-05 08-10 08-19 08-24")],
  ["weeks starting Sunday change which days an every-other-week rule picks", "1997-08-05", ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU"], "1998-12-31", ymd(1997, "08-05 08-17 08-19 08-31")],
  ["a day of the month a month doesn't have is skipped", "2007-01-15", ["RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5"], "2007-12-31", ymd(2007, "01-15 01-30 02-15 03-15 03-30")],
];

for (const [what, start, lines, until, expected] of vectors) {
  test(`RFC 5545: ${what}`, () => assert.deepEqual(days(start, lines, until), expected));
}

test("RFC 5545: every day in January for 3 years, written yearly and daily, is the same days", () => {
  const january = [1998, 1999, 2000].flatMap((y) => Array.from({ length: 31 }, (_, d) => `${y}-01-${String(d + 1).padStart(2, "0")}`));
  assert.deepEqual(days("1998-01-01", ["RRULE:FREQ=YEARLY;UNTIL=20000131T140000Z;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA"], "2000-12-31"), january);
  assert.deepEqual(days("1998-01-01", ["RRULE:FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1"], "2000-12-31"), january);
});

test("RFC 5545: daily until December 24 ends on the 23rd, since UNTIL is midnight UTC, 19:00 the 23rd in New York", () => {
  const found = days("1997-09-02", ["RRULE:FREQ=DAILY;UNTIL=19971224T000000Z"], "1998-12-31");
  assert.deepEqual([found.length, found[0], found.at(-1)], [113, "1997-09-02", "1997-12-23"]);
});
