// A real YouTube video, over the real network (not in CI: `npm run test:real`): it keeps playing, and
// its frame never loads again, through what people do in a note around it. Playing is the IFrame API's
// word (playerState 1, its time moving on), not a mark in the page.
import assert from "node:assert/strict";
import { browserTest, harness } from "../browser/harness.ts";
import type { App } from "../browser/pages.ts";

const h = harness();
const FRAME = '.cm-url-embed[data-url-embed="youtube"] iframe';
const NOTE = "# Video\n\nAbove the video, a paragraph to type in.\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\nBelow\n";

/** Watch the frame: its loads, writes to its src, its leaving the page; and the player's state and time. */
const WATCH = `(() => {
  const f = document.querySelector(${JSON.stringify(FRAME)});
  const w = (window.yt = { loads: 0, srcWrites: 0, detached: 0, state: null, time: 0, frame: f });
  const listen = () => f.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 1 }), "*");
  f.addEventListener("load", () => (w.loads++, setTimeout(listen, 300)));
  new MutationObserver((rs) => rs.forEach((r) => r.attributeName === "src" && w.srcWrites++)).observe(f, { attributes: true });
  new MutationObserver((rs) => rs.forEach((r) => r.removedNodes.forEach((n) => (n === f || n.contains?.(f)) && w.detached++))).observe(document.body, { childList: true, subtree: true });
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow) return;
    try {
      const d = JSON.parse(e.data);
      if (d.info?.playerState !== undefined) w.state = d.info.playerState;
      if (d.info?.currentTime !== undefined) w.time = d.info.currentTime;
    } catch {}
  });
  setTimeout(listen, 300);
})()`;

const command = (app: App, func: string) => app.page.evaluate(([sel, func]) => document.querySelector<HTMLIFrameElement>(sel)!.contentWindow!.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*"), [FRAME, func] as const);
const watched = (app: App) => app.page.evaluate(() => { const w = (window as unknown as { yt: { loads: number; srcWrites: number; detached: number; state: number | null; time: number; frame: Element } }).yt; return { ...w, frame: undefined, same: document.querySelector('.cm-url-embed[data-url-embed="youtube"] iframe') === w.frame }; });

/** It's playing: the same frame, never loaded again, and its time has moved on since a moment ago. */
async function stillPlaying(app: App, after: string) {
  const before = (await watched(app)).time;
  await app.page.waitForTimeout(2000);
  const now = await watched(app);
  assert.deepEqual({ loads: now.loads, srcWrites: now.srcWrites, detached: now.detached, same: now.same, state: now.state }, { loads: 0, srcWrites: 0, detached: 0, same: true, state: 1 }, `after ${after}`);
  assert.ok(now.time > before, `its time moves on after ${after}: ${before} → ${now.time}`);
}

browserTest(h, "a real YouTube video plays on through typing, a new tab, a split, and the cursor on its line", { internet: "live" }, async (app) => {
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  await app.page.locator(FRAME).first().waitFor();
  await app.page.waitForTimeout(3000);
  await app.page.evaluate(WATCH);
  await command(app, "mute");
  await command(app, "playVideo");
  await app.page.waitForFunction(() => (window as unknown as { yt: { state: number } }).yt.state === 1, null, { timeout: 15000 });
  await stillPlaying(app, "it started");

  await app.call("cursor", 3, 1);
  await app.keys("<Esc>A and more words<Esc>");
  await stillPlaying(app, "typing in a paragraph above it");
  await app.keys("jA x<Esc>");
  await stillPlaying(app, "typing on the line right above it, joining it to a paragraph");
  await app.keys("u");
  await stillPlaying(app, "undoing that");
  await app.keys("jj");
  await stillPlaying(app, "the cursor on its line");
  await app.keys("jj");
  await stillPlaying(app, "the cursor off its line");
  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.waitForTimeout(800);
  await app.page.locator(".tab", { hasText: "Video" }).first().click();
  await app.page.locator(".cm-url-embed:not(.is-floating)").waitFor();
  await stillPlaying(app, "⌘-click opening another note in a new tab (it floats meanwhile), and switching back");
  await app.command("Split right");
  await stillPlaying(app, "splitting the window");
  // A wheel over the video scrolls the note.
  const box = (await app.page.locator(FRAME).first().boundingBox())!;
  const top = await app.page.evaluate(() => document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.scrollTop);
  await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.page.mouse.wheel(0, 120);
  await app.page.waitForTimeout(500);
  assert.notEqual(await app.page.evaluate(() => document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!.scrollTop), top, "a wheel over the video scrolls the note");
  await stillPlaying(app, "scrolling with the wheel over it");
});
