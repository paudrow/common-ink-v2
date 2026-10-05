// Without LEVERS, as production runs (it has no dev user either): every test lever is ignored. The page
// gets no inspector and its clock is real, the levers' API isn't there, and the cookie that turns on the
// replayed network changes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

const h = harness({ DEV_USER: "tester@localhost", SEED: "1", DATA_FIXTURES: "1" });

test("without LEVERS, the page has no inspector or levers' code, its clock is real, and webviews aren't probed", async () => {
  const context = await h.browser.newContext();
  const page = await context.newPage();
  const loaded: string[] = [];
  page.on("request", (r) => loaded.push(new URL(r.url()).pathname));
  await page.goto(`${h.base}/?file=${encodeURIComponent("Three.js scene.md")}&now=2001-01-01T09:00&permissions=allow&offline=1`);
  await page.waitForSelector("iframe.webview");
  assert.equal(await page.locator('meta[name="common-ink-levers"]').count(), 0);
  assert.equal(await page.evaluate(() => "__commonInk" in window), false);
  assert.notEqual(await page.evaluate(() => new Date().getFullYear()), 2001);
  assert.equal(await page.locator("iframe.webview").getAttribute("src"), "/sandbox/webview");
  assert.deepEqual(loaded.filter((p) => /\/assets\/dev-/.test(p)), [], "the levers' code is never fetched");
  assert.equal(await page.evaluate(() => navigator.onLine), true);
  await context.close();
});

test("without LEVERS, the levers' API answers 404 and a replay cookie doesn't replay", async () => {
  const context = await h.browser.newContext();
  await context.addCookies([{ name: "common-ink-levers", value: encodeURIComponent("net=replay"), url: h.base }]);
  const request = context.request;
  assert.equal((await request.get(`${h.base}/api/levers`)).status(), 404);
  assert.equal((await request.post(`${h.base}/api/levers/reset`, { data: { scenario: "empty" } })).status(), 404);
  assert.ok(((await (await request.get(`${h.base}/api/files`)).json()) as unknown[]).length > 1, "the workspace wasn't emptied");
  const card = await request.post(`${h.base}/api/extensions/fetch`, { data: { extension: "link-embeds", url: "https://recorded.example/pen", card: true, once: false } });
  assert.notEqual(((await card.json()) as { title?: string }).title, "A recorded pen", "the recording is only for levers");
  await context.close();
});
