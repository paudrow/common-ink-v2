// A link embed keeps its frame, so a playing video keeps playing: the same iframe, never reloaded,
// while the cursor comes onto its line and goes (the raw link shows above the frame, which stays),
// while the note is edited elsewhere, and while it's drawn again.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const NOTE = "# Video\n\nAbove\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\nBelow\n";
const FRAME = '.cm-url-embed[data-url-embed="youtube"] iframe';

/** Mark the video's iframe and the page in it, to tell later whether either was made again. */
async function mark(app: App) {
  await app.page.locator(FRAME).waitFor();
  await app.page.evaluate((sel) => ((window as unknown as { kept: Element }).kept = document.querySelector(sel)!), FRAME);
  const frame = await (await app.page.$(FRAME))!.contentFrame();
  await frame!.waitForLoadState();
  await frame!.evaluate(() => ((window as unknown as { mark: number }).mark = 1));
}

/** Whether it's the same iframe with the same page in it, and whether it shows. */
async function kept(app: App) {
  const element = await app.page.evaluate((sel) => document.querySelector(sel) === (window as unknown as { kept: Element }).kept, FRAME);
  const frame = await (await app.page.$(FRAME))?.contentFrame();
  const page = (await frame?.evaluate(() => (window as unknown as { mark?: number }).mark === 1)) ?? false;
  const shown = await app.page.evaluate((sel) => {
    const box = document.querySelector(sel)!.getBoundingClientRect();
    return box.height > 50 && getComputedStyle(document.querySelector(sel)!.closest(".cm-embed")!).visibility === "visible";
  }, FRAME);
  return { element, page, shown };
}

const rawLink = (app: App) => app.page.evaluate(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("youtube.com/watch")));

browserTest(h, "a video's frame stays the same iframe, shown, while the cursor comes onto its line and goes, and while the note is edited elsewhere", {}, async (app) => {
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  await mark(app);
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>jj");
  await app.page.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("youtube.com/watch")));
  assert.deepEqual(await kept(app), { element: true, page: true, shown: true }, "on its line: the raw link shows, and the video under it plays on");
  // The frame is under the link's line, not over it.
  const [line, frame] = await app.page.evaluate((sel) => [[...document.querySelectorAll(".cm-line")].find((l) => l.textContent!.includes("youtube.com/watch"))!.getBoundingClientRect().bottom, document.querySelector(sel)!.getBoundingClientRect().top], FRAME);
  assert.ok(frame >= line - 1, `the frame (top ${frame}) is below the link's line (bottom ${line})`);
  await app.keys("jj");
  await app.page.waitForFunction(() => ![...document.querySelectorAll(".cm-line")].some((l) => l.textContent!.includes("youtube.com/watch")));
  assert.deepEqual(await kept(app), { element: true, page: true, shown: true }, "off its line again");
  // Edits elsewhere in the note: above it, and below it.
  await app.keys("ATyping below<Esc>ggjAAnd above<Esc>");
  await app.idle();
  assert.equal(await rawLink(app), false);
  assert.deepEqual(await kept(app), { element: true, page: true, shown: true }, "after edits elsewhere");
});

/** Watch the video's iframe: its load events after now, writes to its src, and its leaving the page or moving in it. */
const WATCH = `(() => {
  const f = document.querySelector('.cm-url-embed[data-url-embed="youtube"] iframe');
  const w = (window.watched = { loads: 0, srcWrites: 0, moves: 0, frame: f });
  f.addEventListener("load", () => w.loads++);
  new MutationObserver((rs) => rs.forEach((r) => r.attributeName === "src" && w.srcWrites++)).observe(f, { attributes: true });
  new MutationObserver((rs) => rs.forEach((r) => [...r.removedNodes, ...r.addedNodes].forEach((n) => (n === f || n.contains?.(f)) && w.moves++))).observe(document.documentElement, { childList: true, subtree: true });
})()`;
const watched = (app: App) =>
  app.page.evaluate(() => {
    const w = (window as unknown as { watched: { loads: number; srcWrites: number; moves: number; frame: Element } }).watched;
    return { loads: w.loads, srcWrites: w.srcWrites, moves: w.moves, same: document.querySelector('.cm-url-embed[data-url-embed="youtube"] iframe') === w.frame };
  });
const untouched = { loads: 0, srcWrites: 0, moves: 0, same: true };

browserTest(h, "a link embed's iframe never loads again, has its src written or moves in the page: typing above it, a new tab, a split, the cursor on its line", {}, async (app) => {
  await app.writeFile("Video.md", "# Video\n\nA paragraph above it.\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\nBelow\n");
  await app.goto({}, "Video");
  await app.page.locator(FRAME).waitFor();
  await app.page.waitForTimeout(500);
  await app.page.evaluate(WATCH);
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>A and more<Esc>");
  assert.deepEqual(await watched(app), untouched, "typing in a paragraph above it");
  // A word on the blank line right above joins the link to a paragraph for now: its frame waits, hidden.
  await app.keys("jAx<Esc>");
  await app.page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)!.closest(".cm-embed")!).visibility === "hidden", FRAME);
  await app.keys("x");
  await app.page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)!.closest(".cm-embed")!).visibility === "visible", FRAME);
  assert.deepEqual(await watched(app), untouched, "typing on the line right above it, and taking it out");
  await app.keys("jj");
  await app.keys("jj");
  assert.deepEqual(await watched(app), untouched, "the cursor on its line and off");
  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.waitForFunction(() => document.title.startsWith("Welcome"));
  assert.equal(await app.page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!.closest(".cm-embed")!).visibility, FRAME), "hidden", "hidden with its tab");
  await app.page.locator(".tab", { hasText: "Video" }).first().click();
  await app.page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)!.closest(".cm-embed")!).visibility === "visible", FRAME);
  assert.deepEqual(await watched(app), untouched, "⌘-click opening a note in a new tab, and back");
  await app.command("Split right");
  await app.page.waitForFunction(() => document.querySelectorAll('.cm-url-embed[data-url-embed="youtube"] iframe').length === 2);
  assert.deepEqual(await watched(app), untouched, "splitting the window");
  // Each window's video shows over its own slot.
  await app.page.waitForTimeout(300);
  const over = await app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.embed-scroller .cm-url-embed[data-url-embed="youtube"]')].map((box) => {
      const f = box.getBoundingClientRect();
      const slots = [...document.querySelectorAll(".cm-embed-slot")].map((x) => x.getBoundingClientRect());
      return slots.some((x) => Math.abs(x.top - f.top) < 2 && Math.abs(x.left - f.left) < 2);
    }),
  );
  assert.deepEqual(over, [true, true], "each window's video over its own slot");
});

/**
 * Watch a calendar drawn in a note: its box and its page leaving the page or moving in it, the page
 * made again (another element), and its fetches of events (each a load of what it shows).
 */
const WATCH_CALENDAR = `(() => {
  const page = document.querySelector(".cal-page.is-embed");
  const box = page.closest(".cm-embed");
  const w = (window.calendar = { moves: 0, page, box, fetches: 0 });
  new MutationObserver((rs) => rs.forEach((r) => [...r.removedNodes, ...r.addedNodes].forEach((n) => (n === page || n === box || n.contains?.(box)) && w.moves++))).observe(document.documentElement, { childList: true, subtree: true });
  new PerformanceObserver((list) => list.getEntries().forEach((e) => e.name.includes("/api/events") && w.fetches++)).observe({ type: "resource" });
})()`;
const calendarWatched = (app: App) =>
  app.page.evaluate(() => {
    const w = (window as unknown as { calendar: { moves: number; page: Element; box: Element; fetches: number } }).calendar;
    const page = document.querySelector(".cal-page.is-embed");
    return { moves: w.moves, fetches: w.fetches, same: page === w.page && page?.closest(".cm-embed") === w.box, scrolled: (page?.querySelector(".cal-scroll") as HTMLElement | null)?.scrollTop ?? -1 };
  });

browserTest(h, "a calendar in a note is never drawn again, moved or loaded again: typing above it, a new tab, a split, the cursor on its line", { scenario: "calendar", levers: { now: "2026-10-05T08:00" } }, async (app) => {
  await app.writeFile("Calendar note.md", "# Calendar note\n\nA paragraph above it.\n\n::calendar{view=week height=300}\n\nBelow\n");
  await app.goto({ now: "2026-10-05T08:00" }, "Calendar note");
  await app.page.locator(".cal-page.is-embed .cal-event").first().waitFor();
  await app.page.waitForTimeout(500);
  // Scrolled to an hour of its own: what it shows is kept as it was, not drawn from nothing.
  await app.page.locator(".cal-page.is-embed .cal-scroll").evaluate((e) => (e.scrollTop = 123));
  await app.page.evaluate(WATCH_CALENDAR);
  const untouched = { moves: 0, fetches: 0, same: true, scrolled: 123 };
  const shown = (yes: boolean) => app.page.waitForFunction((yes) => (getComputedStyle(document.querySelector(".cal-page.is-embed")!.closest(".cm-embed")!).visibility === "visible") === yes, yes);
  await app.call("cursor", 3, 1);
  await app.keys("<Esc>A and more<Esc>");
  assert.deepEqual(await calendarWatched(app), untouched, "typing in a paragraph above it");
  // A word on the blank line right above: a directive starts a block of its own, so it stays drawn.
  await app.keys("jAx<Esc>");
  await app.idle();
  await shown(true);
  await app.keys("x");
  await app.idle();
  assert.deepEqual(await calendarWatched(app), untouched, "typing on the line right above it, and taking it out");
  await app.keys("j");
  await shown(false);
  await app.keys("j");
  await shown(true);
  assert.deepEqual(await calendarWatched(app), untouched, "the cursor on its line and off");
  await app.page.locator("#notes a", { hasText: "Calendar tour" }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.waitForFunction(() => document.title.startsWith("Calendar tour"));
  await shown(false);
  await app.page.locator(".tab", { hasText: "Calendar note" }).first().click();
  await shown(true);
  assert.deepEqual(await calendarWatched(app), untouched, "⌘-click opening a note in a new tab, and back");
  const calendars = await app.page.locator(".cal-page.is-embed").count();
  await app.command("Split right");
  await app.page.waitForFunction((n) => document.querySelectorAll(".cal-page.is-embed").length === n + 1, calendars);
  const after = await calendarWatched(app);
  assert.deepEqual({ ...after, fetches: 0 }, untouched, "splitting the window: the first calendar is untouched (the new window's own calendar loads its events)");
});
