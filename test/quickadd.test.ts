import { test } from "node:test";
import assert from "node:assert/strict";
import { targetOf } from "../web/src/extensions/tasks/bar.ts";
import { parseQuickAdd, retypeTask, typedTask } from "../web/src/extensions/tasks/quickadd.ts";

const TODAY = "2026-09-28"; // a Monday
const line = (input: string, ignore: string[] = []) => parseQuickAdd(input, TODAY, ignore).line;

test("dates in words become due: tokens, and the words that said them go", () => {
  const table: Array<[string, string]> = [
    ["Call mom tomorrow", "- [ ] Call mom due:2026-09-29"],
    ["Call mom today", "- [ ] Call mom due:2026-09-28"],
    ["Review the PR next fri", "- [ ] Review the PR due:2026-10-02"],
    ["Review the PR by friday", "- [ ] Review the PR due:2026-10-02"],
    ["Plan on monday", "- [ ] Plan due:2026-10-05"], // today is a Monday: the coming one
    ["Dentist oct 3", "- [ ] Dentist due:2026-10-03"],
    ["Dentist on October 3rd", "- [ ] Dentist due:2026-10-03"],
    ["Dentist 3 oct", "- [ ] Dentist due:2026-10-03"],
    ["Taxes apr 15", "- [ ] Taxes due:2027-04-15"], // passed this year: next year's
    ["Taxes apr 15 2028", "- [ ] Taxes due:2028-04-15"],
    ["Renew passport in 2 weeks", "- [ ] Renew passport due:2026-10-12"],
    ["Renew passport in a month", "- [ ] Renew passport due:2026-10-28"],
    ["Ship it in 3 days", "- [ ] Ship it due:2026-10-01"],
    ["Retro next week", "- [ ] Retro due:2026-10-05"],
    ["Launch 2026-11-02", "- [ ] Launch due:2026-11-02"],
    ["Draft the post starting thursday", "- [ ] Draft the post start:2026-10-01"],
    ["Draft the post start oct 5 due oct 9", "- [ ] Draft the post due:2026-10-09 start:2026-10-05"],
  ];
  for (const [input, want] of table) assert.equal(line(input), want, input);
});

test("repeats in words map onto the rec: grammar, due on the first time it comes round", () => {
  const table: Array<[string, string]> = [
    ["Pay rent every month on the 1st #home", "- [ ] Pay rent due:2026-10-01 rec:1st #home"],
    ["Pay rent on the 1st of every month", "- [ ] Pay rent due:2026-10-01 rec:1st"],
    ["Pay rent monthly on the 15th", "- [ ] Pay rent due:2026-10-15 rec:15th"],
    ["Standup every other week", "- [ ] Standup due:2026-09-28 rec:2w"],
    ["Stretch every day", "- [ ] Stretch due:2026-09-28 rec:daily"],
    ["Stretch daily", "- [ ] Stretch due:2026-09-28 rec:daily"],
    ["Backups every 3 weeks", "- [ ] Backups due:2026-09-28 rec:3w"],
    ["Water plants every 3 days after done", "- [ ] Water plants due:2026-09-28 rec:after-3d"],
    ["Dog medicine a month after done", "- [ ] Dog medicine due:2026-09-28 rec:after-1m"],
    ["Payroll last friday of the month", "- [ ] Payroll due:2026-10-30 rec:last-fri"],
    ["Payroll every last friday", "- [ ] Payroll due:2026-10-30 rec:last-fri"],
    ["Book club every 2nd tuesday", "- [ ] Book club due:2026-10-13 rec:2nd-tue"],
    ["Book club first tuesday of the month", "- [ ] Book club due:2026-10-06 rec:1st-tue"],
    ["Gym every mon and thu", "- [ ] Gym due:2026-09-28 rec:mon,thu"],
    ["Gym every monday, wednesday & friday", "- [ ] Gym due:2026-09-28 rec:mon,wed,fri"],
    ["Standup every weekday", "- [ ] Standup due:2026-09-28 rec:mon,tue,wed,thu,fri"],
    ["Invoice on the last day of the month", "- [ ] Invoice due:2026-09-30 rec:last-day"],
    ["Birthday every year on mar 1", "- [ ] Birthday due:2027-03-01 rec:mar-1"],
    ["Birthday every march 1", "- [ ] Birthday due:2027-03-01 rec:mar-1"],
    ["Review every other week starting oct 5", "- [ ] Review due:2026-10-05 start:2026-10-05 rec:2w"],
    ["Rent every month on the 1st due oct 1", "- [ ] Rent due:2026-10-01 rec:1st"],
  ];
  for (const [input, want] of table) assert.equal(line(input), want, input);
});

test("a repeat's end in words: until a date, for a stretch, or a number of times", () => {
  const table: Array<[string, string]> = [
    ["Standup every week until dec 1", "- [ ] Standup due:2026-09-28 rec:weekly until:2026-12-01"],
    ["Rent every month for 6 months", "- [ ] Rent due:2026-09-28 rec:monthly times:6"],
    ["Stretch daily 10 times", "- [ ] Stretch due:2026-09-28 rec:daily times:10"],
    ["Class every mon and thu for 3 weeks", "- [ ] Class due:2026-09-28 rec:mon,thu until:2026-10-18"],
    ["Pay the loan on the 1st of every month 12 times #bills", "- [ ] Pay the loan due:2026-10-01 rec:1st times:12 #bills"],
  ];
  for (const [input, want] of table) assert.equal(line(input), want, input);
  // Without a repeat, "until" and "N times" are just words.
  assert.equal(line("Wait until dec 1"), "- [ ] Wait until due:2026-12-01");
  assert.equal(line("Knock 3 times"), "- [ ] Knock 3 times");
});

test("the same reading everywhere a task is typed: a card's text, and a task's words retyped in place", () => {
  // A card (or anything that isn't the quick-add bar): no → [[Note]] target, just the task's text.
  assert.equal(typedTask("Print badges next fri → [[Launch]] #event", TODAY), "Print badges → [[Launch]] due:2026-10-02 #event");
  assert.equal(typedTask("Pay rent every month on the 1st", TODAY, ["every month on the 1st"]), "Pay rent every month on the 1st");
  // Retyping a task's words: phrases become tokens next to the ones it has, which stay put.
  const line = "- [ ] Call mom !high due:2026-10-05 @jane";
  assert.deepEqual(retypeTask(line, "Call mom about the trip tomorrow", TODAY), { summary: "Call mom about the trip", due: "2026-09-29" });
  assert.deepEqual(retypeTask(line, "Call mom every week", TODAY), { summary: "Call mom", rec: "weekly" });
  assert.deepEqual(retypeTask(line, "Call mom next week", TODAY, ["next week"]), { summary: "Call mom next week" });
  assert.deepEqual(retypeTask("- [ ] Plain", "Plainer", TODAY), { summary: "Plainer" });
  // Tokens typed at the end are the task's: a priority replaces its own, tags and people join the ones it has.
  assert.deepEqual(retypeTask(line, "Call mom !low #trip @sam", TODAY), { summary: "Call mom", priority: "low", tags: ["trip"], assignees: ["jane", "sam"] });
  assert.deepEqual(retypeTask(line, "Call mom @jane due:2026-10-09", TODAY), { summary: "Call mom", due: "2026-10-09" });
  // A tag mid-sentence stays in the words.
  assert.deepEqual(retypeTask(line, "Call #family mom", TODAY), { summary: "Call #family mom" });
});

test("tokens typed as tokens pass through where they are, and a phrase doesn't override one", () => {
  assert.equal(line("Ship it due:2026-10-05 !high @jane #work"), "- [ ] Ship it due:2026-10-05 !high @jane #work");
  assert.equal(line("Ask @sam about #launch tomorrow"), "- [ ] Ask @sam about due:2026-09-29 #launch"); // a new token joins the run of tokens at the end, in its place
  assert.equal(line("Ship it tomorrow due:2026-10-05"), "- [ ] Ship it tomorrow due:2026-10-05");
  assert.equal(line("Pay rent every month rec:weekly"), "- [ ] Pay rent every month rec:weekly");
});

test("words that only look like dates stay words, and a phrase clicked away stays text", () => {
  assert.equal(line("Sit in the sun"), "- [ ] Sit in the sun");
  assert.equal(line("Wed the sat nav"), "- [ ] Wed the sat nav");
  assert.equal(line("Read May's notes"), "- [ ] Read May's notes");
  assert.equal(line("Email from jane"), "- [ ] Email from jane");
  assert.equal(line("Look at page#monday"), "- [ ] Look at page#monday");
  assert.equal(line("Meet at the deck next week", ["next week"]), "- [ ] Meet at the deck next week");
  assert.equal(line("Meet at the deck Next Week tomorrow", ["next week"]), "- [ ] Meet at the deck Next Week due:2026-09-29");
});

test("the spans say what each phrase became, where it is in what was typed", () => {
  const q = parseQuickAdd("Pay rent every month on the 1st → [[Bills]] #home", TODAY);
  assert.deepEqual(
    q.spans.map((s) => [s.kind, q.input.slice(s.from, s.to), s.token]),
    [["rec", "every month on the 1st", "rec:1st"], ["target", "→ [[Bills]]", "[[Bills]]"]],
  );
  assert.equal(q.target, "Bills");
  assert.equal(q.line, "- [ ] Pay rent due:2026-10-01 rec:1st #home");
  assert.equal(parseQuickAdd("Plan -> [[Projects/Launch]] tomorrow", TODAY).target, "Projects/Launch");
  assert.deepEqual(parseQuickAdd("   ", TODAY).words, "");
});

test("the bar's target: the inbox (or today's daily note), the note it was opened from on Tab, and → [[Note]] beats both", () => {
  const daily = { label: "Journal/2026-09-28", path: "Journal/2026-09-28.md", daily: true };
  assert.deepEqual(targetOf(null, false, "Projects/Launch.md", daily), { label: "Journal/2026-09-28", named: null, path: "Journal/2026-09-28.md", daily: true });
  assert.deepEqual(targetOf(null, true, "Projects/Launch.md", daily), { label: "Launch", named: null, path: "Projects/Launch.md" });
  assert.deepEqual(targetOf("Other", true, "Projects/Launch.md", daily), { label: "Other", named: "Other", path: null });
  assert.deepEqual(targetOf(null, true, undefined, { label: "Inbox", path: "Inbox.md" }), { label: "Inbox", named: null, path: "Inbox.md" });
});
