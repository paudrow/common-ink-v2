// The Calendar view in a real browser, on the Sample calendar with the clock at 8:00 on Monday
// 2026-10-05: a drag makes an event as long as the drag and a click makes a half hour; dragging moves
// an event and its bottom edge changes its end, each drawn where its times say; a repeating event's
// edits ask which ones and change just those; sideways scrolling draws a few weeks at a time however
// far you go; and the keyboard moves through periods and events.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { Locator } from "playwright-core";
import type { App } from "./pages.ts";

const h = harness();
const LEVERS = { now: "2026-10-05T08:00" };
const HOUR = 48;

interface Event {
  title: string;
  start: string;
  end: string;
  location?: string;
}

async function event(app: App, address: string): Promise<Event | null> {
  const res = await app.page.context().request.get(`${app.base}/api/event?address=${encodeURIComponent(address)}`);
  return res.ok() ? ((await res.json()) as { event: Event }).event : null;
}

async function titled(app: App, from: string, to: string): Promise<Array<{ title: string; start: string; address: string; location?: string }>> {
  const res = await app.page.context().request.get(`${app.base}/api/events?from=${from}&to=${to}&zone=UTC`);
  return res.json();
}

/** Where something is on screen. What the calendar draws again after an edit is briefly not on screen, so this waits for it. */
async function box(app: App, what: Locator) {
  for (let i = 0; i < 40; i++) {
    const r = await what.boundingBox();
    if (r) return r;
    await app.page.waitForTimeout(100);
  }
  assert.fail(`${what} isn't on screen`);
}

/** Where a time is in a day's column, on screen. */
async function at(app: App, day: string, minutes: number, dx = 0.5) {
  const r = await box(app, app.page.locator(`.cal-day[data-day="${day}"]`));
  return { x: r.x + r.width * dx, y: r.y + (minutes / 60) * HOUR };
}

async function drag(app: App, from: { x: number; y: number }, to: { x: number; y: number }) {
  await app.page.mouse.move(from.x, from.y);
  await app.page.mouse.down();
  for (let i = 1; i <= 8; i++) await app.page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
  await app.page.mouse.up();
}

async function openCalendar(app: App) {
  await app.command("Open calendar");
  await app.page.locator(".cal-page .cal-event").first().waitFor();
  await app.page.keyboard.press("w");
}

/** Wait for a condition on the server's events, reading them every quarter second. */
async function until(app: App, what: string, test: () => Promise<boolean>) {
  for (let i = 0; i < 40; i++) {
    if (await test()) return;
    await app.page.waitForTimeout(250);
  }
  assert.fail(what);
}

browserTest(h, "a drag makes an event as long as the drag, a click makes half an hour, and each is drawn at its times", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  await drag(app, await at(app, "2026-10-06", 11 * 60 + 5), await at(app, "2026-10-06", 12 * 60 + 20));
  const editor = app.page.locator(".cal-editor");
  await editor.waitFor();
  assert.deepEqual(await editor.locator('input[type="time"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), ["11:00", "12:30"]);
  await app.page.keyboard.type("Design review");
  await app.page.keyboard.press("Enter");
  const made = app.page.locator(".cal-event", { hasText: "Design review" });
  await made.waitFor();
  const drawn = await box(app, made);
  const top = await at(app, "2026-10-06", 11 * 60);
  assert.ok(Math.abs(drawn.y - top.y) < 2, `drawn at 11:00 (${drawn.y} vs ${top.y})`);
  assert.ok(Math.abs(drawn.height - 1.5 * HOUR) < 4, `90 minutes tall (${drawn.height})`);
  const listed = (await titled(app, "2026-10-06T00:00:00Z", "2026-10-07T12:00:00Z")).find((e) => e.title === "Design review");
  assert.ok(listed, "it's an event on the server");
  assert.equal((await event(app, listed.address))?.start, "2026-10-06T11:00:00");
  // A click makes a half hour, and Escape leaves nothing behind.
  await app.page.mouse.click(...Object.values(await at(app, "2026-10-07", 15 * 60 + 10)) as [number, number]);
  await editor.waitFor();
  assert.deepEqual(await editor.locator('input[type="time"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), ["15:00", "15:30"]);
  await app.page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal(await app.page.locator(".cal-ghost").count(), 0);
});

browserTest(h, "dragging an event moves it, and dragging its bottom edge changes when it ends", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  const dentist = await box(app, app.page.locator(".cal-event", { hasText: "Dentist" }));
  const to = await at(app, "2026-10-07", 16 * 60 + 15);
  await drag(app, { x: dentist.x + dentist.width / 2, y: dentist.y + 8 }, { x: to.x, y: to.y + 8 });
  await until(app, "the dentist moved to Wednesday 16:15", async () => (await event(app, "event:sample/personal/dentist"))?.start === "2026-10-07T16:15:00");
  assert.equal((await event(app, "event:sample/personal/dentist"))?.end, "2026-10-07T17:00:00", "it keeps its 45 minutes");
  const planning = app.page.locator(".cal-event", { hasText: "Quarterly planning" });
  await planning.waitFor();
  const p = await box(app, planning);
  const end = await at(app, "2026-10-05", 15 * 60);
  await drag(app, { x: p.x + p.width / 2, y: p.y + p.height - 3 }, { x: p.x + p.width / 2, y: end.y });
  await until(app, "planning ends at 15:00", async () => (await event(app, "event:sample/work/planning"))?.end === "2026-10-05T15:00:00");
  assert.equal((await event(app, "event:sample/work/planning"))?.start, "2026-10-05T13:00:00", "its start stayed");
  const height = async () => (await app.page.locator(".cal-event", { hasText: "Quarterly planning" }).boundingBox())?.height ?? 0;
  await until(app, "planning is drawn two hours tall", async () => Math.abs((await height()) - 2 * HOUR) < 4);
});

browserTest(h, "a repeating event's edits ask which ones: this event, this and following, all", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  const standups = async () => (await titled(app, "2026-10-05T00:00:00Z", "2026-10-17T00:00:00Z")).filter((e) => e.address.includes("standup") || e.title.startsWith("Team") || e.title.startsWith("Sync"));
  // This event: Thursday's moves alone.
  const thu = app.page.locator('.cal-day[data-day="2026-10-08"] .cal-event', { hasText: "Team standup" });
  const t = await box(app, thu);
  const to = await at(app, "2026-10-08", 10 * 60);
  await drag(app, { x: t.x + t.width / 2, y: t.y + 5 }, { x: to.x, y: to.y + 5 });
  await app.page.locator(".cal-scope").waitFor();
  await app.page.keyboard.press("1");
  await until(app, "Thursday's standup is at 10:00", async () => (await event(app, "event:sample/work/standup_20261008T090000"))?.start === "2026-10-08T10:00:00");
  assert.equal((await event(app, "event:sample/work/standup_20261009T090000"))?.start, "2026-10-09T09:00:00", "Friday's didn't move");
  // This and following: from Friday on, a new name.
  await app.page.locator('.cal-day[data-day="2026-10-09"] .cal-event', { hasText: "Team standup" }).click();
  const editor = app.page.locator(".cal-editor");
  await editor.waitFor();
  await editor.locator(".cal-title").fill("Sync");
  await editor.locator("button", { hasText: "Save" }).click();
  await app.page.locator(".cal-scope").waitFor();
  await app.page.locator(".cal-scope button", { hasText: "This and following events" }).click();
  await until(app, "Friday's and later are Sync", async () => {
    const all = await standups();
    return all.filter((e) => e.start >= "2026-10-09" && e.title === "Sync").length >= 5 && all.filter((e) => e.start < "2026-10-09").every((e) => e.title !== "Sync");
  });
  // All events: a place for every Sync, from a later one.
  await app.page.keyboard.press("l");
  await app.page.locator('.cal-day[data-day="2026-10-14"] .cal-event', { hasText: "Sync" }).click();
  await editor.waitFor();
  await editor.locator('input[aria-label="Location"]').fill("Room 9");
  await editor.locator("button", { hasText: "Save" }).click();
  await app.page.locator(".cal-scope button", { hasText: "All events" }).click();
  await until(app, "every Sync is in Room 9", async () => (await standups()).filter((e) => e.title === "Sync").every((e) => e.location === "Room 9"));
  assert.ok((await standups()).filter((e) => e.title === "Team standup").every((e) => e.location !== "Room 9"), "the first part didn't change");
});

browserTest(h, "saving a whole series from the editor keeps its moved and cancelled occurrences, and its floating time", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  await app.page.locator('.cal-day[data-day="2026-10-05"] .cal-event', { hasText: "Team standup" }).click();
  const editor = app.page.locator(".cal-editor");
  await editor.waitFor();
  await editor.locator(".cal-title").fill("Daily");
  await editor.locator("button", { hasText: "Save" }).click();
  await app.page.locator(".cal-scope button", { hasText: "All events" }).click();
  const week = async () => (await titled(app, "2026-10-05T00:00:00Z", "2026-10-10T00:00:00Z")).filter((e) => e.address.includes("standup")).map((e) => `${e.start.slice(0, 16)} ${e.title}`);
  await until(app, "the series is Daily", async () => (await week())[0]?.endsWith("Daily"));
  assert.deepEqual(await week(), ["2026-10-05T09:00 Daily", "2026-10-06T09:30 Team standup (late start)", "2026-10-08T09:00 Daily", "2026-10-09T09:00 Daily"]);
  assert.equal(((await event(app, "event:sample/work/standup")) as { timeZone?: string } | null)?.timeZone, undefined, "still floating");
});

browserTest(h, "scrolling sideways goes on through the weeks, drawing only a few at a time, and the keys move through periods and events", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  const title = app.page.locator(".cal-title-text");
  assert.equal(await title.innerText(), "Oct 5 – 11, 2026");
  for (let i = 0; i < 12; i++) await app.page.keyboard.press("l");
  await app.page.waitForFunction(() => document.querySelector(".cal-title-text")?.textContent === "Dec 28, 2026 – Jan 3, 2027");
  assert.ok((await app.page.locator(".cal-day").count()) <= 49, "seven weeks drawn, not every week passed");
  // A sideways swipe snaps to a week: a short one back to where it was, one past half a week on to the next.
  const scroller = app.page.locator(".cal-scroll");
  await scroller.hover({ position: { x: 400, y: 300 } });
  await app.page.mouse.wheel(120, 0);
  await app.page.waitForTimeout(900);
  assert.equal(await title.innerText(), "Dec 28, 2026 – Jan 3, 2027");
  await app.page.mouse.wheel(600, 0);
  await app.page.waitForFunction(() => document.querySelector(".cal-title-text")?.textContent === "Jan 4 – 10, 2027");
  await app.page.keyboard.press("t");
  await app.page.waitForFunction(() => document.querySelector(".cal-title-text")?.textContent === "Oct 5 – 11, 2026");
  // j goes to the first event on screen, Enter opens it, Escape closes it.
  await app.page.locator(".cal-page").focus();
  await app.page.keyboard.press("j");
  await app.page.locator(".cal-event.is-focused, .cal-bar.is-focused").waitFor();
  await app.page.keyboard.press("Enter");
  await app.page.locator(".cal-editor").waitFor();
  await app.page.keyboard.press("Escape");
  await app.page.locator(".cal-editor").waitFor({ state: "detached" });
  await app.page.keyboard.press("m");
  assert.equal(await title.innerText(), "October 2026");
  await app.page.keyboard.press("y");
  assert.equal(await title.innerText(), "2026");
  await app.page.keyboard.press("a");
  assert.equal(await title.innerText(), "Monday, October 5, 2026");
});

browserTest(h, "scrolled to the first week drawn, the week grid stays on it while it draws the weeks before", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  const title = app.page.locator(".cal-title-text");
  // Once the grid has its width and has been laid out again for it, a frame later.
  await app.page.waitForFunction(() => document.querySelector(".cal-scroll")!.scrollLeft > 0);
  await app.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await app.page.locator(".cal-scroll").hover({ position: { x: 400, y: 300 } });
  await app.page.mouse.wheel(-4000, 0);
  // Three weeks before it are drawn, from Aug 24, and nothing more is asked for.
  await app.page.locator('.cal-day[data-day="2026-08-24"]').waitFor({ state: "attached" });
  await app.idle();
  assert.equal(await title.innerText(), "Sep 14 – 20, 2026");
  await app.page.waitForTimeout(500);
  assert.equal(await title.innerText(), "Sep 14 – 20, 2026");
});

browserTest(h, "an event moved while offline waits in this browser, says so, and goes once it's back online", { scenario: "calendar", open: "Calendar tour", levers: LEVERS, allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/] }, async (app) => {
  await openCalendar(app);
  await app.page.context().setOffline(true);
  const dentist = await box(app, app.page.locator(".cal-event", { hasText: "Dentist" }));
  const to = await at(app, "2026-10-08", 11 * 60);
  await drag(app, { x: dentist.x + dentist.width / 2, y: dentist.y + 8 }, { x: to.x, y: to.y + 8 });
  await app.page.locator("#unsent", { hasText: "1 unsent change" }).waitFor();
  await app.page.context().setOffline(false);
  await until(app, "the dentist moved once back online", async () => (await event(app, "event:sample/personal/dentist"))?.start === "2026-10-08T11:00:00");
  await app.page.locator("#unsent", { hasText: /^Online$/ }).waitFor();
});

browserTest(h, "a closed calendar tab stops loading events when they change", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  await app.command("Close tab");
  await app.idle();
  let loads = 0;
  app.page.on("request", (r) => r.url().includes("/api/events") && loads++);
  const res = await app.page.context().request.fetch(`${app.base}/api/event`, { method: "PATCH", data: { address: "event:sample/personal/dentist", title: "Dentist (moved)" } });
  assert.ok(res.ok());
  await app.page.waitForTimeout(1500);
  await app.idle();
  assert.equal(loads, 0, "no calendar is on screen to load for");
});

browserTest(h, "switching views quickly keeps the last one, with no clash saving it", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  await app.page.locator(".cal-page").focus();
  for (const key of ["m", "y", "a", "3", "m", "y", "a"]) await app.page.keyboard.press(key);
  await app.idle();
  const saved = JSON.parse(await app.readFile(".common-ink/extensions/calendar/state.json")) as { view: string };
  assert.equal(saved.view, "agenda");
});

browserTest(h, "saving the editor changes only what you changed, so what someone else changed meanwhile stays", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  await app.page.locator('.cal-day[data-day="2026-10-06"] .cal-event', { hasText: "Dentist" }).click();
  const editor = app.page.locator(".cal-editor");
  await editor.waitFor();
  // An agent renames it while the editor is open.
  const renamed = await app.page.context().request.fetch(`${app.base}/api/event`, { method: "PATCH", headers: { "X-Common-Ink-Agent": "Planner" }, data: { address: "event:sample/personal/dentist", title: "Dentist (Dr Lee)" } });
  assert.ok(renamed.ok(), await renamed.text());
  await editor.locator('input[aria-label="Location"]').fill("14 High Street");
  await editor.locator("button", { hasText: "Save" }).click();
  await until(app, "the place is saved", async () => (await event(app, "event:sample/personal/dentist"))?.location === "14 High Street");
  assert.equal((await event(app, "event:sample/personal/dentist"))?.title, "Dentist (Dr Lee)", "the agent's title stays");
});

browserTest(h, "a view you've left can't move the calendar, even with a scroll it had queued", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  const title = app.page.locator(".cal-title-text");
  /** The view's strip now, and a scroll fired on it later, as one the browser queued fires after the view is gone. */
  const strip = () => app.page.evaluateHandle(() => document.querySelector(".cal-strip, .cal-scroll")!);
  const scrollGone = (gone: Awaited<ReturnType<typeof strip>>) => gone.evaluate((s) => s.dispatchEvent(new Event("scroll")));
  // Each step waits for the view's own saving to finish: the stale scroll is fired by hand, not raced.
  await app.page.keyboard.press("m");
  await app.idle();
  assert.equal(await title.innerText(), "October 2026");
  const month = await strip();
  await app.page.keyboard.press("y");
  await app.idle();
  await scrollGone(month);
  assert.equal(await title.innerText(), "2026");
  const year = await strip();
  await app.page.keyboard.press("a");
  await app.idle();
  await scrollGone(year);
  await scrollGone(month);
  assert.equal(await title.innerText(), "Monday, October 5, 2026");
});

browserTest(h, "an event dragged late enough to run past midnight ends on the next day", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await openCalendar(app);
  // Scrolled to the bottom of the day, once the grid is laid out: the dentist at 14:30 and 23:30 are both on screen.
  await app.page.waitForFunction(() => document.querySelector(".cal-scroll")!.scrollLeft > 0);
  await app.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await app.page.locator(".cal-scroll").evaluate((s) => (s.scrollTop = s.scrollHeight));
  const dentist = await box(app, app.page.locator(".cal-event", { hasText: "Dentist" }));
  const to = await at(app, "2026-10-06", 23 * 60 + 30);
  await drag(app, { x: dentist.x + dentist.width / 2, y: dentist.y + 8 }, { x: to.x, y: to.y + 8 });
  await until(app, "the dentist moved to 23:30", async () => (await event(app, "event:sample/personal/dentist"))?.start === "2026-10-06T23:30:00");
  assert.equal((await event(app, "event:sample/personal/dentist"))?.end, "2026-10-07T00:15:00", "its 45 minutes, into Wednesday");
});
