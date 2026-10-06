// Signing out in a real browser: what this browser kept of the workspace goes, and the service worker
// doesn't put its cache back while the sign-out page loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

const h = harness();

test("after signing out, no cache of the app is left behind", async () => {
  const context = await h.browser.newContext();
  const page = await context.newPage();
  await page.goto(`${h.base}/`);
  await page.waitForSelector(".cm-content");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector(".cm-content");
  await page.waitForFunction(async () => (await caches.keys()).length > 0);
  await page.evaluate(() => location.assign("/auth/sign-out"));
  await page.waitForSelector("text=Signed out");
  await page.waitForTimeout(1000);
  assert.deepEqual(await page.evaluate(() => caches.keys()), []);
  await context.close();
});
