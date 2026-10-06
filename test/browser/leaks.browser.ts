// What closing a window leaves behind, measured in a real browser: once the first few have warmed things
// up, splitting a note with embeds (or calendars) and closing the split again leaves no DOM nodes or listeners behind.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

/** DOM nodes and event listeners alive, after a forced garbage collection. */
async function alive(app: App) {
  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
  const get = (name: string) => metrics.find((m) => m.name === name)!.value;
  await cdp.detach();
  return { nodes: get("Nodes"), listeners: get("JSEventListeners") };
}

async function splitAndClose(app: App, times: number) {
  for (let i = 0; i < times; i++) {
    await app.keys(":vs<CR>");
    await app.page.waitForTimeout(150);
    await app.keys("<C-w>c");
    await app.page.waitForTimeout(150);
  }
  await app.idle();
  // An embed's frame waits up to 5 s for its first paint, holding on to it until then.
  await app.page.waitForTimeout(5500);
}

browserTest(h, "closing a split of a note with embeds (timers, noise, an html-app) leaves nothing behind", { scenario: "embeds", open: "Embeds tour.md" }, async (app) => {
  await app.idle();
  await splitAndClose(app, 5);
  const before = await alive(app);
  await splitAndClose(app, 10);
  const after = await alive(app);
  assert.ok(after.nodes - before.nodes < 50 && after.listeners - before.listeners < 20, `ten splits closed left ${after.nodes - before.nodes} nodes and ${after.listeners - before.listeners} listeners`);
});

browserTest(h, "closing a split of a note with calendars leaves nothing behind", { scenario: "calendar", open: "Week at a glance", levers: { now: "2026-10-05T08:00" } }, async (app) => {
  await app.page.locator(".cal-page.is-embed .cal-event").first().waitFor();
  await splitAndClose(app, 5);
  const before = await alive(app);
  await splitAndClose(app, 8);
  const after = await alive(app);
  assert.ok(after.nodes - before.nodes < 50 && after.listeners - before.listeners < 20, `eight splits closed left ${after.nodes - before.nodes} nodes and ${after.listeners - before.listeners} listeners`);
});
