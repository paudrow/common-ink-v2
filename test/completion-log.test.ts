// Where a ticked task's completion is recorded: the daily note's ## Done (the default), a ticked copy
// left in its note (v1's way), or only history; and plain tasks, logged only when asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backTo, completeTask, doneLines, editTaskLine, logLine, parseLogLine, parseTask, withDone, withoutDone } from "../web/src/extensions/tasks/tasks.ts";

const PLANTS = "- [ ] Water the plants due:2026-10-05 rec:3d @sam #home";
const opts = (mode: "daily" | "inline" | "none", logPlain = false) => ({ mode, logPlain, note: "Chores" });

test('"daily": a repeating task moves on in place, and its completion is a line for the daily note, without its dates', () => {
  assert.deepEqual(completeTask(PLANTS, undefined, { checked: true }, "2026-10-05", opts("daily")), {
    lines: ["- [ ] Water the plants due:2026-10-08 rec:3d last:2026-10-05 @sam #home"],
    replaced: 1,
    log: "- [x] Water the plants @sam #home done:2026-10-05 ([[Chores]])",
  });
  assert.equal(completeTask(PLANTS, undefined, { checked: true }, "2026-10-05", opts("daily"))!.lines[0], editTaskLine(PLANTS, { checked: true }, "2026-10-05"), "the same advance as without a log");
  // A tag or person in the words stays in the words, once.
  assert.equal(logLine(parseTask("- [ ] Ask @jane about the #garden due:2026-10-05 rec:weekly")!, "2026-10-05", "Projects/Garden"), "- [x] Ask @jane about the #garden done:2026-10-05 ([[Projects/Garden]])");
});

test('"inline" is v1\'s: ticked where it is with done:, the next one right below; unticking straight after takes it back', () => {
  const ticked = completeTask(PLANTS, "- [ ] Other", { checked: true }, "2026-10-05", opts("inline"));
  assert.deepEqual(ticked, { lines: ["- [x] Water the plants due:2026-10-05 rec:3d @sam #home done:2026-10-05", "- [ ] Water the plants due:2026-10-08 rec:3d @sam #home"], replaced: 1, log: null });
  const back = completeTask(ticked.lines[0], ticked.lines[1], { checked: false }, "2026-10-05", opts("inline"));
  assert.deepEqual(back, { lines: [PLANTS], replaced: 2, log: null });
});

test('"none": it moves on in place, recorded only in history', () => {
  assert.deepEqual(completeTask(PLANTS, undefined, { checked: true }, "2026-10-05", opts("none")), { lines: ["- [ ] Water the plants due:2026-10-08 rec:3d last:2026-10-05 @sam #home"], replaced: 1, log: null });
});

test("a plain task is ticked with done: in its note, and logged too only with logPlainTasks; so is a repeat's last time", () => {
  assert.deepEqual(completeTask("- [ ] Call mum", undefined, { checked: true }, "2026-10-05", opts("daily")), { lines: ["- [x] Call mum done:2026-10-05"], replaced: 1, log: null });
  assert.equal(completeTask("- [ ] Call mum", undefined, { checked: true }, "2026-10-05", opts("daily", true)).log, "- [x] Call mum done:2026-10-05 ([[Chores]])");
  assert.equal(completeTask("- [ ] Call mum", undefined, { checked: true }, "2026-10-05", opts("none", true)).log, null, "none means none");
  const last = completeTask("- [ ] Physio due:2026-10-05 rec:daily times:1", undefined, { checked: true }, "2026-10-05", opts("daily"));
  assert.deepEqual([last.lines, last.log], [["- [x] Physio due:2026-10-05 rec:daily times:1 done:2026-10-05"], null]);
});

test("## Done: made under the daily note's title if it's missing, appended to in time order, kept where it is if it's there", () => {
  const first = withDone("# 2026-10-05\n", "- [x] Water the plants done:2026-10-05 ([[Chores]])");
  assert.equal(first, "# 2026-10-05\n\n## Done\n\n- [x] Water the plants done:2026-10-05 ([[Chores]])\n");
  const second = withDone(first, "- [x] Pay rent done:2026-10-05 ([[Bills]])");
  assert.equal(second, "# 2026-10-05\n\n## Done\n\n- [x] Water the plants done:2026-10-05 ([[Chores]])\n- [x] Pay rent done:2026-10-05 ([[Bills]])\n");
  // An existing section, with a section after it: the line goes at its end, before the next heading.
  const busy = "# 2026-10-05\n\n## Done\n\n- [x] Early done:2026-10-05 ([[A]])\n\n## Notes\n\nA good day.\n";
  assert.equal(withDone(busy, "- [x] Late done:2026-10-05 ([[B]])"), "# 2026-10-05\n\n## Done\n\n- [x] Early done:2026-10-05 ([[A]])\n- [x] Late done:2026-10-05 ([[B]])\n\n## Notes\n\nA good day.\n");
  assert.deepEqual(doneLines(second).map((d) => [d.line, parseLogLine(d.text)!.task.summary, parseLogLine(d.text)!.note]), [[5, "Water the plants", "Chores"], [6, "Pay rent", "Bills"]]);
  assert.equal(withoutDone(second, "- [x] Water the plants done:2026-10-05 ([[Chores]])"), "# 2026-10-05\n\n## Done\n\n- [x] Pay rent done:2026-10-05 ([[Bills]])\n");
  assert.equal(withoutDone(second, "- [x] Not there done:2026-10-05 ([[X]])"), null);
  // A task line outside ## Done isn't a completion.
  assert.deepEqual(doneLines("## Tasks\n\n- [x] Filed done:2026-10-05 ([[A]])\n"), []);
});

test("taking a completion back from the log puts a repeating task back to the day it was done", () => {
  assert.equal(backTo("- [ ] Water the plants due:2026-10-08 start:2026-10-07 rec:3d last:2026-10-05", "2026-10-05"), "- [ ] Water the plants due:2026-10-05 start:2026-10-04 rec:3d");
  assert.equal(backTo("- [ ] Water the plants due:2026-10-08 rec:3d last:2026-10-05", "2026-10-05", "2026-10-02"), "- [ ] Water the plants due:2026-10-05 rec:3d last:2026-10-02", "last: goes back to the completion before");
  assert.equal(backTo("- [ ] Physio due:2026-10-06 rec:daily times:4", "2026-10-05"), "- [ ] Physio due:2026-10-05 rec:daily times:5");
  assert.equal(backTo("- [ ] Sync due:2026-10-08 rec:RRULE:FREQ=WEEKLY;COUNT=1", "2026-10-01"), "- [ ] Sync due:2026-10-01 rec:RRULE:FREQ=WEEKLY;COUNT=2");
  assert.equal(backTo("- [ ] Plain", "2026-10-05"), null);
});

test("last: is a token: read, written at its place, and rewritten in place; a tick sets it as it moves the task on", async () => {
  const { editTask } = await import("../web/src/extensions/tasks/tasks.ts");
  assert.equal(parseTask("- [ ] Water due:2026-10-08 rec:3d last:2026-10-05 #home")!.meta.last, "2026-10-05");
  assert.equal(parseTask("- [ ] Water last:someday")!.meta.last, null, "only a date");
  assert.equal(editTask("- [ ] Water due:2026-10-08 rec:3d @sam #home", { last: "2026-10-05" }), "- [ ] Water due:2026-10-08 rec:3d last:2026-10-05 @sam #home", "after the repeat, before people and tags");
  assert.equal(editTask("- [ ] Water last:2026-10-01 due:2026-10-08 rec:3d", { last: "2026-10-05" }), "- [ ] Water last:2026-10-05 due:2026-10-08 rec:3d", "rewritten where it is");
  const once = completeTask("- [ ] Water due:2026-10-05 rec:3d", undefined, { checked: true }, "2026-10-05", opts("none")).lines[0];
  const twice = completeTask(once, undefined, { checked: true }, "2026-10-08", opts("none")).lines[0];
  assert.deepEqual([once, twice], ["- [ ] Water due:2026-10-08 rec:3d last:2026-10-05", "- [ ] Water due:2026-10-11 rec:3d last:2026-10-08"]);
  assert.equal(completeTask("- [ ] Call mum", undefined, { checked: true }, "2026-10-05", opts("none")).lines[0], "- [x] Call mum done:2026-10-05", "a plain task keeps done:");
});

test("a task's logged completions are the ## Done lines that link to its note and say its words, or, edited since, its note's only repeating task's", async () => {
  const { TaskStore } = await import("../web/src/extensions/tasks/store.ts");
  const files: Record<string, string> = {
    "Chores.md": "# Chores\n\n- [ ] Water the plants due:2026-10-11 rec:3d last:2026-10-08\n- [ ] Call mum\n",
    "Bills.md": "# Bills\n\n- [ ] Pay the rent bill due:2026-11-01 rec:monthly\n",
    "Journal/2026-10-05.md": "# 2026-10-05\n\n## Done\n\n- [x] Water the plants done:2026-10-05 ([[Chores]])\n- [x] Pay rent done:2026-10-05 ([[Bills]])\n",
    "Journal/2026-10-08.md": "# 2026-10-08\n\n## Done\n\n- [x] Water the plants done:2026-10-08 ([[Chores]])\n- [x] Call mum done:2026-10-08 ([[Chores]])\n",
  };
  const ctx = {
    files: {
      fetchList: async () => Object.keys(files).map((path, i) => ({ path, revision: i + 1 })),
      read: async (path: string) => ({ path, text: files[path] ?? "", revision: 1 }),
    },
    util: { label: (p: string) => p.replace(/\.md$/, ""), notePathFor: (name: string) => `${name}.md` },
  };
  const store = new TaskStore(ctx as never);
  await store.all();
  assert.deepEqual(store.completionsOf({ path: "Chores.md", summary: "Water the plants" }).map((c) => [c.day, c.path, c.line]), [
    ["2026-10-08", "Journal/2026-10-08.md", 5],
    ["2026-10-05", "Journal/2026-10-05.md", 5],
  ]);
  // Bills' only repeating task was renamed: its note's log lines are still its own.
  assert.deepEqual(store.completionsOf({ path: "Bills.md", summary: "Pay the rent bill" }).map((c) => c.day), ["2026-10-05"]);
  assert.deepEqual(store.completionsOf({ path: "Chores.md", summary: "Nothing like it" }), [], "not when its note has other tasks to match");
});
