import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRule, nextDue, nth, parseRule } from "../../worker/src/recurrence.ts";
import { editTask, editTaskLine, parseTask } from "../../web/src/extensions/tasks/tasks.ts";
import { forAll, type Rng } from "./gen.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
const dayNumber = (date: string) => Date.UTC(parts(date)[0], parts(date)[1] - 1, parts(date)[2]) / 86_400_000;
/** 0 = Monday … 6 = Sunday, as rec: tokens count them. */
const weekday = (date: string) => (new Date(dayNumber(date) * 86_400_000).getUTCDay() + 6) % 7;
const monthIndex = (date: string) => parts(date)[0] * 12 + parts(date)[1] - 1;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** A real date from 2023 to 2033, often at the end of a month, in January, February or December, or in a leap year. */
function date(r: Rng): string {
  const year = r.bool(0.3) ? r.pick([2024, 2028, 2032]) : r.int(2023, 2033);
  const month = r.bool(0.4) ? r.pick([1, 2, 12]) : r.int(1, 12);
  const last = daysIn(year, month);
  const day = r.bool(0.5) ? Math.min(r.pick([28, 29, 30, 31]), last) : r.int(1, last);
  return `${year}-${pad(month)}-${pad(day)}`;
}

const weekdays = (r: Rng) => [...new Set(r.array(1, 4, () => r.int(0, 6)))].sort((a, b) => a - b);

/** A `rec:` token in one of the documented forms, written as formatRule writes it. */
function token(r: Rng): string {
  const n = r.int(2, 12);
  const days = weekdays(r).map((d) => DAYS[d]).join(",");
  return r.pick([
    () => r.pick(["daily", "weekly", "monthly", "yearly"]),
    () => `${n}${r.pick(["d", "w", "m"])}`,
    () => days,
    () => `${n}w-${days}`,
    () => `${r.pick(["1st", "2nd", "3rd", "last"])}-${DAYS[r.int(0, 6)]}`,
    () => nth(r.int(1, 28)),
    () => `after-${n}${r.pick(["d", "w", "m"])}`,
  ])();
}

test("every rec: token reads to a rule and writes back as itself", () => {
  forAll(
    token,
    (t) => {
      const rule = parseRule(t);
      assert.ok(rule, `${t} reads`);
      assert.equal(formatRule(rule), t);
    },
    { runs: 300 },
  );
});

test("from the due date, a gap of days or weeks moves exactly that far", () => {
  forAll(
    (r) => ({ due: date(r), n: r.int(1, 20), unit: r.pick(["d", "w"]) }),
    ({ due, n, unit }) => {
      const next = nextDue(parseRule(`${n}${unit}`)!, due, due)!;
      assert.equal(dayNumber(next) - dayNumber(due), n * (unit === "w" ? 7 : 1));
    },
    { runs: 300 },
  );
});

test("months and years from the due date keep its day, a whole number of steps on, skipping only months without that day", () => {
  forAll(
    (r) => ({ due: date(r), n: r.int(1, 6), unit: r.pick(["m", "y"]) }),
    ({ due, n, unit }) => {
      const next = nextDue(parseRule(`${n}${unit}`)!, due, due)!;
      const step = n * (unit === "y" ? 12 : 1);
      const months = monthIndex(next) - monthIndex(due);
      assert.equal(parts(next)[2], parts(due)[2], `${due} + ${n}${unit} is ${next}`);
      assert.ok(months > 0 && months % step === 0, `${due} + ${n}${unit} is ${next}`);
      for (let k = step; k < months; k += step) {
        const i = monthIndex(due) + k;
        assert.ok(daysIn(Math.floor(i / 12), (i % 12) + 1) < parts(due)[2], `${due} + ${n}${unit} skipped a month that has day ${parts(due)[2]}`);
      }
    },
    { runs: 300 },
  );
});

test("weekdays: the next date is the first chosen weekday after the due date", () => {
  forAll(
    (r) => ({ due: date(r), days: weekdays(r) }),
    ({ due, days }) => {
      const next = nextDue(parseRule(days.map((d) => DAYS[d]).join(","))!, due, due)!;
      const gap = dayNumber(next) - dayNumber(due);
      assert.ok(gap >= 1 && gap <= 7, `${due} to ${next}`);
      assert.ok(days.includes(weekday(next)));
      for (let k = 1; k < gap; k++) assert.ok(!days.includes((weekday(due) + k) % 7), `${next} skipped a chosen day after ${due}`);
    },
    { runs: 300 },
  );
});

test("after- rules count from the day it's done: days and weeks exactly, months to that day or the month's last", () => {
  forAll(
    (r) => ({ due: date(r), done: date(r), n: r.int(1, 12), unit: r.pick(["d", "w", "m"]) }),
    ({ due, done, n, unit }) => {
      const next = nextDue(parseRule(`after-${n}${unit}`)!, due, done)!;
      if (unit !== "m") return assert.equal(dayNumber(next) - dayNumber(done), n * (unit === "w" ? 7 : 1));
      assert.equal(monthIndex(next) - monthIndex(done), n);
      assert.equal(parts(next)[2], Math.min(parts(done)[2], daysIn(parts(next)[0], parts(next)[1])));
    },
    { runs: 300 },
  );
});

test("ticking a repeating task keeps it open on its line, with only its due date moved on to the rule's next date and last: the day it was done", () => {
  forAll(
    (r) => ({ due: date(r), today: date(r), rec: token(r), summary: r.pick(["Pay rent", "Water the plants", "Call Sam about #garden"]), tail: r.pick(["", " @jane", " #home", " !high"]) }),
    ({ due, today, rec, summary, tail }) => {
      const line = `- [ ] ${summary} due:${due} rec:${rec}${tail}`;
      const ticked = editTaskLine(line, { checked: true }, today);
      assert.equal(ticked, editTask(line.replace(`due:${due}`, `due:${nextDue(parseRule(rec)!, due, today)}`), { last: today }));
      assert.equal(parseTask(ticked)?.done, false);
    },
    { runs: 300 },
  );
});

test("literal cases: month ends skip, and a gap after the 31st lands on the month's last day", () => {
  const next = (t: string, due: string, done = due) => nextDue(parseRule(t)!, due, done);
  assert.deepEqual(
    [next("monthly", "2026-01-31"), next("monthly", "2026-01-30"), next("yearly", "2024-02-29"), next("after-1m", "2026-01-01", "2026-01-31"), next("2w", "2026-12-25"), next("fri", "2026-10-09")],
    ["2026-03-31", "2026-03-30", "2028-02-29", "2026-02-28", "2027-01-08", "2026-10-16"],
  );
});
