// Run by timeouts.browser.ts, not on its own: two tests whose page never answers, then one that's fine.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";

const h = harness();

browserTest(h, "waits on its page forever", { timeout: 5000 }, async (app) => {
  await app.page.evaluate(() => new Promise(() => {}));
});

browserTest(h, "holds its page's thread forever", { timeout: 5000 }, async (app) => {
  await app.page.evaluate(() => {
    for (;;);
  });
});

browserTest(h, "runs after them", {}, async (app) => {
  assert.equal(await app.page.evaluate(() => 1 + 1), 2);
});
