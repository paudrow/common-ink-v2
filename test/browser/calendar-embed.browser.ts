// ::calendar in a note, in a real browser on the Sample calendar: the list shows its days and the week
// its events; both keep up with an edit made anywhere; a drag in the week makes an event; and new
// arguments redraw the same calendar in place.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();
const LEVERS = { now: "2026-10-05T08:00" };
const HOUR = 48;

browserTest(h, "a calendar in a note lists its days, keeps up with edits, makes events, and takes new arguments in place", { scenario: "calendar", open: "Week at a glance", levers: LEVERS }, async (app) => {
  const embeds = app.page.locator(".cal-page.is-embed");
  await embeds.nth(1).locator(".cal-event").first().waitFor();
  const list = embeds.nth(0);
  assert.deepEqual(await list.locator(".cal-agenda-day").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.day)), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  await list.locator(".cal-row", { hasText: "Dentist" }).waitFor();
  // An edit made anywhere shows in both.
  const res = await app.page.context().request.fetch(`${app.base}/api/event`, { method: "PATCH", data: { address: "event:sample/personal/dentist", title: "Dentist (cleaning)" } });
  assert.ok(res.ok());
  await list.locator(".cal-row", { hasText: "Dentist (cleaning)" }).waitFor();
  await embeds.nth(1).locator(".cal-event", { hasText: "Dentist (cleaning)" }).waitFor();
  // A drag in the week makes an event as long as the drag.
  const week = embeds.nth(1);
  await week.scrollIntoViewIfNeeded();
  const column = (await week.locator('.cal-day[data-day="2026-10-07"]').boundingBox())!;
  const scrolled = await week.locator(".cal-scroll").evaluate((e) => e.scrollTop);
  const y = (minutes: number) => column.y + (minutes / 60) * HOUR;
  assert.ok(scrolled > 0, "it opens at the start hour");
  await app.page.mouse.move(column.x + column.width / 2, y(10 * 60 + 5));
  await app.page.mouse.down();
  for (let i = 1; i <= 6; i++) await app.page.mouse.move(column.x + column.width / 2, y(10 * 60 + 5 + i * 10));
  await app.page.mouse.up();
  await app.page.locator(".cal-editor").waitFor();
  await app.page.keyboard.type("Pairing");
  await app.page.keyboard.press("Enter");
  await week.locator(".cal-event", { hasText: "Pairing" }).waitFor();
  // New arguments: the same calendar, drawn again as a week, at the same dates.
  await list.evaluate((e) => ((e as HTMLElement).dataset.marker = "kept"));
  const text = await app.readFile("Week at a glance.md");
  await app.writeFile("Week at a glance.md", text.replace("::calendar{view=agenda days=3}", "::calendar{view=3day height=300}"));
  await app.page.locator('.cal-page.is-embed[data-marker="kept"] .cal-grid').waitFor();
  assert.equal(await app.page.locator('.cal-page.is-embed[data-marker="kept"] .cal-title-text').innerText(), "Oct 5 – 7, 2026");
});
