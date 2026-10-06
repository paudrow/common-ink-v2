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
  assert.equal(await statusItem(page, "media.playing"), "♪ Brown noise · Embeds tour", "what plays, and the note it's from");
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

test("an embed's Settings write its line for you, and its frame isn't reloaded by that or by edits elsewhere", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${h.base}/?file=${encodeURIComponent("Embeds tour.md")}`);
  await page.waitForSelector(".timer-embed");
  const doc = () => page.evaluate(() => fetch(`/api/file?path=${encodeURIComponent("Embeds tour.md")}`).then((r) => r.json()).then((f) => f.text as string));

  // The timer's Settings: a preset, then Save.
  const timer = page.locator('.cm-embed[data-embed="timer"]').first();
  await timer.hover();
  await timer.locator(".cm-embed-tools button", { hasText: "Settings" }).click();
  const form = timer.locator(".cm-embed-form");
  await form.locator(".presets").getByRole("button", { name: "5m", exact: true }).click();
  assert.equal(await form.locator(".actions code").textContent(), '::timer{duration=5m label="Focus"}');
  await form.locator("button[type=submit]").click();
  // It takes the new duration in place, keeping the time it's at (it may be running from the test above).
  await page.waitForFunction(() => /^[0-5]:\d\d$/.test(document.querySelector('.cm-embed[data-embed="timer"] .timer-time')?.textContent ?? ""));
  await page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  assert.match(await doc(), /^::timer\{duration=5m label="Focus"\}$/m, "the line it wrote, saved");

  // The chart's frame: marked, then edited around and given a new height. It's the same frame, never reloaded.
  await page.evaluate(() => {
    const s = document.querySelector(".cm-scroller")!;
    s.scrollTop = s.scrollHeight;
  });
  const chart = await page.waitForSelector('.cm-embed[data-embed="html-app"] iframe.webview');
  await page.frameLocator('.cm-embed[data-embed="html-app"] iframe').locator(".uplot canvas").waitFor();
  await (await chart.contentFrame())!.evaluate(() => ((window as unknown as { mark: number }).mark = 1));
  await page.evaluate(() => ((window as unknown as { chart: Element }).chart = document.querySelector('.cm-embed[data-embed="html-app"] iframe')!));
  const same = () => page.evaluate(() => document.querySelector('.cm-embed[data-embed="html-app"] iframe') === (window as unknown as { chart: Element }).chart);
  const unreloaded = async () => (await (await page.$('.cm-embed[data-embed="html-app"] iframe'))!.contentFrame())!.evaluate(() => (window as unknown as { mark?: number }).mark === 1);
  await page.locator(".cm-line", { hasText: "See also" }).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" And more.");
  await page.waitForTimeout(300);
  assert.equal(await same(), true, "an edit elsewhere keeps the frame");
  assert.equal(await unreloaded(), true);
  const app = page.locator('.cm-embed[data-embed="html-app"]');
  await app.hover();
  await app.locator(".cm-embed-tools button", { hasText: "Settings" }).click();
  await app.locator(".cm-embed-form .presets").getByRole("button", { name: "360", exact: true }).click();
  await app.locator(".cm-embed-form button[type=submit]").click();
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.cm-embed[data-embed="html-app"] .cm-embed-frame > div')?.style.height === "360px");
  assert.equal(await same(), true, "new arguments keep the frame");
  assert.equal(await unreloaded(), true, "and it isn't reloaded");
  await page.waitForFunction(() => document.querySelector("#save")?.textContent === "Saved");
  assert.match(await doc(), /^```html-app height=360 title="Words this week"$/m, "its fence says the new height");
  assert.deepEqual(errors, []);
  await page.close();
});
