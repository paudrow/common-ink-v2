// Notes and events in a real browser, on the Sample calendar: a link to an event is a chip with its
// day, time and title as they are now; a click shows the event in the calendar, whose editor lists the
// notes that link to it and makes a meeting note; and Insert event link puts a link where you are.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();
const LEVERS = { now: "2026-10-05T08:00" };
const NOTE = "# Standup notes\n\nNext: [Team standup](event:sample/work/standup_20261006T090000) then [Dentist](event:sample/personal/dentist).\n";

browserTest(h, "a link to an event is a chip that keeps up with it, and a click opens it in the calendar, with its notes and a meeting note", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await app.writeFile("Standup notes.md", NOTE);
  await app.open("Standup notes");
  await app.keys("G");
  // The chip shows the link's text at once, then the event as it is once it's known.
  const dentist = app.page.locator(".cm-event-chip", { hasText: "2:30 PM" });
  await dentist.waitFor();
  assert.match((await dentist.innerText()).replace(/\s+/g, " "), /^Tue, Oct 6 · 2:30 PM Dentist$/);
  await app.page.locator(".cm-event-chip", { hasText: "Team standup (late start)" }).waitFor();
  // Changed anywhere (an agent, here), the chip follows.
  const res = await app.page.context().request.fetch(`${app.base}/api/event`, { method: "PATCH", data: { address: "event:sample/personal/dentist", title: "Dentist (Dr Lee)" } });
  assert.ok(res.ok());
  await app.page.locator(".cm-event-chip", { hasText: "Dentist (Dr Lee)" }).waitFor();
  assert.match(await app.readFile("Standup notes.md"), /\[Dentist\]\(event:sample\/personal\/dentist\)/, "the note's own text is as it was");
  // A click shows it in the calendar, open, with the notes that link to it.
  await app.page.locator(".cm-event-chip", { hasText: "Dentist (Dr Lee)" }).click();
  const editor = app.page.locator(".cal-editor");
  await editor.waitFor();
  assert.equal(await editor.locator(".cal-title").inputValue(), "Dentist (Dr Lee)");
  assert.deepEqual(await editor.locator(".cal-note-link").allInnerTexts(), ["Meeting prep", "Standup notes"]);
  // The calendar loads around the event and brings it on screen first; then the editor holds still.
  await app.idle();
  await editor.locator("button", { hasText: "New meeting note" }).click();
  const path = "Meetings/2026-10-06 Dentist (Dr Lee).md";
  for (let i = 0; i < 40 && !(await app.readFile(path)); i++) await app.page.waitForTimeout(250);
  await app.page.waitForFunction((p) => (window as unknown as { __commonInk: { where(): { path?: string } | null } }).__commonInk.where()?.path === p, path);
  assert.match(await app.readFile("Meetings/2026-10-06 Dentist (Dr Lee).md"), /^# Dentist \(Dr Lee\)\n\n\[Dentist \(Dr Lee\)\]\(event:sample\/personal\/dentist\) · Tue, Oct 6 · 2:30 PM\n/);
});

browserTest(h, "Insert event link puts a link to the event you pick where the cursor is", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\nDiscuss at \n");
  await app.open("Plan");
  await app.keys("GkA");
  await app.command("Insert event link…");
  const input = app.page.locator("#command-bar input");
  await app.page.waitForFunction(() => (document.activeElement as HTMLInputElement | null)?.value === "event:");
  await input.pressSequentially("planning");
  // The list answers once the events are in: wait for the one typed for to be first.
  await app.page.waitForFunction(() => document.querySelector("#command-bar li")?.textContent?.includes("Quarterly planning"));
  await app.page.keyboard.press("Enter");
  await app.idle();
  for (let i = 0; i < 20 && !(await app.readFile("Plan.md")).includes("event:"); i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Plan.md"), "# Plan\n\nDiscuss at [Quarterly planning](event:sample/work/planning)\n");
});

browserTest(h, "a click on an event's chip opens its editor beside it, even when the events come in before the calendar's first frame", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await app.writeFile("Standup notes.md", "# Standup notes\n\nNext: [Dentist](event:sample/personal/dentist).\n");
  await app.open("Standup notes");
  await app.page.locator(".cm-event-chip", { hasText: "2:30 PM" }).waitFor();
  // As on a slow machine: frames and resize callbacks come late, after the events are in.
  await app.page.evaluate(() => {
    const later = (f: () => void) => setTimeout(f, 1500);
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (f) => (later(() => raf(f)), 0);
    const Observer = window.ResizeObserver;
    window.ResizeObserver = class extends Observer {
      constructor(f: ResizeObserverCallback) {
        super((entries, o) => later(() => f(entries, o)));
      }
    };
  });
  await app.page.locator(".cm-event-chip", { hasText: "Dentist" }).click();
  const editor = app.page.locator(".cal-editor");
  await editor.waitFor();
  await app.idle();
  assert.equal(await app.page.locator(".cal-title-text").innerText(), "Oct 5 – 11, 2026");
  const event = (await app.page.locator('.cal-event[data-address="event:sample/personal/dentist"]').boundingBox())!;
  const box = (await editor.boundingBox())!;
  assert.equal(Math.round(box.x), Math.round(event.x + event.width + 8), "just right of the event");
});
