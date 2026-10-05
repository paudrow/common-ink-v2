// The completion log in a real browser, on the tasks scenario: ticking a repeating task moves it on in
// its note and logs it under ## Done in that day's daily note; one undo takes back both; the Tasks
// view's Done today can put it back; across midnight the log goes to the new day's note; and the
// "inline" setting is v1's ticked copy instead.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

/** Wait until a file's text passes `test`, reading it every quarter second. */
async function until(app: App, path: string, test: (text: string) => boolean) {
  for (let tries = 0; tries < 60; tries++) {
    if (test(await app.readFile(path))) return;
    await app.page.waitForTimeout(250);
  }
  assert.fail(`${path} never changed as expected:\n${await app.readFile(path)}`);
}

const box = (app: App, task: string) => app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: task }).locator(".cm-checkbox");

browserTest(h, "a repeating task ticked in its note moves on and is logged in today's note; one undo takes back both", { scenario: "tasks", open: "Chores", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  await box(app, "Water the plants").click();
  await until(app, "Journal/2026-10-05.md", (t) => t === "# 2026-10-05\n\n## Done\n\n- [x] Water the plants done:2026-10-05 ([[Chores]])\n");
  await until(app, "Chores.md", (t) => t.includes("- [ ] Water the plants due:2026-10-08 rec:3d"));
  // Undo in the note: the tick and its log line, together.
  await app.keys("<Esc>u");
  await until(app, "Chores.md", (t) => t.includes("- [ ] Water the plants due:2026-10-05 rec:3d"));
  await until(app, "Journal/2026-10-05.md", (t) => !t.includes("Water the plants"));
  // A plain task is ticked with done: in its note, and not logged.
  await box(app, "Book a dentist").click();
  await until(app, "Chores.md", (t) => t.includes("- [x] Book a dentist appointment start:2026-10-08 done:2026-10-05"));
  await app.idle();
  assert.doesNotMatch(await app.readFile("Journal/2026-10-05.md"), /dentist/);
});

browserTest(h, "Done today in the Tasks view lists what's logged and what's ticked; unticking a logged one can put it back", { scenario: "tasks", open: "Chores", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  await box(app, "Water the plants").click();
  await until(app, "Journal/2026-10-05.md", (t) => t.includes("- [x] Water the plants done:2026-10-05 ([[Chores]])"));
  await box(app, "Book a dentist").click();
  await until(app, "Chores.md", (t) => t.includes("Book a dentist appointment start:2026-10-08 done:2026-10-05"));
  await app.command("Show tasks");
  const done = app.page.locator(".td-section.is-done");
  await done.locator(".qt-row", { hasText: "Water the plants" }).waitFor();
  await done.locator(".qt-row", { hasText: "Book a dentist appointment" }).waitFor(); // a plain task ticked today, from its own note
  assert.equal(await done.locator(".qt-row", { hasText: "Fix the bike light" }).count(), 0, "not one ticked another day");
  await done.locator(".qt-row", { hasText: "Water the plants" }).locator(".cm-checkbox").click();
  await app.page.locator(".chip-pop .fp-item", { hasText: "Put it back in Chores" }).click();
  await until(app, "Chores.md", (t) => t.includes("- [ ] Water the plants due:2026-10-05 rec:3d"));
  await until(app, "Journal/2026-10-05.md", (t) => !t.includes("Water the plants"));
});

browserTest(h, "across midnight, by the page's clock, a completion goes to the new day's note", { scenario: "tasks", open: "Chores", levers: { now: "2026-10-05T23:59:30" } }, async (app) => {
  await box(app, "Water the plants").click();
  await until(app, "Journal/2026-10-05.md", (t) => t.includes("- [x] Water the plants done:2026-10-05 ([[Chores]])"));
  await app.call("clock.advance", 60_000);
  await box(app, "Physio exercises").click();
  await until(app, "Journal/2026-10-06.md", (t) => t === "# 2026-10-06\n\n## Done\n\n- [x] Physio exercises done:2026-10-06 ([[Chores]])\n");
  await until(app, "Chores.md", (t) => t.includes("- [ ] Physio exercises due:2026-10-06 rec:daily times:4"));
});

browserTest(h, 'with tasks.completionLog "inline", a tick leaves v1\'s ticked copy and the next one below it, and logs nothing', { scenario: "tasks", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "tasks.completionLog": "inline" }));
  await app.reload();
  await app.open("Chores");
  await box(app, "Water the plants").click();
  await until(app, "Chores.md", (t) => t.includes("- [x] Water the plants due:2026-10-05 rec:3d done:2026-10-05\n- [ ] Water the plants due:2026-10-08 rec:3d"));
  await app.idle();
  assert.equal(await app.readFile("Journal/2026-10-05.md"), "");
});

browserTest(h, "Open today's note makes it with just its date as its title, in the daily.folder setting's folder", { scenario: "tasks", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  await app.command("Open today's note");
  await app.page.waitForFunction(() => document.title.startsWith("Journal/2026-10-05"));
  await until(app, "Journal/2026-10-05.md", (t) => t === "# 2026-10-05\n");
});

/** The notice a tick shows, if any. */
const toastText = (app: App) => app.page.locator(".task-toast .task-toast-text").last().textContent();

browserTest(h, "a tick is obvious: ticked and struck through, then moved on with its new date standing out, a notice with Undo and Open log, and its chip counting", { scenario: "tasks", open: "Chores", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  const line = app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "Water the plants" });
  await box(app, "Water the plants").click();
  // For a moment: ticked, struck through, not moved on yet.
  assert.match((await line.getAttribute("class"))!, /cm-task-completing/);
  assert.equal(await line.locator(".cm-checkbox").getAttribute("aria-checked"), "true");
  // Then moved on, its new due date standing out, and the notice.
  await app.page.locator(".tab-editor:not([hidden]) .cm-line.cm-task-fresh", { hasText: "Water the plants" }).waitFor();
  const due = await line.locator('.tk[data-field="due"]').textContent();
  assert.match(due!, /Oct 8/);
  assert.equal(await toastText(app), "Done · next due Thu, Oct 8 · Logged in today's note");
  await until(app, "Chores.md", (t) => t.includes("- [ ] Water the plants due:2026-10-08 rec:3d last:2026-10-05"));
  // Its chip: done today, once in the log.
  await line.locator('.tk[data-field="last"]', { hasText: "✓ Today · 1×" }).waitFor();
  // Clicked: its completions, each where it's logged.
  await line.locator('.tk[data-field="last"]').click();
  assert.deepEqual(await app.page.locator(".chip-pop .fp-item").allTextContents(), ["Today · Journal/2026-10-05"]);
  await app.page.keyboard.press("Escape");
  // Open log: today's note, at its ## Done line.
  await app.page.locator(".task-toast .task-toast-action", { hasText: "Open log" }).click();
  await app.page.waitForFunction(() => document.title.startsWith("Journal/2026-10-05"));
  assert.match(JSON.stringify((await app.state()).cursor), /Water the plants done:2026-10-05/);
  // Undo, from another tick's notice: the line as it was, last: included, and its log line out.
  await app.open("Chores");
  await box(app, "Physio exercises").click();
  await app.page.locator(".task-toast .task-toast-text", { hasText: "next due" }).last().waitFor();
  await until(app, "Chores.md", (t) => t.includes("- [ ] Physio exercises due:2026-10-06 rec:daily times:4 last:2026-10-05"));
  await app.page.locator(".task-toast").last().locator(".task-toast-action", { hasText: "Undo" }).click();
  await until(app, "Chores.md", (t) => t.includes("- [ ] Physio exercises due:2026-10-05 rec:daily times:5\n"));
  await until(app, "Journal/2026-10-05.md", (t) => !t.includes("Physio"));
});

browserTest(h, "with reduced motion, a tick moves the task on at once: no strike-through pause, just the highlight and the notice", { scenario: "tasks", open: "Chores", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  await app.page.emulateMedia({ reducedMotion: "reduce" });
  await box(app, "Water the plants").click();
  const line = app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: "Water the plants" });
  // At once: no frame where it's struck through and still due today.
  assert.doesNotMatch((await line.getAttribute("class"))!, /cm-task-completing/);
  await app.page.locator(".tab-editor:not([hidden]) .cm-line.cm-task-fresh", { hasText: "Water the plants" }).waitFor({ timeout: 500 });
  assert.equal(await toastText(app), "Done · next due Thu, Oct 8 · Logged in today's note");
});

browserTest(h, 'with tasks.completionLog "none", the notice doesn\'t say it was logged', { scenario: "tasks", levers: { now: "2026-10-05T09:00" } }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "tasks.completionLog": "none" }));
  await app.reload();
  await app.open("Chores");
  await box(app, "Water the plants").click();
  await app.page.locator(".task-toast").waitFor();
  assert.equal(await toastText(app), "Done · next due Thu, Oct 8");
  assert.equal(await app.page.locator(".task-toast .task-toast-action", { hasText: "Open log" }).count(), 0);
});
