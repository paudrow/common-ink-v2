// Embeds in a real browser against the real Worker: built-in timers and noise drawn in the page, and
// Catalog extensions' embeds in sandboxed webviews, three.js included, with Stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness } from "./harness.ts";

const h = harness();

const statusItem = (page: Page, id: string) => page.evaluate((id) => document.querySelector<HTMLElement>(`[data-item="${id}"]`)?.textContent ?? null, id);

test("a timer runs from its note, shows in the status bar, and keeps going across a reload; noise gets the mini player", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${h.base}/?file=${encodeURIComponent("Embeds tour.md")}`);
  await page.waitForSelector(".timer-embed");
  await page.locator(".timer-embed button", { hasText: "Start" }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-item="timers.running"]')?.textContent?.startsWith("⏱ Focus 24:"));
  await page.reload();
  await page.waitForSelector(".timer-embed");
  await page.waitForFunction(() => document.querySelector('[data-item="timers.running"]')?.textContent?.startsWith("⏱ Focus 24:"));
  assert.equal(await page.locator(".timer-embed button").first().textContent(), "Pause", "still running");
  const history = await page.evaluate(() => fetch(`/api/history?path=${encodeURIComponent(".common-ink/extensions/timers/state.json")}`).then((r) => r.json()));
  assert.equal((history.changes ?? history)[0].author.kind, "extension", "its state is the Timers extension's change");
  await page.locator(".noise-embed button").click();
  await page.waitForSelector(".mini-player:not([hidden])");
  assert.equal(await statusItem(page, "media.playing"), "♪ Brown noise");
  await page.locator(".mini-player button[aria-label='Stop']").click();
  await page.waitForSelector(".mini-player[hidden]", { state: "attached" });
  assert.deepEqual(errors, []);
  await page.close();
});

test("Catalog embeds run sandboxed: a uPlot chart and a three.js scene, in a frame with Stop; one not installed offers to install, and draws at once", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 900 } });
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => /Content Security Policy|Refused|Error creating WebGL|WebGL context lost/.test(m.text()) && problems.push(m.text()));
  // The Preview comes with HTML app installed, for its demos; Pomodoro isn't.
  await page.goto(`${h.base}/?file=${encodeURIComponent("Embeds tour.md")}`);
  await page.waitForSelector(".cm-content");
  // It's at the end of the note: the editor draws only what's in view.
  await page.waitForFunction(() => {
    const s = document.querySelector(".cm-scroller")!;
    s.scrollTop = s.scrollHeight;
    return !!document.querySelector('.cm-embed[data-embed="html-app"] iframe.webview');
  });
  const chart = page.frameLocator('.cm-embed[data-embed="html-app"] iframe');
  await chart.locator(".uplot canvas").waitFor();
  // Pomodoro's block offers to install it, and draws once it's installed, with no reload.
  const needs = page.locator(".cm-embed-needs", { hasText: "This needs Pomodoro from the Catalog" });
  await needs.waitFor();
  await needs.getByRole("button", { name: "Install" }).click();
  await page.waitForSelector('.cm-embed[data-embed="pomodoro"] iframe.webview');
  await page.frameLocator('.cm-embed[data-embed="pomodoro"] iframe').locator("#go").waitFor();
  assert.equal(await page.locator(".cm-embed-needs").count(), 0);
  await page.goto(`${h.base}/?file=${encodeURIComponent("Three.js scene.md")}`);
  await page.waitForSelector('.cm-embed[data-embed="html-app"] iframe.webview');
  const scene = page.frameLocator('.cm-embed[data-embed="html-app"] iframe');
  await scene.locator("canvas").waitFor();
  // Drawn: the canvas has its size, and WebGL started without complaint.
  await page.waitForTimeout(800);
  assert.deepEqual(await scene.locator("canvas").evaluate((c: HTMLCanvasElement) => c.height > 300), true);
  assert.equal(await page.locator(".cm-embed-frame").evaluate((f) => getComputedStyle(f).borderStyle), "solid", "a quiet frame around running code");
  await page.locator(".cm-embed-stop").click();
  assert.equal(await page.locator('.cm-embed[data-embed="html-app"] iframe').count(), 0, "Stop removes it, and what ran in it");
  await page.locator(".cm-embed-stopped button", { hasText: "Run" }).click();
  await page.waitForSelector('.cm-embed[data-embed="html-app"] iframe.webview');
  assert.deepEqual(problems, []);
  await page.close();
});
