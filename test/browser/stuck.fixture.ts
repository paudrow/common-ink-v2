// Run by timeouts.browser.ts, not on its own: two tests whose page never answers, then one that's fine.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness } from "./harness.ts";

const h = harness();
const stuck: Page[] = [];

browserTest(h, "waits on its page forever", { timeout: 5000 }, async (app) => {
  stuck.push(app.page);
  await app.page.evaluate(() => new Promise(() => {}));
});

browserTest(h, "holds its page's thread forever", { timeout: 5000 }, async (app) => {
  stuck.push(app.page);
  await app.page.evaluate(() => {
    for (;;);
  });
});

browserTest(h, "runs after them", {}, async (app) => {
  assert.equal(await app.page.evaluate(() => 1 + 1), 2);
  const closed = stuck.map((page) => new Promise((done) => (page.isClosed() ? done(true) : page.once("close", () => done(true)))));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise((done) => (timer = setTimeout(() => done(false), 20_000)));
  const results = await Promise.all(closed.map((c) => Promise.race([c, late])));
  clearTimeout(timer);
  assert.deepEqual(results, [true, true], "the stuck tests' pages were closed");
});
