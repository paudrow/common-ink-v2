// The Feed with a keyboard (study, sections 5.2 and 9.3): j and k move, ↵ opens, e archives, # or dd
// moves to Trash, p pins, x selects, u undoes; and pins, which put a note first, under Pinned.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const titles = (app: App) => app.page.locator(".feed-card-title").allInnerTexts();
const focused = (app: App) => app.page.evaluate(() => document.activeElement?.closest(".feed-card")?.querySelector(".feed-card-title")?.textContent ?? null);
const archived = async (app: App) => JSON.parse((await app.readFile(".common-ink/archive.json").catch(() => "")) || "{}").archived ?? [];
const pinned = async (app: App) => JSON.parse((await app.readFile(".common-ink/pins.json").catch(() => "")) || "{}").pinned ?? [];
const exists = (app: App, path: string) => app.page.evaluate(async (p) => (await fetch(`/api/file?path=${encodeURIComponent(p)}`)).ok, path);

/** Notes C, B, A (newest first), and the Feed open with the keyboard on its first card. */
async function feed(app: App) {
  for (const n of ["A", "B", "C"]) await app.writeFile(`${n}.md`, `# ${n}\nabout ${n}`);
  await app.command("Open the Feed");
  await app.page.locator(".feed-card").nth(2).waitFor();
  await app.page.keyboard.press("j");
  assert.equal(await focused(app), "C");
}

browserTest(h, "j and k move between cards, ↵ opens one, e archives it and the keyboard goes on to the next, and u takes it back", { scenario: "empty" }, async (app) => {
  await feed(app);
  await app.page.keyboard.press("j");
  await app.page.keyboard.press("j");
  await app.page.keyboard.press("k");
  assert.equal(await focused(app), "B");
  await app.page.keyboard.press("e");
  await app.page.locator(".notice", { hasText: 'Archived "B"' }).waitFor();
  assert.deepEqual(await titles(app), ["C", "A"]);
  assert.deepEqual(await archived(app), ["B.md"]);
  assert.equal(await focused(app), "A", "on to the next card");
  await app.page.keyboard.press("u");
  await app.page.waitForFunction(() => document.querySelectorAll(".feed-card").length === 3);
  assert.deepEqual(await archived(app), []);

  await app.page.keyboard.press("k");
  await app.page.keyboard.press("Enter");
  await app.page.locator(".tab-editor:not([hidden]) .cm-content", { hasText: "about" }).waitFor();
});

browserTest(h, "# and dd move the card to Trash, and u restores the last", { scenario: "empty" }, async (app) => {
  await feed(app);
  await app.page.keyboard.press("#");
  await app.page.locator(".notice", { hasText: 'Moved "C" to Trash' }).waitFor();
  assert.equal(await exists(app, "C.md"), false);
  assert.equal(await focused(app), "B");
  await app.page.keyboard.press("d");
  await app.page.keyboard.press("d");
  await app.page.locator(".notice", { hasText: 'Moved "B" to Trash' }).waitFor();
  assert.equal(await exists(app, "B.md"), false);
  assert.deepEqual(await titles(app), ["A"]);
  await app.page.keyboard.press("u");
  await app.page.waitForFunction(() => document.querySelectorAll(".feed-card").length === 2);
  assert.equal(await exists(app, "B.md"), true, "the last one came back");
});

browserTest(h, "p pins a card, first under Pinned, in the order pinned, and p again unpins it", { scenario: "empty" }, async (app) => {
  await feed(app);
  await app.page.keyboard.press("j");
  await app.page.keyboard.press("j");
  assert.equal(await focused(app), "A");
  await app.page.keyboard.press("p");
  await app.page.locator(".notice", { hasText: 'Pinned "A"' }).waitFor();
  await app.page.waitForFunction(() => document.querySelector(".feed-card-title")?.textContent === "A");
  assert.deepEqual(await app.page.locator(".feed-group-title").allInnerTexts(), ["PINNED", "TODAY"]);
  assert.deepEqual(await pinned(app), ["A.md"]);
  assert.equal(await app.page.locator('.feed-group.pinned .feed-card [aria-label="Pinned"]').count(), 1);
  await app.page.locator(".feed-card", { hasText: "about C" }).locator(".feed-card-body").focus();
  await app.page.keyboard.press("p");
  await app.page.waitForFunction(() => document.querySelectorAll(".feed-group.pinned .feed-card").length === 2);
  assert.deepEqual(await pinned(app), ["A.md", "C.md"]);
  assert.deepEqual(await titles(app), ["A", "C", "B"]);
  await app.page.keyboard.press("p");
  await app.page.waitForFunction(() => document.querySelectorAll(".feed-group.pinned .feed-card").length === 1);
  assert.deepEqual(await pinned(app), ["A.md"]);
});

browserTest(h, "x selects cards, and e archives them all in one change", { scenario: "empty" }, async (app) => {
  await feed(app);
  await app.page.keyboard.press("x");
  await app.page.keyboard.press("j");
  await app.page.keyboard.press("j");
  await app.page.keyboard.press("x");
  await app.page.locator(".feed-selection", { hasText: "2 selected" }).waitFor();
  await app.page.keyboard.press("e");
  await app.page.locator(".notice", { hasText: "Archived 2 notes" }).waitFor();
  assert.deepEqual(await titles(app), ["B"]);
  assert.deepEqual(await archived(app), ["A.md", "C.md"]);
});

browserTest(h, "on a phone, feed.swipe set to pin pins a card with a swipe", { scenario: "empty", device: "phone" }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "feed.swipe.right": "pin" }));
  for (const n of ["A", "B"]) await app.writeFile(`${n}.md`, `# ${n}\nabout ${n}`);
  await app.reload();
  const card = app.page.locator(".feed-card", { hasText: "about A" });
  await card.waitFor();
  const box = (await card.boundingBox())!;
  const cdp = await app.page.context().newCDPSession(app.page);
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 40, y }] });
  for (let x = 70; x <= 310; x += 30) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  assert.match((await card.getAttribute("data-swipe")) ?? "", /right pin armed/);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await app.page.locator(".notice", { hasText: 'Pinned "A"' }).waitFor();
  assert.deepEqual(await pinned(app), ["A.md"]);
});
