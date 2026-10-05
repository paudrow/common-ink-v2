import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDue, parseEvery, parseTodo, todoParts, toggleLine, type Unit } from "../../web/src/extensions/todos/model.ts";
import { forAll, type Rng } from "./gen.ts";

const UNITS: Unit[] = ["day", "weekday", "week", "month", "year"];
const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];
const dayNumber = (date: string) => Date.UTC(parts(date)[0], parts(date)[1] - 1, parts(date)[2]) / 86_400_000;
const weekday = (date: string) => new Date(dayNumber(date) * 86_400_000).getUTCDay();

/** A real date from 2023 to 2033, often at the end of a month, in January, February or December, or in a leap year. */
function date(r: Rng): string {
  const year = r.bool(0.3) ? r.pick([2024, 2028, 2032]) : r.int(2023, 2033);
  const month = r.bool(0.4) ? r.pick([1, 2, 12]) : r.int(1, 12);
  const last = daysIn(year, month);
  const day = r.bool(0.5) ? Math.min(r.pick([28, 29, 30, 31]), last) : r.int(1, last);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** An `every:` token as written, with what it means. */
function every(r: Rng) {
  const count = r.pick(["", "1", "2", "3", "12"]);
  const unit = r.pick(UNITS);
  return { token: `every:${count}${unit}${r.bool() ? "s" : ""}`, every: { count: Number(count || 1), unit } };
}

test("next due dates, at month ends, year ends and leap days", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-01-29", "month", "2026-02-28"],
    ["2026-01-30", "month", "2026-02-28"],
    ["2028-01-31", "month", "2028-02-29"],
    ["2026-01-31", "2months", "2026-03-31"],
    ["2026-03-31", "month", "2026-04-30"],
    ["2026-12-31", "month", "2027-01-31"],
    ["2026-02-28", "12months", "2027-02-28"],
    ["2026-12-31", "day", "2027-01-01"],
    ["2028-02-28", "day", "2028-02-29"],
    ["2026-12-25", "2weeks", "2027-01-08"],
    ["2028-02-29", "year", "2029-02-28"],
    ["2028-02-29", "4years", "2032-02-29"],
    ["2026-10-03", "weekday", "2026-10-05"],
    ["2026-12-31", "2weekdays", "2027-01-04"],
  ];
  for (const [due, rule, next] of cases) assert.equal(nextDue(due, parseEvery(`every:${rule}`)!), next, `${due} every:${rule}`);
  assert.equal(parseEvery("every:fortnight"), null);
  assert.deepEqual(parseEvery("every:0days"), { count: 1, unit: "day" });
});

test("a monthly todo on the 31st, checked off twice, keeps the day the shorter month gave it", () => {
  const once = toggleLine("- [ ] Rent due:2026-01-31 every:month", "2026-01-31")!;
  assert.equal(once, "- [ ] Rent due:2026-02-28 every:month");
  assert.equal(toggleLine(once, "2026-02-28"), "- [ ] Rent due:2026-03-28 every:month");
});

test("each way of writing every: reads as its count and unit", () => {
  forAll(every, ({ token, every }) => assert.deepEqual(parseEvery(token), every), { runs: 200 });
});

test("the next due date is a real date after the due date: days and weeks exactly that many days on, weekdays that many weekdays on", () => {
  forAll(
    (r) => ({ due: date(r), ...every(r) }),
    ({ due, every }) => {
      const next = nextDue(due, every);
      assert.match(next, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(new Date(`${next}T00:00:00Z`).toISOString().slice(0, 10), next, "a real date");
      assert.ok(next > due, `${next} is after ${due}`);
      const days = dayNumber(next) - dayNumber(due);
      if (every.unit === "day") assert.equal(days, every.count);
      if (every.unit === "week") assert.equal(days, 7 * every.count);
      if (every.unit === "weekday") {
        assert.ok(weekday(next) >= 1 && weekday(next) <= 5, `${next} is a weekday`);
        const passed = Array.from({ length: days }, (_, k) => (weekday(due) + k + 1) % 7).filter((d) => d >= 1 && d <= 5).length;
        assert.equal(passed, every.count, "weekdays from the due date to the next");
      }
    },
    { runs: 500 },
  );
});

test("monthly and yearly todos move to the month that many months on, never skipping one, on the same day or that month's last", () => {
  forAll(
    (r) => ({ due: date(r), every: { count: r.pick([1, 1, 2, 3, 6, 12, 13]), unit: r.pick(["month", "year"] as const) } }),
    ({ due, every }) => {
      const [y1, m1, d1] = parts(due);
      const [y2, m2, d2] = parts(nextDue(due, every));
      assert.equal(y2 * 12 + m2 - (y1 * 12 + m1), every.unit === "month" ? every.count : 12 * every.count, "months on");
      assert.equal(d2, Math.min(d1, daysIn(y2, m2)), "the same day, or the month's last");
    },
    { runs: 500 },
  );
});

/** A todo line: any indent and list marker, a title, and a due date and recurrence among its words. */
function todoLine(r: Rng) {
  const marker = r.pick(["-", "*", "+", "1.", "12)"]);
  const words = r.array(1, 3, () => r.pick(["Pay", "rent", "water", "plants", "x:y", "due", "every"]));
  const due = r.bool(0.7) ? date(r) : null;
  const rule = every(r);
  const tokens = [...(due ? [`due:${due}`] : []), rule.token];
  for (const token of tokens) words.splice(r.int(1, words.length), 0, token);
  const box = `${marker} [${r.pick([" ", "x"])}]`;
  return { line: `${" ".repeat(r.pick([0, 2, 4]))}${box} ${words.join(" ")}`, box, body: words.join(" "), due, ...rule };
}

test("checking off a recurring todo keeps it open at its next due date, the rest of the line as it was; checking it on again only opens it", () => {
  forAll(
    (r) => ({ ...todoLine(r), today: date(r) }),
    ({ line, due, every, today }) => {
      const toggled = toggleLine(line, today)!;
      if (parseTodo(line)!.done) {
        assert.equal(toggled, line.replace("[x]", "[ ]"));
        return;
      }
      const next = nextDue(due ?? today, every);
      assert.equal(toggled, due ? line.replace(`due:${due}`, `due:${next}`) : `${line} due:${next}`);
      assert.deepEqual(parseTodo(toggled), { ...parseTodo(line), due: next });
    },
    { runs: 300 },
  );
});

test("a todo line's parts are where its marker and box, due date and recurrence are written", () => {
  forAll(
    todoLine,
    ({ line, box, body, due, token, every }) => {
      const found = todoParts(line)!;
      assert.equal(line.slice(found.box.from, found.box.to), box);
      assert.equal(line.slice(found.body.from, found.body.to), body);
      assert.equal(found.due && line.slice(found.due.from, found.due.to), due && `due:${due}`);
      assert.equal(line.slice(found.every!.from, found.every!.to), token);
      assert.deepEqual(found.every!.every, every);
    },
    { runs: 300 },
  );
});
