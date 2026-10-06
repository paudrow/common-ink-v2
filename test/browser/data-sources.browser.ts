// Data sources in a real browser, on the Sample calendar: the Calendar view lists a series' occurrences
// with a moved one in its place and a cancelled one gone; an agent's edit shows at once and is in history
// as the agent's; a record opens read-only; and the Data sources view says what the source holds.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();
const LEVERS = { now: "2026-10-05T08:00" };

/** The Calendar view's events, as "time title" in order. */
const listed = (app: App) => app.page.locator(".event").evaluateAll((els) => els.map((e) => `${e.querySelector(".when")?.textContent} ${e.querySelector(".what")?.textContent}`.replace(/\s/g, " ")));

async function edit(app: App, method: "PATCH" | "POST" | "DELETE", body: Record<string, unknown>) {
  const res = await app.page.context().request.fetch(`${app.base}${method === "POST" ? "/api/events" : "/api/event"}`, { method, data: body, headers: { "X-Common-Ink-Agent": "Claude" } });
  assert.ok(res.ok(), `${method}: ${res.status()} ${await res.text()}`);
  return res.json() as Promise<{ address: string; status: string }>;
}

browserTest(h, "the Calendar view shows a series' occurrences, moved and cancelled ones too, and an agent's edit as it happens", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  await app.command("Show calendar");
  await app.page.locator(".event").first().waitFor();
  const before = await listed(app);
  assert.ok(before.includes("9:30 AM–9:45 AM Team standup (late start) ↻"), "tomorrow's standup starts late");
  assert.equal(before.filter((e) => e.includes("Team standup")).length, 9, "two weeks of weekday standups, less the cancelled one");
  await edit(app, "PATCH", { address: "event:sample/work/planning", start: "2026-10-05T16:00", title: "Planning, moved" });
  await app.page.locator(".event", { hasText: "Planning, moved" }).waitFor();
  assert.ok((await listed(app)).includes("4:00 PM–5:30 PM Planning, moved"));
  const history = (await (await app.page.context().request.get(`${app.base}/api/history?path=${encodeURIComponent(".common-ink/records/sample/events/work/planning.json")}`)).json()) as Array<{ author: { kind: string; name?: string } }>;
  assert.deepEqual(history.map((c) => c.author.name ?? c.author.kind), ["Claude", "Preview seed"]);
});

browserTest(h, "a record opens as JSON that can't be edited, and the Data sources view says what the Sample calendar holds", { scenario: "calendar", open: "Calendar tour", levers: LEVERS }, async (app) => {
  const path = ".common-ink/records/sample/events/work/planning.json";
  const before = await app.readFile(path);
  await app.call("open", path);
  await app.page.locator(".tab-editor:not([hidden]) .cm-line", { hasText: '"title": "Quarterly planning"' }).waitFor();
  await app.keys("ggddx");
  await app.idle();
  assert.equal(await app.readFile(path), before, "the record didn't change");
  await app.command("Show data sources");
  await app.page.locator(".data-source .counts", { hasText: "3 calendars · 11 events" }).waitFor();
  const made = await edit(app, "POST", { title: "Coffee", start: "2026-10-06T11:00", calendar: "personal" });
  assert.equal(made.status, "saved");
  await app.page.locator(".data-source .counts", { hasText: "3 calendars · 12 events" }).waitFor();
});

browserTest(h, "on the day the clocks go back, the Calendar view still heads the next day's events Tomorrow", { scenario: "calendar", open: "Calendar tour", timezone: "America/Chicago", levers: { now: "2026-11-01T10:00" } }, async (app) => {
  // Sunday Nov 1 has 25 hours in Chicago: 24 hours after its midnight is still Nov 1.
  await app.command("Show calendar");
  await app.page.locator(".event").first().waitFor();
  const heads = await app.page.locator("#panel h3").allTextContents();
  assert.ok(heads.includes("Tomorrow"), JSON.stringify(heads));
  assert.ok(!heads.some((h) => /November 2/.test(h)), JSON.stringify(heads));
});
