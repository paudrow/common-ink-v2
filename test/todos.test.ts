import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDue, parseTodo, todosIn, toggleLine, when } from "../web/src/plugins/todos/model.ts";

test("a checkbox line is a todo, with its due date and recurrence read from the text", () => {
  assert.deepEqual(parseTodo("- [ ] Pay rent due:2026-11-01 every:month", 3), {
    line: 3,
    done: false,
    title: "Pay rent",
    due: "2026-11-01",
    every: { count: 1, unit: "month" },
  });
  assert.deepEqual(parseTodo("  * [x] Water plants every:3days"), { line: 0, done: true, title: "Water plants", due: null, every: { count: 3, unit: "day" } });
  assert.equal(parseTodo("- [ ] Bad date due:2026-02-30")?.due, null);
  assert.equal(parseTodo("- a list item"), null);
  assert.equal(parseTodo("Not a todo [ ]"), null);
  assert.equal(parseTodo("1. [ ] Numbered works too")?.title, "Numbered works too");
});

test("recurrences step from the due date; months keep the day or end the month", () => {
  assert.equal(nextDue("2026-10-04", { count: 1, unit: "day" }), "2026-10-05");
  assert.equal(nextDue("2026-10-04", { count: 2, unit: "week" }), "2026-10-18");
  assert.equal(nextDue("2026-01-31", { count: 1, unit: "month" }), "2026-02-28");
  assert.equal(nextDue("2028-02-29", { count: 1, unit: "year" }), "2029-02-28");
  // Friday 2026-10-02 → Monday 2026-10-05
  assert.equal(nextDue("2026-10-02", { count: 1, unit: "weekday" }), "2026-10-05");
});

test("checking off a todo marks it done, and a recurring one adds the next above it", () => {
  assert.deepEqual(toggleLine("- [ ] Call mum", "2026-10-04"), ["- [x] Call mum"]);
  assert.deepEqual(toggleLine("- [x] Call mum", "2026-10-04"), ["- [ ] Call mum"]);
  assert.deepEqual(toggleLine("- [ ] Pay rent due:2026-10-01 every:month", "2026-10-04"), [
    "- [ ] Pay rent due:2026-11-01 every:month",
    "- [x] Pay rent due:2026-10-01 every:month",
  ]);
  assert.deepEqual(toggleLine("- [ ] Stretch every:day", "2026-10-04"), ["- [ ] Stretch every:day due:2026-10-05", "- [x] Stretch every:day"]);
  assert.equal(toggleLine("plain line", "2026-10-04"), null);
});

test("todos are found in a note and sorted into overdue, today, upcoming and someday", () => {
  const todos = todosIn("# Plan\n\n- [ ] A due:2026-10-01\n- [ ] B due:2026-10-04\ntext\n- [ ] C due:2026-12-01\n- [ ] D\n- [x] E");
  assert.deepEqual(
    todos.map((t) => [t.line, t.title, when(t, "2026-10-04")]),
    [
      [2, "A", "overdue"],
      [3, "B", "today"],
      [5, "C", "upcoming"],
      [6, "D", "someday"],
      [7, "E", "someday"],
    ],
  );
});
