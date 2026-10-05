// Google Calendar in a real browser, against the fake Google (FAKE_GOOGLE): the calendar syncs when it
// shows; when Google ends the grant, an edit waits, the status bar and the calendar say to reconnect,
// and one click goes to Google and says where to come back to; once reconnected, the edit goes out.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness({ DEV_USER: "tester@localhost", SEED: "1", LEVERS: "1", FAKE_GOOGLE: "1" });

async function post(app: App, route: string, data: unknown, method = "POST") {
  const res = await app.page.context().request.fetch(`${app.base}${route}`, { method, data });
  assert.ok(res.ok(), `${route}: ${res.status()} ${await res.text()}`);
  return res.json();
}

const statusItem = (app: App) => app.page.locator("#status-right", { hasText: "Reconnect Google Calendar" });

browserTest(h, "the calendar syncs from Google as it shows, and after Google ends the grant an edit waits until you reconnect", { scenario: "empty", allowErrors: [/503/] }, async (app) => {
  await app.command("Show calendar");
  await app.page.locator(".event", { hasText: "Dentist" }).waitFor();
  assert.ok(await app.page.locator(".event", { hasText: "Standup" }).count(), "the series came in");
  await post(app, "/api/levers/google", { revoked: true });
  const queued = (await post(app, "/api/event", { address: "event:google/primary/dentist", title: "Dentist (waiting)" }, "PATCH")) as { status: string };
  assert.equal(queued.status, "queued");
  await app.page.locator(".event", { hasText: "Dentist (waiting)" }).waitFor();
  await statusItem(app).waitFor();
  const banner = app.page.locator(".reconnect");
  await banner.waitFor();
  assert.match(await banner.innerText(), /One edit is waiting to go to Google/);
  // Reconnecting goes to Google, saying to come back here.
  // Google sign-in isn't set up in this Worker, so the page it lands on says so: what matters is where it went.
  await Promise.all([app.page.waitForURL(/\/auth\/google\?/), banner.locator("button", { hasText: "Reconnect Google Calendar" }).click()]);
  const went = app.page.url();
  const url = new URL(went);
  assert.equal(url.searchParams.get("data"), "1");
  assert.equal(url.searchParams.get("next"), "/");
  // Google gave the grant again: the waiting edit goes out, and the status bar has nothing to say.
  await post(app, "/api/levers/google", { revoked: false });
  await app.goto();
  for (let i = 0; i < 60; i++) {
    const status = (await (await app.page.context().request.get(`${app.base}/api/sources`)).json()) as { sources: Array<{ state: string; pending: number }> };
    if (status.sources[0].pending === 0 && status.sources[0].state === "ok") break;
    await app.page.waitForTimeout(250);
  }
  const status = (await (await app.page.context().request.get(`${app.base}/api/sources`)).json()) as { sources: Array<{ state: string; pending: number }> };
  assert.deepEqual([status.sources[0].state, status.sources[0].pending], ["ok", 0]);
  await app.page.waitForTimeout(500);
  assert.equal(await statusItem(app).count(), 0);
});
