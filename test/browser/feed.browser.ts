// The Feed, touch first (study, sections 5.2 and 6.2): what a phone opens on, cards newest first under
// date groups, a swipe to archive or trash with Undo, a long press to select several, pages as you scroll,
// and a pill for changes that come while you're scrolled down.
import assert from "node:assert/strict";
import type { Locator } from "playwright-core";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const titles = (app: App) => app.page.locator(".feed-card-title").allInnerTexts();
const card = (app: App, title: string) => app.page.locator(".feed-card", { has: app.page.locator(`.feed-card-title:text-is("${title}")`) });
const archived = async (app: App) => JSON.parse((await app.readFile(".common-ink/archive.json").catch(() => "")) || "{}").archived ?? [];
const exists = (app: App, path: string) => app.page.evaluate(async (p) => (await fetch(`/api/file?path=${encodeURIComponent(p)}`)).ok, path);

/** A finger on a card: down near its left or right, across to `toX`, and up, as a phone sends it. */
async function swipe(app: App, target: Locator, fromX: number, toX: number, check?: () => Promise<void>) {
  const box = (await target.boundingBox())!;
  const cdp = await app.page.context().newCDPSession(app.page);
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
  const step = fromX < toX ? 30 : -30;
  for (let x = fromX + step; step > 0 ? x <= toX : x >= toX; x += step) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  await check?.();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** A finger held still on a card until the selection shows, as a person holds for a long press. */
async function hold(app: App, target: Locator) {
  const box = (await target.boundingBox())!;
  const cdp = await app.page.context().newCDPSession(app.page);
  const at = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at });
  await app.page.locator(".feed-selection").waitFor();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function notes(app: App, list: Array<[string, string]>) {
  for (const [path, text] of list) await app.writeFile(path, text);
  await app.reload();
  await app.page.locator(".feed-card").first().waitFor();
}

browserTest(h, "a phone opens on the Feed: cards newest first under date groups, with a few quiet lines, who changed each, and a tap to read it", { scenario: "empty", device: "phone" }, async (app) => {
  await notes(app, [
    ["Older.md", "# Older\nfrom before"],
    ["Focus.md", '# Focus\n::timer{duration=25m label="Deep work"}\n- [ ] Write the brief\nSee [[Older|the old one]].'],
  ]);
  assert.equal(await app.page.locator("#shell-top h1").innerText(), "Feed");
  assert.deepEqual(await titles(app), ["Focus", "Older"]);
  assert.deepEqual(await app.page.locator(".feed-group-title").allInnerTexts(), ["TODAY"]);
  const focus = card(app, "Focus");
  assert.deepEqual(await focus.locator(".feed-line").allInnerTexts(), ["Timer · 25m · Deep work", "Write the brief", "See the old one."]);
  assert.equal(await focus.locator(".feed-line.embed").count(), 1, "the timer is a quiet line: nothing runs");
  assert.equal(await focus.locator(".feed-who").innerText(), "you");

  await focus.locator(".feed-card-title").tap();
  await app.page.locator("#shell-top h1", { hasText: "Focus" }).waitFor();
  await app.page.goBack();
  await app.page.locator("#shell-top h1", { hasText: "Feed" }).waitFor();
  await card(app, "Focus").waitFor();
});

browserTest(h, "a swipe right archives a card, green as it goes, and Undo brings it back", { scenario: "empty", device: "phone" }, async (app) => {
  await notes(app, [["Keep.md", "# Keep\nstays"], ["Done with.md", "# Done with\nfinished"]]);
  const target = card(app, "Done with");
  await swipe(app, target, 40, 300, async () => assert.match((await target.getAttribute("data-swipe")) ?? "", /right archive armed/, "green, and ready to archive"));
  await app.page.locator(".notice", { hasText: 'Archived "Done with"' }).waitFor();
  assert.deepEqual(await titles(app), ["Keep"]);
  assert.deepEqual(await archived(app), ["Done with.md"]);
  await app.page.locator(".notice").getByRole("button", { name: "Undo" }).tap();
  await card(app, "Done with").waitFor();
  assert.deepEqual(await archived(app), []);
});

browserTest(h, "a swipe left moves a card to Trash, red as it goes, and Undo restores it", { scenario: "empty", device: "phone" }, async (app) => {
  await notes(app, [["Keep.md", "# Keep\nstays"], ["Scrap.md", "# Scrap\nnot needed"]]);
  const target = card(app, "Scrap");
  await swipe(app, target, 330, 40, async () => assert.match((await target.getAttribute("data-swipe")) ?? "", /left delete armed/, "red, and ready to trash"));
  await app.page.locator(".notice", { hasText: 'Moved "Scrap" to Trash' }).waitFor();
  assert.equal(await exists(app, "Scrap.md"), false);
  assert.deepEqual(await titles(app), ["Keep"]);
  await app.page.locator(".notice").getByRole("button", { name: "Undo" }).tap();
  await card(app, "Scrap").waitFor();
  assert.equal(await exists(app, "Scrap.md"), true);
});

browserTest(h, "the feed.swipe settings say what each swipe does: none does nothing, trash on the right trashes", { scenario: "empty", device: "phone" }, async (app) => {
  await app.writeFile(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "feed.swipe.right": "none", "feed.swipe.left": "archive" }));
  await notes(app, [["One.md", "# One\na"], ["Two.md", "# Two\nb"]]);
  await swipe(app, card(app, "One"), 40, 300);
  await app.page.waitForTimeout(500);
  assert.deepEqual(await titles(app), ["Two", "One"], "a swipe right does nothing");
  await swipe(app, card(app, "One"), 330, 40);
  await app.page.locator(".notice", { hasText: 'Archived "One"' }).waitFor();
  assert.deepEqual(await archived(app), ["One.md"]);
});

browserTest(h, "a long press selects a card, taps add others, and Archive archives them all in one change that Undo takes back", { scenario: "empty", device: "phone" }, async (app) => {
  await notes(app, [["A.md", "# A\na"], ["B.md", "# B\nb"], ["C.md", "# C\nc"]]);
  await hold(app, card(app, "A"));
  await app.page.locator(".feed-selection", { hasText: "1 selected" }).waitFor();
  assert.equal(await app.page.locator("#shell-top h1").innerText(), "Feed", "a long press opens nothing");
  await card(app, "C").locator(".feed-card-title").tap();
  await app.page.locator(".feed-selection", { hasText: "2 selected" }).waitFor();
  await app.page.locator(".feed-selection").getByRole("button", { name: "Archive" }).tap();
  await app.page.locator(".notice", { hasText: "Archived 2 notes" }).waitFor();
  assert.deepEqual(await titles(app), ["B"]);
  assert.deepEqual(await archived(app), ["A.md", "C.md"]);
  const changes = await app.page.evaluate(async () => (await (await fetch("/api/history?path=.common-ink%2Farchive.json")).json()).length);
  assert.equal(changes, 1, "one change to the archive file");
  await app.page.locator(".notice").getByRole("button", { name: "Undo" }).tap();
  await card(app, "A").waitFor();
  assert.deepEqual(await archived(app), []);
});

browserTest(h, "the Feed reads a page at a time as you scroll, and a change while you're scrolled down waits under a pill", { scenario: "empty", device: "phone" }, async (app) => {
  const many: Array<[string, string]> = Array.from({ length: 70 }, (_, i) => [`Note ${String(i).padStart(2, "0")}.md`, `# Note ${String(i).padStart(2, "0")}\nline ${i}`]);
  await notes(app, many);
  assert.equal((await titles(app)).length, 30, "one page at first");
  await app.page.locator(".feed-end").scrollIntoViewIfNeeded();
  await app.page.waitForFunction(() => document.querySelectorAll(".feed-card").length > 30);
  const before = await titles(app);
  assert.equal(before[0], "Note 69", "newest first");

  await app.writeFile("Note 05.md", "# Note 05\nchanged by someone else");
  await app.page.locator(".feed-pill", { hasText: "↑ 1 new change" }).waitFor();
  assert.deepEqual((await titles(app)).slice(0, 3), before.slice(0, 3), "the list didn't move under you");
  await app.page.locator(".feed-pill").tap();
  await app.page.waitForFunction(() => document.querySelector(".feed-card-title")?.textContent === "Note 05");
  assert.equal(await app.page.locator(".feed-pill").count(), 0);
});

browserTest(h, "at the top, a change comes straight in; on a laptop, Open the Feed shows it in a tab", { scenario: "empty" }, async (app) => {
  await app.writeFile("First.md", "# First\na");
  await app.command("Open the Feed");
  await card(app, "First").waitFor();
  await app.writeFile("Second.md", "# Second\nb");
  await app.page.waitForFunction(() => document.querySelector(".feed-card-title")?.textContent === "Second");
  assert.equal(await app.page.locator(".feed-pill").count(), 0);
});
