import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, describeTaskEdit, dueFilter, editTask, editTaskLine, parseTask, patchProblem, skipPatch, tasksIn, todaySection, withTasksAdded } from "../web/src/extensions/tasks/tasks.ts";
import { recLabel } from "../web/src/extensions/tasks/recurrence.ts";

const LINE = "- [ ] Send invoice to Acme due:2026-10-01 rec:monthly #work/clients @jane !high";

test("a task line's tokens become its metadata, and its text without the trailing ones is its summary", () => {
  assert.deepEqual(parseTask(LINE), {
    done: false,
    text: "Send invoice to Acme due:2026-10-01 rec:monthly #work/clients @jane !high",
    summary: "Send invoice to Acme",
    meta: { due: "2026-10-01", start: null, done: null, rec: "monthly", until: null, times: null, priority: "high", assignees: ["jane"], tags: ["work/clients"] },
  });
  assert.deepEqual(parseTask("  * [x] Renew passport done:2026-09-20 scheduled:2026-09-01T09:30")?.meta, {
    due: null, start: "2026-09-01T09:30", done: "2026-09-20", rec: null, until: null, times: null, priority: null, assignees: [], tags: [],
  });
  assert.equal(parseTask("Not a task due:2026-10-01"), null);
});

test("words that only look like tokens stay text", () => {
  const t = parseTask("- [ ] Email me@example.com about `due:2026-01-01` and !highlight, due:tomorrow, due:2026-13-40 #27")!;
  assert.deepEqual(t.meta, { due: null, start: null, done: null, rec: null, until: null, times: null, priority: null, assignees: [], tags: [] });
  assert.equal(t.summary, t.text);
});

test("a token mid-sentence counts but stays in the summary; only the trailing run is taken out", () => {
  const t = parseTask("- [ ] Ask @sam about the #launch plan !low")!;
  assert.deepEqual([t.summary, t.meta.assignees, t.meta.tags, t.meta.priority], ["Ask @sam about the #launch plan", ["sam"], ["launch"], "low"]);
});

test("editing one field rewrites only that token, and leaves every other byte alone", () => {
  assert.equal(editTask(LINE, { due: "2026-10-02" }), LINE.replace("due:2026-10-01", "due:2026-10-02"));
  assert.equal(editTask(LINE, { priority: null }), LINE.replace(" !high", ""));
  assert.equal(editTask(LINE, { priority: "low", assignees: ["jane", "sam"] }), LINE.replace("!high", "!low").replace("rec:monthly ", "rec:monthly @sam "));
  assert.equal(editTask(LINE, { tags: [] }), LINE.replace(" #work/clients", ""));
  assert.equal(editTask("- [ ] Call mom  ", { due: "2026-01-02" }), "- [ ] Call mom due:2026-01-02  ");
  assert.equal(editTask("- [ ] Plan `due:x` day", { start: "2026-01-02" }), "- [ ] Plan `due:x` day start:2026-01-02");
  assert.equal(editTask("- [ ] Water plants scheduled:2026-01-01", { start: "2026-02-01" }), "- [ ] Water plants scheduled:2026-02-01");
  assert.equal(editTask(LINE, { checked: true, done: "2026-10-01" }), LINE.replace("[ ]", "[x]") + " done:2026-10-01");
});

test("setting every field to what it already is changes nothing", () => {
  for (const line of [LINE, "- [x] Renew passport done:2026-09-20", "\t+ [ ] Ask @Sam about the #launch plan !LOW due:2026-01-01T08:00", "- [ ] plain"]) {
    const { done, meta } = parseTask(line)!;
    assert.equal(editTask(line, { checked: done, ...meta }), line, line);
  }
});

test("a person ends at a word boundary and never inside a [[link]], and an impossible date isn't a date", () => {
  const t = parseTask("- [ ] prep [[Call with @jane]] and ask @sam's team, then @ana. due:2026-04-31 start:2026-02-28")!;
  assert.deepEqual([t.meta.assignees, t.meta.due, t.meta.start], [["ana"], null, "2026-02-28"]);
  assert.equal(editTask("- [ ] prep [[Call with @jane]] now", { assignees: [] }), "- [ ] prep [[Call with @jane]] now");
});

test("values come in as people write them (#tag, @person, repeats) and go out as tokens that read back", () => {
  const line = editTask("- [ ] a", { tags: ["#work", " home ", "Work"], assignees: ["@jane"] });
  assert.equal(line, "- [ ] a @jane #work #home");
  assert.deepEqual(parseTask(line)!.meta.tags, ["work", "home"]);
});

test("cutting a token takes the whitespace before it, and a tag's trailing slash goes with it", () => {
  assert.equal(editTask("- [ ] a\tdue:2026-01-01", { due: null }), "- [ ] a");
  assert.equal(editTask("- [ ] a  due:2026-01-01  b", { due: null }), "- [ ] a  b");
  assert.equal(editTask("- [ ] due:2026-01-01 a", { due: null }), "- [ ] a");
  assert.equal(editTask("- [ ] a #work/", { tags: [] }), "- [ ] a");
  assert.equal(parseTask("- [ ] a #work/")!.summary, "a");
});

test("setting a field to the value it has leaves a second token for it alone", () => {
  const line = "- [ ] a due:2026-01-01 b due:2026-02-02";
  assert.equal(editTask(line, { due: "2026-01-01" }), line);
  assert.equal(editTask(line, { due: "2026-03-03" }), "- [ ] a due:2026-03-03 b due:2026-02-02");
  assert.equal(editTask(line, { due: null }), "- [ ] a b");
});

test("a new token goes in at its place in the order priority, due, start, repeat, person, tags, done", () => {
  assert.equal(editTask("- [ ] Call due:2026-10-01 @jane #work", { priority: "high" }), "- [ ] Call !high due:2026-10-01 @jane #work");
  assert.equal(editTask("- [ ] Call !high @jane", { due: "2026-10-01", rec: "weekly" }), "- [ ] Call !high due:2026-10-01 rec:weekly @jane");
  assert.equal(editTask("- [ ] Call #work", { assignees: ["jane"] }), "- [ ] Call @jane #work");
  // Only the trailing tokens place a new one: a mid-sentence @sam isn't an anchor.
  assert.equal(editTask("- [ ] Ask @sam about it #launch", { due: "2026-10-01" }), "- [ ] Ask @sam about it due:2026-10-01 #launch");
});

test("each chip editor's change round-trips through the one writer, leaving the rest of the line alone", () => {
  const line = "- [ ] Send invoice #work/clients rec:monthly @jane due:2026-10-01 !high ok";
  const read = (l: string) => parseTask(l)!.meta;
  // Priority menu: High, Normal (no token), Low.
  assert.equal(editTask(line, { priority: "low" }), line.replace("!high", "!low"));
  assert.equal(editTask(line, { priority: null }), line.replace(" !high", ""));
  // Due: a quick pick rewrites the date in place; Clear takes it out.
  const nextWeek = editTask(line, { due: addDays("2026-09-28", 7) });
  assert.deepEqual([nextWeek, read(nextWeek).due], [line.replace("due:2026-10-01", "due:2026-10-05"), "2026-10-05"]);
  assert.equal(editTask(line, { due: null }), line.replace(" due:2026-10-01", ""));
  // Repeat: every N day/week/month/year.
  const everyTwo = editTask(line, { rec: "2w" });
  assert.deepEqual([everyTwo, read(everyTwo).rec], [line.replace("rec:monthly", "rec:2w"), "2w"]);
  assert.equal(editTask(line, { rec: "yearly" }), line.replace("rec:monthly", "rec:yearly"));
  assert.equal(editTask(line, { rec: null }), line.replace(" rec:monthly", ""));
  // Person: picking someone else swaps them in place; Remove takes them out.
  assert.equal(editTask(line, { assignees: ["sam"] }), line.replace("@jane", "@sam"));
  assert.equal(editTask("- [ ] a @jane @ana b", { assignees: ["sam", "ana"] }), "- [ ] a @sam @ana b");
  assert.equal(editTask(line, { assignees: [] }), line.replace(" @jane", ""));
});

test("a repeat's chip label says what it does, and a value it can't read shows as written", () => {
  assert.deepEqual(["weekly", "2w", "1st-tue,3rd-tue", "weekdays"].map(recLabel), ["Weekly", "Every 2 weeks", "1st & 3rd Tue", "weekdays"]);
  assert.equal(parseTask("- [ ] a rec:weekdays")!.meta.rec, null); // not a rule: plain text
  assert.equal(parseTask("- [ ] a rec:RRULE:FREQ=MONTHLY;BYDAY=1TU,3TU")!.meta.rec, "RRULE:FREQ=MONTHLY;BYDAY=1TU,3TU");
});

test("ticking a repeating task moves it on to its next date on the same line, open; a plain one ticks with done:", () => {
  const bill = "- [ ] Pay rent due:2026-10-06 start:2026-10-01 rec:6th @jane #home";
  assert.equal(editTaskLine(bill, { checked: true }, "2026-10-04"), "- [ ] Pay rent due:2026-11-06 start:2026-11-01 rec:6th @jane #home");
  // after- repeats count from the day it's done.
  assert.equal(editTaskLine("  - [ ] Dog medicine due:2026-10-01 rec:after-1m", { checked: true }, "2026-10-08"), "  - [ ] Dog medicine due:2026-11-08 rec:after-1m");
  // No due date yet: the next one counts from the day it's done.
  assert.equal(editTaskLine("- [ ] Water plants rec:weekly", { checked: true }, "2026-10-08"), "- [ ] Water plants due:2026-10-15 rec:weekly");
  // A plain task ticks, stamped with the day; unticking takes the stamp off.
  assert.equal(editTaskLine("- [ ] Once", { checked: true }, "2026-10-08"), "- [x] Once done:2026-10-08");
  assert.equal(editTaskLine("- [x] Once done:2026-10-08", { checked: false }, "2026-10-09"), "- [ ] Once");
  // A repeating task ticked by hand in the markdown unticks like any other.
  assert.equal(editTaskLine("- [x] Pay due:2026-10-06 rec:6th done:2026-10-06", { checked: false }, "2026-10-07"), "- [ ] Pay due:2026-10-06 rec:6th");
});

test("history says a tick, a reopen, or a repeating task moved on to its next date; not an edit by hand", () => {
  const rent = "- [ ] Pay rent due:2026-10-06 rec:6th";
  assert.equal(describeTaskEdit(rent, editTaskLine(rent, { checked: true }, "2026-10-04")), "Completed 'Pay rent' (due Oct 6)");
  assert.equal(describeTaskEdit("- [ ] Once", "- [x] Once done:2026-10-08"), "Completed 'Once'");
  assert.equal(describeTaskEdit("- [x] Once done:2026-10-08", "- [ ] Once"), "Reopened 'Once'");
  assert.equal(describeTaskEdit(rent, "- [ ] Pay rent due:2026-10-20 rec:6th"), null); // moved by hand
  assert.equal(describeTaskEdit(rent, "- [ ] Pay the rent due:2026-11-06 rec:6th"), null); // its words changed too
  assert.equal(describeTaskEdit("- [ ] Pill due:2026-10-01 rec:after-1m", "- [ ] Pill due:2026-11-08 rec:after-1m"), "Completed 'Pill' (due Oct 1)");
});

test("a note's tasks come with their line and the heading they're under; fenced code has none", () => {
  const tasks = tasksIn("Plan.md", "# Plan\n\n- [ ] One due:2026-10-01\n## Later\n```\n- [ ] Not a task\n```\n- [x] Two", "Plan");
  assert.deepEqual(
    tasks.map((t) => [t.line, t.heading, t.summary, t.done, t.raw]),
    [
      [3, "Plan", "One", false, "- [ ] One due:2026-10-01"],
      [8, "Later", "Two", true, "- [x] Two"],
    ],
  );
});

test("skipping moves a repeating task to its next date without completing it", () => {
  assert.deepEqual(skipPatch(parseTask("- [ ] Standup due:2026-10-06 rec:1st-tue,3rd-tue")!.meta, "2026-10-01"), { due: "2026-10-20" });
  assert.deepEqual(skipPatch(parseTask("- [ ] Pills due:2026-10-06 start:2026-10-05 rec:after-1w")!.meta, "2026-10-01"), { due: "2026-10-13", start: "2026-10-12" });
  assert.equal(skipPatch(parseTask("- [ ] Once due:2026-10-06")!.meta, "2026-10-01"), null);
});

test("editing a task's text rewrites only the words before its tokens, never the tokens", () => {
  const line = "  - [ ] Send invoice to Acme due:2026-10-01 rec:monthly #work/clients @jane !high";
  assert.equal(editTask(line, { summary: "Send the Q4 invoice" }), "  - [ ] Send the Q4 invoice due:2026-10-01 rec:monthly #work/clients @jane !high");
  // Mid-sentence tokens are part of the text; a task with no text gets some; spaces at either end go.
  assert.equal(editTask("- [x] Ask @sam about it due:2026-10-01 done:2026-10-02", { summary: "Ask @ana about it" }), "- [x] Ask @ana about it due:2026-10-01 done:2026-10-02");
  assert.equal(editTask("- [ ] due:2026-10-01", { summary: "  Call mom " }), "- [ ] Call mom due:2026-10-01");
  assert.equal(editTask("- [ ] Plain", { summary: "Plainer" }), "- [ ] Plainer");
  assert.equal(editTask("- [ ] Plain  ", { summary: "Plain" }), "- [ ] Plain  ");
  // Text and a token in one patch: both land, the token in its place.
  assert.equal(editTask("- [ ] a @jane", { summary: "b", priority: "high" }), "- [ ] b !high @jane");
  assert.equal(patchProblem({ summary: "two\nlines" }), "A task's text is one line");
});

test("a task added to a note goes at the end of its Tasks section, or at the end of the note", () => {
  const add = (content: string, heading = false) => withTasksAdded(content, ["- [ ] New"], heading).content;
  assert.equal(add("# Day\n\n## Tasks\n\n- [ ] Old\n\n## Log\n\n- 09:00 hi\n"), "# Day\n\n## Tasks\n\n- [ ] Old\n- [ ] New\n\n## Log\n\n- 09:00 hi\n");
  assert.equal(add("# Day\n\n## tasks\n\n## Log\n"), "# Day\n\n## tasks\n\n- [ ] New\n\n## Log\n");
  assert.equal(add("# Day\n\n## Tasks\n- [ ] Old\n  - [ ] Sub"), "# Day\n\n## Tasks\n- [ ] Old\n  - [ ] Sub\n- [ ] New\n");
  // No Tasks section: a daily note gets one; any other note gets the task at its end.
  assert.equal(add("# Day\n\n## Log\n\n- 09:00 hi\n", true), "# Day\n\n## Log\n\n- 09:00 hi\n\n## Tasks\n\n- [ ] New\n");
  assert.equal(add("# Launch\n\nNotes.\n"), "# Launch\n\nNotes.\n\n- [ ] New\n");
  assert.equal(add("# Launch\n\n- [ ] Old\n"), "# Launch\n\n- [ ] Old\n- [ ] New\n");
  // A heading inside fenced code isn't the section.
  assert.equal(add("# N\n\n```\n## Tasks\n```\n"), "# N\n\n```\n## Tasks\n```\n\n- [ ] New\n");
});

test("a task is in one Today section at most: overdue, then due today, then starting today", () => {
  const at = (line: string) => todaySection(parseTask(line)!.meta, "2026-09-28");
  assert.deepEqual(
    ["- [ ] a due:2026-09-27", "- [ ] a due:2026-09-28T09:00", "- [ ] a start:2026-09-28", "- [ ] a start:2026-09-28 due:2026-09-20", "- [ ] a start:2026-09-28 due:2026-10-01", "- [ ] a due:2026-09-29", "- [ ] a"].map(at),
    ["overdue", "due", "starting", "overdue", "starting", null, null],
  );
});

test("until: and times: are tokens next to rec:, and anything else that looks like them stays text", () => {
  const t = parseTask("- [ ] Pay the loan due:2026-10-06 rec:6th times:3 until:2027-06-30 #bills")!;
  assert.deepEqual([t.meta.times, t.meta.until, t.summary], [3, "2027-06-30", "Pay the loan"]);
  assert.deepEqual([parseTask("- [ ] a times:0 until:someday")!.meta.times, parseTask("- [ ] a times:0 until:someday")!.meta.until], [null, null]);
  // They go in right after the repeat, and come out like any token.
  assert.equal(editTask("- [ ] Pay due:2026-10-06 rec:6th #bills", { times: 3 }), "- [ ] Pay due:2026-10-06 rec:6th times:3 #bills");
  assert.equal(editTask("- [ ] Pay due:2026-10-06 rec:6th #bills", { until: "2027-06-30", times: 3 }), "- [ ] Pay due:2026-10-06 rec:6th until:2027-06-30 times:3 #bills");
  assert.equal(editTask("- [ ] Pay rec:6th times:3 until:2027-06-30", { times: null, until: null }), "- [ ] Pay rec:6th");
  assert.equal(patchProblem({ times: 0 }), '"times" must be a whole number of repeats left, 1 or more');
  assert.equal(patchProblem({ until: "June" }), '"until" must be a date like 2026-10-01, not "June"');
});

test("times: counts down on every tick, and the last one is ticked done", () => {
  let line = "- [ ] Pay the loan due:2026-10-06 rec:6th times:3";
  const tick = (day: string) => (line = editTaskLine(line, { checked: true }, day));
  assert.equal(tick("2026-10-06"), "- [ ] Pay the loan due:2026-11-06 rec:6th times:2");
  assert.equal(tick("2026-11-06"), "- [ ] Pay the loan due:2026-12-06 rec:6th times:1");
  assert.equal(tick("2026-12-06"), "- [x] Pay the loan due:2026-12-06 rec:6th times:1 done:2026-12-06"); // the last: it stays, ticked
});

test("until: keeps an occurrence on that day and none after it; with times: too, whichever ends first wins", () => {
  // The next occurrence, or null when ticking it ends the repeat (it's ticked done instead).
  const next = (line: string, day = "2026-10-06") => {
    const after = editTaskLine(line, { checked: true }, day);
    return parseTask(after)!.done ? null : after;
  };
  assert.equal(next("- [ ] Class due:2026-10-06 rec:6th until:2026-11-06"), "- [ ] Class due:2026-11-06 rec:6th until:2026-11-06");
  assert.equal(next("- [ ] Class due:2026-11-06 rec:6th until:2026-11-06", "2026-11-06"), null);
  assert.equal(next("- [ ] Class due:2026-10-06 rec:6th until:2026-11-05"), null);
  assert.equal(next("- [ ] Class due:2026-10-06 rec:6th times:5 until:2026-11-06"), "- [ ] Class due:2026-11-06 rec:6th times:4 until:2026-11-06");
  assert.equal(next("- [ ] Class due:2026-10-06 rec:6th times:1 until:2027-01-01"), null);
  // Month ends: monthly from Jan 31 skips February, and Mar 31 is still in.
  assert.equal(next("- [ ] Rent due:2026-01-31 rec:monthly until:2026-03-31", "2026-01-31"), "- [ ] Rent due:2026-03-31 rec:monthly until:2026-03-31");
  // after- repeats end too.
  assert.equal(next("- [ ] Pill due:2026-10-06 rec:after-1m until:2026-11-01", "2026-10-06"), null);
});

test("an RRULE's COUNT and UNTIL end it the same way; COUNT counts down in the rule", () => {
  const next = (line: string, day: string) => {
    const after = editTaskLine(line, { checked: true }, day);
    return parseTask(after)!.done ? null : after;
  };
  assert.equal(next("- [ ] Sync due:2026-10-01 rec:RRULE:FREQ=WEEKLY;COUNT=2", "2026-10-01"), "- [ ] Sync due:2026-10-08 rec:RRULE:FREQ=WEEKLY;COUNT=1");
  assert.equal(next("- [ ] Sync due:2026-10-08 rec:RRULE:FREQ=WEEKLY;COUNT=1", "2026-10-08"), null);
  assert.equal(next("- [ ] Sync due:2026-10-08 rec:RRULE:FREQ=WEEKLY;UNTIL=20261015", "2026-10-08"), "- [ ] Sync due:2026-10-15 rec:RRULE:FREQ=WEEKLY;UNTIL=20261015");
  assert.equal(next("- [ ] Sync due:2026-10-15 rec:RRULE:FREQ=WEEKLY;UNTIL=20261015T235959Z", "2026-10-15"), null);
});

test("skipping a counted repeat uses one up; the last one, or one past until:, can't be skipped", () => {
  const skip = (line: string) => skipPatch(parseTask(line)!.meta, "2026-10-01");
  assert.deepEqual(skip("- [ ] a due:2026-10-06 rec:6th times:3"), { due: "2026-11-06", times: 2 });
  assert.equal(skip("- [ ] a due:2026-10-06 rec:6th times:1"), null);
  assert.equal(skip("- [ ] a due:2026-10-06 rec:6th until:2026-11-01"), null);
  assert.deepEqual(skip("- [ ] a due:2026-10-06 rec:6th until:2026-11-06"), { due: "2026-11-06" });
  assert.deepEqual(skip("- [ ] a due:2026-10-06 rec:RRULE:FREQ=MONTHLY;BYMONTHDAY=6;COUNT=3"), { due: "2026-11-06", rec: "RRULE:FREQ=MONTHLY;BYMONTHDAY=6;COUNT=2" });
});

test("a due filter compares dates, with today, tomorrow and yesterday relative to the day given", () => {
  const due = (expr: string, d: string | null) => dueFilter(expr, "2026-10-01")!(d);
  assert.deepEqual(["2026-09-30", "2026-10-01", "2026-10-01T18:00", "2026-10-02", null].map((d) => due("<=today", d)), [true, true, true, false, false]);
  assert.deepEqual(["2026-10-01", "2026-10-02"].map((d) => due("tomorrow", d)), [false, true]);
  assert.deepEqual(["2026-09-29", "2026-09-30"].map((d) => due(">yesterday", d)), [false, false]);
  assert.equal(due(">=2026-09-01", "2026-09-01"), true);
  assert.deepEqual(["soon", "<=2026-02-31x", "2026-13-01"].map((e) => dueFilter(e, "2026-10-01")), [null, null, null]);
});
