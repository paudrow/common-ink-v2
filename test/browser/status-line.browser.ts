// The status line: on a laptop, the focused note's word count (the Words extension) and whether the
// server can be reached; on a phone, no status line, and a line at the top only when something isn't saved.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();
const OFFLINE = { allowErrors: [/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/] };

const words = (app: App) => app.page.locator('[data-item="words.count"]');
const shown = (app: App, selector: string) => app.page.locator(selector).isVisible();

browserTest(h, "on a laptop the status line counts the focused note's words as you type, and says Online", { scenario: "empty" }, async (app) => {
  await app.writeFile("Trip.md", "# Trip to Rome\n\n- [ ] Book the train\n");
  await app.writeFile("Other.md", "# Other\n");
  await app.goto({}, "Trip");
  await app.idle();
  await words(app).filter({ hasText: /^6 words$/ }).waitFor();
  assert.equal(await app.page.locator("#unsent").textContent(), "Online");
  await app.call("cursor", 3, 1);
  await app.keys("A and the ferry<Esc>");
  await words(app).filter({ hasText: /^9 words$/ }).waitFor();
  await app.open("Other");
  await words(app).filter({ hasText: /^1 word$/ }).waitFor();
  assert.equal(await shown(app, "#status"), true);
  assert.equal(await shown(app, "#not-saved"), false);
});

browserTest(h, "on a phone there's no status line, and offline shows only once something isn't saved", { scenario: "empty", viewport: { width: 375, height: 812 }, ...OFFLINE }, async (app) => {
  await app.writeFile("Trip.md", "# Trip\n");
  await app.goto({}, "Trip");
  await app.idle();
  assert.equal(await shown(app, "#status"), false);
  assert.equal(await shown(app, "#not-saved"), false);

  await app.page.context().setOffline(true);
  await app.page.waitForFunction(() => document.querySelector("#unsent")?.textContent === "Offline");
  assert.equal(await shown(app, "#not-saved"), false, "offline with everything saved says nothing");

  await app.call("cursor", 1, 7);
  await app.keys("o- packed<Esc>");
  await app.page.locator("#not-saved", { hasText: /^Not saved: offline$/ }).waitFor();
  const line = (await app.page.locator("#not-saved").boundingBox())!;
  const workbench = (await app.page.locator("#workbench").boundingBox())!;
  assert.ok(line.y < workbench.y, "the line is above the note, at the top");

  await app.page.context().setOffline(false);
  await app.page.locator("#not-saved").waitFor({ state: "hidden" });
  for (let i = 0; i < 40 && (await app.readFile("Trip.md")) !== "# Trip\n- packed\n"; i++) await app.page.waitForTimeout(250);
  assert.equal(await app.readFile("Trip.md"), "# Trip\n- packed\n");
});
