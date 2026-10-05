import assert from "node:assert/strict";
import { test } from "node:test";
import { diffPatch } from "node-diff3";
import { describeTodoEdit, dueLabel, everyLabel, nextDue, parseTodo, todoParts, todosIn, toggleLine, when } from "../web/src/extensions/todos/model.ts";

const { describeChange } = await import("../web/src/extensions/todos/index.ts");

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

test("checking off a todo marks it done; a recurring one stays open and moves to its next due date", () => {
  assert.equal(toggleLine("- [ ] Call mum", "2026-10-04"), "- [x] Call mum");
  assert.equal(toggleLine("- [x] Call mum", "2026-10-04"), "- [ ] Call mum");
  assert.equal(toggleLine("- [ ] Pay rent due:2026-10-01 every:month", "2026-10-04"), "- [ ] Pay rent due:2026-11-01 every:month");
  assert.equal(toggleLine("- [ ] Stretch every:day", "2026-10-04"), "- [ ] Stretch every:day due:2026-10-05");
  assert.equal(toggleLine("plain line", "2026-10-04"), null);
});

test("chips say when a todo is due from today, and how it repeats", () => {
  const today = "2026-10-04"; // a Sunday
  assert.deepEqual(dueLabel("2026-10-04", today), { text: "Today", when: "today" });
  assert.deepEqual(dueLabel("2026-10-05", today), { text: "Tomorrow", when: "upcoming" });
  assert.deepEqual(dueLabel("2026-10-09", today), { text: "Fri", when: "upcoming" });
  assert.deepEqual(dueLabel("2026-10-12", today), { text: "Oct 12", when: "upcoming" });
  assert.deepEqual(dueLabel("2027-01-03", today), { text: "Jan 3, 2027", when: "upcoming" });
  assert.deepEqual(dueLabel("2026-10-02", today), { text: "Overdue 2d", when: "overdue" });
  assert.equal(everyLabel({ count: 1, unit: "week" }), "↻ weekly");
  assert.equal(everyLabel({ count: 1, unit: "weekday" }), "↻ weekdays");
  assert.equal(everyLabel({ count: 3, unit: "day" }), "↻ every 3 days");
});

test("a todo line's parts are found by offset: marker and box, due and every", () => {
  const text = "  - [ ] Pay rent due:2026-11-01 every:month";
  const parts = todoParts(text)!;
  assert.equal(text.slice(parts.box.from, parts.box.to), "- [ ]");
  assert.equal(text.slice(parts.due!.from, parts.due!.to), "due:2026-11-01");
  assert.equal(text.slice(parts.every!.from, parts.every!.to), "every:month");
  assert.equal(text.slice(parts.body.from, parts.body.to), "Pay rent due:2026-11-01 every:month");
  assert.equal(todoParts("- [ ] Bad date due:2026-02-30")!.due, null);
  assert.equal(todoParts("text"), null);
});

test("history says what a change did to todos", () => {
  assert.equal(describeTodoEdit("- [ ] Water the plants due:2026-10-06 every:3days", "- [ ] Water the plants due:2026-10-09 every:3days"), "Completed 'Water the plants' (due Oct 6)");
  assert.equal(describeTodoEdit("- [ ] Water the plants due:2026-10-06 every:3days", "- [ ] Water the plants due:2026-10-20 every:3days"), null, "moved by hand");
  assert.equal(describeTodoEdit("- [ ] Call mum", "- [x] Call mum"), "Completed 'Call mum'");
  assert.equal(describeTodoEdit("- [x] Call mum", "- [ ] Call mum"), "Reopened 'Call mum'");
  assert.equal(describeTodoEdit("- [ ] Call mum", "- [ ] Call mum and dad"), null);
  const change = { diff: diffPatch(["# Chores", "- [ ] Call mum", "- [ ] Pay rent due:2026-10-01 every:month"], ["# Chores", "- [x] Call mum", "- [ ] Pay rent due:2026-11-01 every:month"]) };
  assert.equal(describeChange(change), "Completed 'Call mum'; Completed 'Pay rent' (due Oct 1)");
  assert.equal(describeChange({ diff: diffPatch(["a"], ["b"]) }), null);
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
