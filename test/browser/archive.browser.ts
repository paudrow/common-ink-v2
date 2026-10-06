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
