// A real YouTube video floats while its note is out of sight, and docks when it's back, playing all the
// while in the same frame (not in CI: `npm run test:real`). Playing is the IFrame API's word: its state
// and its time moving on, as the app hears it too.
import assert from "node:assert/strict";
import { browserTest, harness } from "../browser/harness.ts";
import type { App } from "../browser/pages.ts";

const h = harness();
const FRAME = '.cm-url-embed[data-url-embed="youtube"] iframe';
const BOX = '.cm-url-embed[data-url-embed="youtube"]';
const NOTE = `# Video\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1} below the video.`).join("\n\n")}\n`;

/** Watch the frame: its loads, writes to its src, its leaving the page; and the player's state and time. */
const WATCH = `(() => {
  const f = document.querySelector(${JSON.stringify(FRAME)});
  const w = (window.yt = { loads: 0, srcWrites: 0, detached: 0, state: null, time: 0, frame: f });
  f.addEventListener("load", () => w.loads++);
  new MutationObserver((rs) => rs.forEach((r) => r.attributeName === "src" && w.srcWrites++)).observe(f, { attributes: true });
  new MutationObserver((rs) => rs.forEach((r) => r.removedNodes.forEach((n) => (n === f || n.contains?.(f)) && w.detached++))).observe(document.body, { childList: true, subtree: true });
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow) return;
    try {
      const d = JSON.parse(e.data);
      if (d.event === "onStateChange") w.state = d.info;
      if (d.info?.playerState !== undefined) w.state = d.info.playerState;
      if (d.info?.currentTime !== undefined) w.time = d.info.currentTime;
    } catch {}
  });
})()`;

const command = (app: App, func: string) => app.page.evaluate(([sel, func]) => document.querySelector<HTMLIFrameElement>(sel)!.contentWindow!.postMessage(JSON.stringify({ event: "command", func, args: [] }), "*"), [FRAME, func] as const);
const watched = (app: App) =>
  app.page.evaluate(([frame, box]) => {
    const w = (window as unknown as { yt: { loads: number; srcWrites: number; detached: number; state: number | null; time: number; frame: Element } }).yt;
    return { ...w, frame: undefined, same: document.querySelector(frame) === w.frame, floating: !!document.querySelector(`${box}.is-floating`) };
  }, [FRAME, BOX] as const);

/** It's playing, floating or not as said: the same frame, never loaded again, and its time moving on. */
async function playing(app: App, floating: boolean, after: string) {
  await app.page.waitForFunction(([box, floating]) => !!document.querySelector(`${box}.is-floating`) === floating, [BOX, floating] as const, { timeout: 5000 }).catch(() => {});
  const before = (await watched(app)).time;
  await app.page.waitForTimeout(2000);
  const now = await watched(app);
  assert.deepEqual(
    { loads: now.loads, srcWrites: now.srcWrites, detached: now.detached, same: now.same, state: now.state, floating: now.floating },
    { loads: 0, srcWrites: 0, detached: 0, same: true, state: 1, floating },
    `after ${after}`,
  );
  assert.ok(now.time > before, `its time moves on after ${after}: ${before} → ${now.time}`);
}

browserTest(h, "a real YouTube video floats while its note is out of sight, docks when it's back, and keeps playing in the same frame", { internet: "live" }, async (app) => {
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  await app.page.locator(FRAME).first().waitFor();
  await app.page.waitForTimeout(3000);
  await app.page.evaluate(WATCH);
  await command(app, "mute");
  await command(app, "playVideo");
  await app.page.waitForFunction(() => (window as unknown as { yt: { state: number } }).yt.state === 1, null, { timeout: 15000 });
  // The app hears it play: the mini player names it, with its note.
  await app.page.waitForSelector(".mini-player:not([hidden])");
  assert.match((await app.page.locator(".mini-player").textContent()) ?? "", /Video/);
  await playing(app, false, "it started");

  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  await playing(app, true, "another note opened in a new tab: it floats");
  await app.page.locator(`${BOX} .media-float-bar button[aria-label='Back to note']`).click();
  await playing(app, false, "Back to note: it docks");

  await app.keys("G");
  await playing(app, true, "scrolled far down: it floats");
  await app.keys("gg");
  await playing(app, false, "scrolled back: it docks");

  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.locator(".tab", { hasText: "Video" }).first().click();
  await app.command("Close tab");
  await playing(app, true, "its tab closed: it floats on");
  await app.page.locator(`${BOX} .media-float-bar button[aria-label='Back to note']`).click();
  await playing(app, false, "Back to note, opened again: it docks, in the same frame");

  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.waitForSelector(`${BOX}.is-floating`);
  await app.page.locator(`${BOX} .media-float-bar button[aria-label='Stop and close']`).click();
  await app.page.waitForFunction(() => (window as unknown as { yt: { state: number } }).yt.state === 2, null, { timeout: 5000 });
  assert.equal((await watched(app)).floating, false, "Stop and close: it pauses, and its window goes");
});

browserTest(h, "a real Spotify track plays on unseen when its tab is hidden, and the mini player pauses it and goes back to its note", { internet: "live" }, async (app) => {
  const TRACK = '.cm-url-embed[data-url-embed="spotify"] iframe';
  await app.writeFile("Track.md", "# Track\n\nhttps://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC\n");
  await app.goto({}, "Track");
  await app.page.locator(TRACK).waitFor();
  await app.page.evaluate((sel) => {
    const f = document.querySelector<HTMLIFrameElement>(sel)!;
    const w: { paused: boolean | null; position: number; frame: Element } = { paused: null, position: 0, frame: f };
    (window as unknown as { sp: typeof w }).sp = w;
    addEventListener("message", (e) => {
      const d = e.source === f.contentWindow && (e.data as { type?: string; payload?: { isPaused: boolean; position: number } });
      if (d && d.type === "playback_update") [w.paused, w.position] = [d.payload!.isPaused, d.payload!.position];
    });
  }, TRACK);
  const heard = () => app.page.evaluate(() => (window as unknown as { sp: { paused: boolean | null; position: number } }).sp);
  // Its play button, as a person would press it.
  await app.page.frameLocator(TRACK).locator('button[data-testid="play-pause-button"], button[aria-label*="Play"]').first().click({ timeout: 15000 });
  await app.page.waitForFunction(() => (window as unknown as { sp: { paused: boolean | null } }).sp.paused === false, null, { timeout: 15000 });
  await app.page.waitForSelector(".mini-player:not([hidden])");

  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  const before = (await heard()).position;
  await app.page.waitForTimeout(2000);
  const now = await heard();
  assert.equal(now.paused, false, "its tab hidden: it plays on");
  assert.ok(now.position > before, `its position moves on: ${before} → ${now.position}`);
  assert.equal(await app.page.locator('.cm-url-embed[data-url-embed="spotify"].is-floating').count(), 0, "a track doesn't float");
  assert.match((await app.page.locator(".mini-player").textContent()) ?? "", /Spotify track.*Track/, "the mini player names it, and its note");

  await app.page.locator(".mini-player button[aria-label='Pause']").click();
  await app.page.waitForFunction(() => (window as unknown as { sp: { paused: boolean | null } }).sp.paused === true, null, { timeout: 5000 });
  await app.page.locator(".mini-player button[aria-label='Play']").click();
  await app.page.waitForFunction(() => (window as unknown as { sp: { paused: boolean | null } }).sp.paused === false, null, { timeout: 5000 });
  await app.page.locator(".mini-player .note").click();
  await app.page.waitForFunction(() => document.title.startsWith("Track"));
  assert.equal(await app.page.evaluate((sel) => document.querySelector(sel) === (window as unknown as { sp: { frame: Element } }).sp.frame, TRACK), true, "the same frame throughout");
});

browserTest(h, 'with "media.whenHidden": "pause", a real YouTube video pauses when its tab is hidden, and doesn\'t float', { internet: "live" }, async (app) => {
  await app.writeFile(".common-ink/settings.json", JSON.stringify({ "media.whenHidden": "pause" }));
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  await app.page.locator(FRAME).first().waitFor();
  await app.page.waitForTimeout(3000);
  await app.page.evaluate(WATCH);
  await command(app, "mute");
  await command(app, "playVideo");
  await app.page.waitForFunction(() => (window as unknown as { yt: { state: number } }).yt.state === 1, null, { timeout: 15000 });
  await app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
  await app.page.waitForFunction(() => (window as unknown as { yt: { state: number } }).yt.state === 2, null, { timeout: 5000 });
  assert.equal((await watched(app)).floating, false);
});
