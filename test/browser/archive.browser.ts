// Archive, in a real browser against the real Worker: ⌘⇧E and :archive archive the note on show, which
// says so at its top and comes last in search; Undo and Unarchive bring it back. On a phone, the same
// from the command, with the banner's Unarchive tapped.
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { browserTest, harness } from "./harness.ts";

const h = harness();

const banner = (page: Page) => page.locator(".tab-editor:not([hidden]) .archive-banner");
const archivedPaths = (page: Page) => page.evaluate(async () => ((await (await fetch("/api/files")).json()) as Array<{ path: string; archived?: true }>).filter((f) => f.archived).map((f) => f.path));

browserTest(h, "⌘⇧E archives the note on show: it says so at its top, comes last in search, and Undo takes it back", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Launch plan.md", "# Launch plan\nShip the launch.");
  await app.writeFile("Launch retro.md", "# Launch retro\nHow the launch went.");
  await app.open("Launch plan");
  await app.call("idle");
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await banner(page).waitFor();
  assert.deepEqual(await archivedPaths(page), ["Launch plan.md"]);
  assert.match((await page.locator(".notice").textContent()) ?? "", /Archived "Launch plan"/);
  await page.locator(".notice button", { hasText: "Undo" }).click();
  await banner(page).waitFor({ state: "hidden" });
  assert.deepEqual(await archivedPaths(page), []);

  await page.locator(".tab-editor:not([hidden]) .cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await banner(page).waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#command-bar input").fill("launch");
  await page.locator("#command-bar ul:not([aria-busy])").waitFor({ state: "attached" });
  const rows = await page.locator("#command-bar li[role=option]").evaluateAll((lis) => lis.slice(0, 2).map((li) => `${li.querySelector(".label")!.textContent}${li.classList.contains("dim") ? " (dim)" : ""}: ${li.querySelector(".aside")?.textContent ?? ""}`));
  assert.equal(rows[0].startsWith("Launch retro: "), true, rows.join(" | "));
  assert.match(rows[1], /^Launch plan \(dim\): archived · /);
});

browserTest(h, ":archive and :unarchive in Vim, and the banner's Unarchive", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Reading list.md", "# Reading list\n");
  await app.open("Reading list");
  await app.call("idle");
  await page.locator(".tab-editor:not([hidden]) .cm-content").first().focus();
  await app.keys("<Esc>:archive<CR>");
  await banner(page).waitFor();
  await app.keys(":unarchive<CR>");
  await banner(page).waitFor({ state: "hidden" });
  await app.keys(":archive<CR>");
  await banner(page).waitFor();
  await banner(page).locator("button", { hasText: "Unarchive" }).click();
  await banner(page).waitFor({ state: "hidden" });
  assert.deepEqual(await archivedPaths(page), []);
});

browserTest(h, "on a phone, an archived note says so, and Unarchive is a tap", { scenario: "empty", viewport: { width: 375, height: 812 }, touch: true }, async (app) => {
  const { page } = app;
  await app.writeFile("Groceries.md", "# Groceries\nEggs");
  await app.open("Groceries");
  await app.call("idle");
  await app.command("Archive this note");
  await banner(page).waitFor();
  const box = await banner(page).boundingBox();
  assert.ok(box && box.width <= 375 && box.x >= 0, `the banner fits the screen: ${JSON.stringify(box)}`);
  await banner(page).locator("button", { hasText: "Unarchive" }).tap();
  await banner(page).waitFor({ state: "hidden" });
  assert.deepEqual(await archivedPaths(page), []);
});

const post = (page: Page, route: string, body: unknown) => page.evaluate(async ([r, b]) => (await fetch(r as string, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).status, [route, body] as const);

browserTest(h, "an archive made elsewhere shows at once, even with another change right after it", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Alpha.md", "# Alpha\n");
  await app.writeFile("Beta.md", "# Beta\n");
  await app.open("Alpha");
  await app.call("idle");
  // An agent archives the note on show, then writes another note within the same moment.
  await page.context().request.post(`${app.base}/api/archive`, { data: { paths: ["Alpha.md"] }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await page.context().request.put(`${app.base}/api/file`, { data: { path: "Beta.md", text: "# Beta\nagent edit", base: 2 }, headers: { "X-Common-Ink-Agent": "Claude" } });
  await banner(page).waitFor();
});

browserTest(h, "Undo takes back an archive after another note was archived, and says so when it can't", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Alpha.md", "# Alpha\n");
  await app.writeFile("Beta.md", "# Beta\n");
  await app.open("Alpha");
  await app.call("idle");
  await app.command("Archive this note");
  await page.locator(".notice", { hasText: "Archived" }).waitFor();
  assert.equal(await post(page, "/api/archive", { paths: ["Beta.md"] }), 200);
  await page.locator(".notice button", { hasText: "Undo" }).click();
  await banner(page).waitFor({ state: "hidden" });
  assert.deepEqual(await archivedPaths(page), ["Beta.md"]);

  await app.command("Archive this note");
  await page.locator(".notice", { hasText: "Archived" }).waitFor();
  await app.writeFile(".common-ink/archive.json", "{ not json");
  await page.locator(".notice button", { hasText: "Undo" }).click();
  await page.locator(".notice", { hasText: "Couldn't undo archiving" }).waitFor();
});

browserTest(h, "archiving while offline says so plainly", { scenario: "empty", allowErrors: [/ERR_INTERNET_DISCONNECTED/] }, async (app) => {
  const { page } = app;
  await app.writeFile("Alpha.md", "# Alpha\n");
  await app.open("Alpha");
  await app.call("idle");
  await page.context().setOffline(true);
  await app.command("Archive this note");
  await page.locator(".notice", { hasText: "Couldn't archive \"Alpha\": you're offline; try again once you're back" }).waitFor();
  await page.context().setOffline(false);
});

browserTest(h, "a notice sits below an archived note's line on a wide screen", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Alpha.md", "# Alpha\n");
  await app.open("Alpha");
  await app.call("idle");
  await app.command("Archive this note");
  await page.locator(".notice", { hasText: "Archived" }).waitFor();
  await banner(page).waitFor();
  const [b, n] = [await banner(page).boundingBox(), await page.locator(".notice").boundingBox()];
  assert.ok(b && n && n.y >= b.y + b.height, `notice ${JSON.stringify(n)} under banner ${JSON.stringify(b)}`);
});

browserTest(h, "on a phone, a notice hides none of the note and goes by itself", { scenario: "empty", viewport: { width: 375, height: 812 }, touch: true }, async (app) => {
  const { page } = app;
  await app.writeFile("Long.md", `# Long\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`).join("\n")}\n`);
  await app.open("Long");
  await app.call("idle");
  await app.call("cursor", 81, 1);
  await app.command("Archive this note");
  const notice = page.locator(".notice");
  await notice.waitFor();
  // Lines the scroller shows (it clips the rest) that are under the notice.
  const covered = await page.evaluate(() => {
    const n = document.querySelector(".notice")!.getBoundingClientRect();
    const s = document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.getBoundingClientRect();
    return [...document.querySelectorAll(".tab-editor:not([hidden]) .cm-line")].filter((l) => {
      const r = l.getBoundingClientRect();
      const top = Math.max(r.top, s.top);
      const bottom = Math.min(r.bottom, s.bottom);
      return bottom > top && bottom > n.top + 1 && top < n.bottom - 1;
    }).length;
  });
  assert.equal(covered, 0, "no line of the note is under the notice");
  await notice.waitFor({ state: "detached", timeout: 12_000 });
});

browserTest(h, "a notice shown on a wide screen goes by itself once the window narrows to a phone's", { scenario: "empty" }, async (app) => {
  const { page } = app;
  await app.writeFile("Alpha.md", "# Alpha\n");
  await app.open("Alpha");
  await app.call("idle");
  await app.command("Archive this note");
  const notice = page.locator(".notice", { hasText: "Archived" });
  await notice.waitFor();
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.mouse.move(0, 0);
  await notice.waitFor({ state: "detached", timeout: 12_000 });
});
