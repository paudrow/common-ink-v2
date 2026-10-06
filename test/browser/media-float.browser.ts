// A playing video floats while its note is out of sight, and docks when it's back, in the same frame
// throughout: never loaded again, its src never written, never moved in the page. A track plays on unseen,
// in the mini player. With fake players that speak YouTube's and Spotify's messages; the real sites are
// checked by `npm run test:real` (test/real/media-float.real.ts).
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

const NOTE = `# Video\n\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1} below the video.`).join("\n\n")}\n`;
const BOX = '.cm-url-embed[data-url-embed="youtube"]';
const FRAME = `${BOX} iframe`;

/** YouTube's player, as far as the app talks to it: greeted, it says its state and title; it takes play and pause. */
const FAKE_YOUTUBE = `<!doctype html><body style="margin:0;background:#202020">
<button id="play" style="position:absolute;inset:0;width:100%;height:100%;font:20px sans-serif">Play</button>
<script>
  const player = (window.player = { state: -1, time: 0, commands: [] });
  let timer = 0;
  const say = (o) => parent.postMessage(JSON.stringify(o), "*");
  function set(s) {
    player.state = s;
    clearInterval(timer);
    if (s === 1) timer = setInterval(() => say({ event: "infoDelivery", info: { currentTime: (player.time += 0.25) } }), 250);
    say({ event: "onStateChange", info: s });
    document.getElementById("play").textContent = s === 1 ? "Pause" : "Play";
  }
  addEventListener("message", (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.event === "listening") say({ event: "initialDelivery", info: { playerState: player.state, videoData: { title: "Fake video" } } });
    if (d.event === "command") {
      player.commands.push(d.func);
      if (d.func === "playVideo") set(1);
      if (d.func === "pauseVideo") set(2);
    }
  });
  document.getElementById("play").onclick = () => set(player.state === 1 ? 2 : 1);
</script>`;

/** Spotify's player: it says how playback goes (playback_update), and takes pause and resume. */
const FAKE_SPOTIFY = `<!doctype html><body style="margin:0;background:#1db954">
<button id="play" style="position:absolute;inset:0;width:100%;height:100%">Play</button>
<script>
  const player = (window.player = { paused: true, commands: [] });
  const say = (o) => parent.postMessage(o, "*");
  const set = (paused) => { player.paused = paused; say({ type: "playback_update", payload: { isPaused: paused, isBuffering: false, duration: 30000, position: 0 } }); };
  say({ type: "ready" });
  addEventListener("message", (e) => {
    if (!e.data || !e.data.command) return;
    player.commands.push(e.data.command);
    if (e.data.command === "pause") set(true);
    if (e.data.command === "resume") set(false);
  });
  document.getElementById("play").onclick = () => set(!player.paused);
</script>`;

const SITES = { "www.youtube-nocookie.com": FAKE_YOUTUBE, "open.spotify.com": FAKE_SPOTIFY };

/** Watch the video's iframe: its load events after now, writes to its src, and its leaving the page or moving in it. */
const WATCH = `(() => {
  const f = document.querySelector(${JSON.stringify(FRAME)});
  const w = (window.watched = { loads: 0, srcWrites: 0, moves: 0, frame: f });
  f.addEventListener("load", () => w.loads++);
  new MutationObserver((rs) => rs.forEach((r) => r.attributeName === "src" && w.srcWrites++)).observe(f, { attributes: true });
  new MutationObserver((rs) => rs.forEach((r) => [...r.removedNodes, ...r.addedNodes].forEach((n) => (n === f || n.contains?.(f)) && w.moves++))).observe(document.documentElement, { childList: true, subtree: true });
})()`;
const watched = (app: App) =>
  app.page.evaluate((sel) => {
    const w = (window as unknown as { watched: { loads: number; srcWrites: number; moves: number; frame: Element } }).watched;
    return { loads: w.loads, srcWrites: w.srcWrites, moves: w.moves, same: document.querySelector(sel) === w.frame };
  }, FRAME);
const untouched = { loads: 0, srcWrites: 0, moves: 0, same: true };

/** What the fake player inside the frame says it's doing. */
async function player<T>(app: App, frame: string): Promise<T> {
  const f = await (await app.page.$(frame))!.contentFrame();
  return f!.evaluate(() => (window as unknown as { player: T }).player);
}
const video = (app: App) => player<{ state: number; time: number; commands: string[] }>(app, FRAME);

/** Wait until `yes` says so, asking every 100ms for 10s. */
async function waitFor(yes: () => Promise<boolean>, what: string) {
  for (let t = 0; t < 100; t++) {
    if (await yes()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`waited for: ${what}`);
}

/**
 * Press a fake player's Play, as a person would, once the page in its frame has started its player.
 * Chrome can drop the first click into a frame from another site just after it's drawn: press again.
 */
async function press(app: App, frame: string, playing: string) {
  await app.page.locator(frame).first().waitFor();
  const f = (await (await app.page.$(frame))!.contentFrame())!;
  await f.waitForFunction(() => "player" in window);
  for (let tries = 0; ; tries++) {
    await app.page.frameLocator(frame).first().locator("#play").click();
    const on = await f.waitForFunction(playing, null, { timeout: 3000 }).then(() => true, () => false);
    if (on) return;
    if (tries === 3) assert.fail(`${frame}: its player never started`);
  }
}
const VIDEO_PLAYS = "window.player.state === 1";
const TRACK_PLAYS = "window.player.paused === false";

/** Open the video's note, and press its player's Play, as a person would. */
async function playVideo(app: App) {
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  await app.page.locator(FRAME).waitFor();
  // Watched from once the page in its frame has loaded.
  await (await (await app.page.$(FRAME))!.contentFrame())!.waitForFunction(() => "player" in window);
  await app.page.evaluate(WATCH);
  await press(app, FRAME, VIDEO_PLAYS);
  // The app hears it: the mini player names it, by the title the player gave, and its note.
  await app.page.waitForFunction(() => /Fake video/.test(document.querySelector(".mini-player:not([hidden])")?.textContent ?? ""));
}

/** Scroll the note on show, as a wheel or its scrollbar would, once the editor has done its own scrolling. */
async function scrollTo(app: App, where: "top" | "bottom") {
  await app.idle();
  await app.page.evaluate(async (where) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scroller = document.querySelector(".tab-editor:not([hidden]) .cm-scroller")!;
    scroller.scrollTop = where === "top" ? 0 : scroller.scrollHeight;
  }, where);
}
const floating = (app: App, yes: boolean) => app.page.waitForSelector(yes ? `${BOX}.is-floating` : `${BOX}:not(.is-floating)`, { state: "attached" });
const openWelcomeInNewTab = (app: App) => app.page.locator("#notes a", { hasText: "Welcome" }).click({ modifiers: ["ControlOrMeta"] });
const floatButton = (app: App, name: string) => app.page.locator(`${BOX} .media-float-bar button[aria-label='${name}']`);

/** Where the box is on the page, and whether it shows. */
const where = (app: App) =>
  app.page.evaluate((sel) => {
    const box = document.querySelector<HTMLElement>(sel)!;
    const r = box.getBoundingClientRect();
    return { left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom, width: r.width, height: r.height, shown: getComputedStyle(box).visibility === "visible", bar: box.querySelector(".media-float-bar")?.textContent ?? "" };
  }, BOX);

browserTest(h, "a playing video floats in a small window while its tab is hidden or it's scrolled away, and docks when it's back, never reloading", { sites: SITES }, async (app) => {
  await playVideo(app);
  assert.match((await app.page.locator(".mini-player").textContent()) ?? "", /Fake video.*Video/);

  await openWelcomeInNewTab(app);
  await floating(app, true);
  const float = await where(app);
  assert.ok(float.shown, "the floating window shows over the other note");
  assert.ok(Math.abs(float.width - 320) <= 3, `about 320px wide: ${float.width}`);
  assert.ok(float.right >= 0 && float.right < 40 && float.bottom >= 0 && float.bottom < 160, `in the bottom right corner: ${JSON.stringify(float)}`);
  assert.match(float.bar, /Fake video/);
  assert.match(float.bar, /Video/);
  assert.equal((await video(app)).state, 1, "it plays on, floating");

  await floatButton(app, "Back to note").click();
  await floating(app, false);
  await app.page.waitForFunction(() => document.title.startsWith("Video"));
  const docked = await app.page.evaluate((sel) => {
    const slot = document.querySelector(".tab-editor:not([hidden]) .cm-embed-slot")!.getBoundingClientRect();
    const box = document.querySelector(sel)!.getBoundingClientRect();
    return Math.abs(slot.top - box.top) + Math.abs(slot.left - box.left);
  }, BOX);
  assert.ok(docked < 2, `docked back over its slot (off by ${docked}px)`);

  await scrollTo(app, "bottom");
  await floating(app, true);
  assert.equal((await video(app)).state, 1, "scrolled far away, it floats and plays on");
  await scrollTo(app, "top");
  await floating(app, false);

  assert.equal((await video(app)).state, 1);
  assert.deepEqual(await watched(app), untouched, "the same frame throughout, never loaded again or moved");
});

browserTest(h, "a playing video whose tab closes floats on, and docks in the same frame when Back to note opens it again", { sites: SITES }, async (app) => {
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await app.page.locator(".tab", { hasText: "Video" }).first().click();
  await floating(app, false);
  await app.command("Close tab");
  await floating(app, true);
  assert.equal((await video(app)).state, 1, "its tab closed, it plays on, floating");
  await floatButton(app, "Back to note").click();
  await app.page.waitForFunction(() => document.title.startsWith("Video"));
  await floating(app, false);
  assert.equal((await video(app)).state, 1);
  assert.deepEqual(await watched(app), untouched, "the same frame, never loaded again or moved");
});

browserTest(h, "Stop and close pauses the video and closes its window; it waits in its note, and the mini player can play it again", { sites: SITES }, async (app) => {
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await floating(app, true);
  await floatButton(app, "Stop and close").click();
  await floating(app, false);
  const v = await video(app);
  assert.equal(v.state, 2);
  assert.ok(v.commands.includes("pauseVideo"));
  assert.equal((await where(app)).shown, false, "its window is gone");
  // Played from the mini player, out of sight: it floats again.
  await app.page.locator(".mini-player button[aria-label='Play']").click();
  await floating(app, true);
  assert.equal((await video(app)).state, 1);
  await app.page.locator(".tab", { hasText: "Video" }).first().click();
  await floating(app, false);
  assert.deepEqual(await watched(app), untouched);
});

browserTest(h, "a floating window is dragged by its bar, and the next one floats where it was left", { sites: SITES }, async (app) => {
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await floating(app, true);
  const before = await where(app);
  const bar = (await app.page.locator(`${BOX} .media-float-bar .label`).boundingBox())!;
  const from = { x: bar.x + 20, y: bar.y + bar.height / 2 };
  await app.page.mouse.move(from.x, from.y);
  await app.page.mouse.down();
  await app.page.mouse.move(from.x - 200, from.y - 90, { steps: 5 });
  await app.page.mouse.up();
  const after = await where(app);
  assert.ok(Math.abs(after.right - before.right - 200) < 3 && Math.abs(after.bottom - before.bottom - 90) < 3, `moved by the drag: ${JSON.stringify({ before, after })}`);
  assert.equal((await video(app)).state, 1, "dragging doesn't stop it");
  await floatButton(app, "Back to note").click();
  await floating(app, false);
  await openWelcomeInNewTab(app);
  await floating(app, true);
  const again = await where(app);
  assert.ok(Math.abs(again.right - after.right) < 3 && Math.abs(again.bottom - after.bottom) < 3, "floats again where it was left");
  assert.deepEqual(await watched(app), untouched);
});

browserTest(h, "a playing track doesn't float: it plays on unseen, in the mini player, which pauses it and goes back to its note", { sites: SITES }, async (app) => {
  const TRACK = '.cm-url-embed[data-url-embed="spotify"] iframe';
  await app.writeFile("Track.md", "# Track\n\nhttps://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC\n");
  await app.goto({}, "Track");
  await press(app, TRACK, TRACK_PLAYS);
  await app.page.waitForFunction(() => /Spotify track/.test(document.querySelector(".mini-player:not([hidden])")?.textContent ?? ""));
  await openWelcomeInNewTab(app);
  await app.page.waitForTimeout(300);
  assert.equal(await app.page.locator(".is-floating").count(), 0, "a track doesn't float");
  assert.equal((await player<{ paused: boolean }>(app, TRACK)).paused, false, "it plays on, unseen");
  assert.match((await app.page.locator(".mini-player").textContent()) ?? "", /Spotify track.*Track/);
  await app.page.locator(".mini-player button[aria-label='Pause']").click();
  await app.page.waitForSelector(".mini-player button[aria-label='Play']");
  assert.deepEqual((await player<{ commands: string[] }>(app, TRACK)).commands, ["pause"]);
  await app.page.locator(".mini-player .note").click();
  await app.page.waitForFunction(() => document.title.startsWith("Track"));
});

browserTest(h, 'with "media.whenHidden": "keepPlaying", a video plays on unseen; with "pause", it pauses', { sites: SITES }, async (app) => {
  await app.writeFile(".common-ink/settings.json", JSON.stringify({ "media.whenHidden": "keepPlaying" }));
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await app.page.waitForTimeout(500);
  assert.equal(await app.page.locator(`${BOX}.is-floating`).count(), 0, "keepPlaying: it doesn't float");
  assert.equal((await video(app)).state, 1, "keepPlaying: it plays on, unseen");
  assert.equal(await app.page.locator(".mini-player:not([hidden])").count(), 1, "in the mini player");

  await app.writeFile(".common-ink/settings.json", JSON.stringify({ "media.whenHidden": "pause" }));
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await waitFor(async () => (await video(app)).state === 2, "pause: it pauses");
  assert.equal(await app.page.locator(`${BOX}.is-floating`).count(), 0, "pause: it doesn't float");
  await app.writeFile(".common-ink/settings.json", "{}\n");
});

/** Where each floating window is, and whether all of it is on the page. */
const floats = (app: App) =>
  app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".cm-embed.is-floating")].map((box) => {
      const r = box.getBoundingClientRect();
      return { top: Math.round(r.top) + 0, left: Math.round(r.left) + 0, onPage: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.01 && r.right <= innerWidth + 0.01 };
    }),
  );

browserTest(h, "a floating window stays on the page: dragged to a corner and the page made smaller, a spot kept from a bigger page, and windows stacked", { sites: SITES, viewport: { width: 1400, height: 900 } }, async (app) => {
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await floating(app, true);
  // Dragged to the top left, then the page made smaller: it stays on it, all of it.
  const bar = (await app.page.locator(`${BOX} .media-float-bar .label`).boundingBox())!;
  await app.page.mouse.move(bar.x + 10, bar.y + 10);
  await app.page.mouse.down();
  await app.page.mouse.move(5, 5, { steps: 8 });
  await app.page.mouse.up();
  assert.deepEqual(await floats(app), [{ top: 0, left: 0, onPage: true }], "dragged to the top left corner");
  await app.page.setViewportSize({ width: 900, height: 600 });
  await waitFor(async () => (await floats(app)).every((f) => f.onPage), "on the smaller page");
  assert.deepEqual(await floats(app), [{ top: 0, left: 0, onPage: true }], "the smaller page: still in its corner");
  // Grown again, it's where it was put.
  await app.page.setViewportSize({ width: 1400, height: 900 });
  await waitFor(async () => (await floats(app))[0]?.top === 0 && (await floats(app))[0]?.left === 0, "where it was put");

  // A spot kept from a bigger page, on a small one: on the page.
  await app.page.evaluate(() => localStorage.setItem("common-ink.media-float", JSON.stringify({ right: 1080, bottom: 677.53 })));
  await app.page.setViewportSize({ width: 800, height: 500 });
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await floating(app, true);
  await waitFor(async () => (await floats(app)).every((f) => f.onPage), "a spot kept from a bigger page");
  assert.equal((await floats(app)).length, 1);
});

browserTest(h, "three windows floating at once are all on the page, their bars in reach", { sites: SITES, viewport: { width: 1200, height: 700 } }, async (app) => {
  const ids = ["aqz-KE-bpKQ", "YE7VzlLtp-4", "eRsGyueVLvQ"];
  await app.writeFile("Three.md", `# Three\n\n${ids.map((id) => `https://www.youtube.com/watch?v=${id}`).join("\n\n")}\n`);
  await app.goto({}, "Three");
  for (let i = 0; i < 3; i++) await press(app, `${BOX} >> nth=${i} >> iframe`, VIDEO_PLAYS);
  await waitFor(async () => (await app.page.locator(".mini-player:not([hidden])").count()) === 1, "the mini player");
  await openWelcomeInNewTab(app);
  await waitFor(async () => (await floats(app)).length === 3, "three floating");
  const all = await floats(app);
  assert.ok(all.every((f) => f.onPage), `all on the page: ${JSON.stringify(all)}`);
  // Every bar's buttons are what a pointer at them reaches: no window sits over another's bar.
  const covered = await app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".cm-embed.is-floating .media-float-bar button")].filter((b) => {
      const r = b.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) !== b;
    }).length,
  );
  assert.equal(covered, 0, "every ↩ and ✕ in reach");
});

browserTest(h, "a floating window moves with the arrow keys from its bar, and Home, a double-click or Reset floating video position put it back", { sites: SITES }, async (app) => {
  await playVideo(app);
  await openWelcomeInNewTab(app);
  await floating(app, true);
  const home = (await floats(app))[0];
  await app.page.locator(`${BOX} .media-float-bar`).focus();
  await app.page.keyboard.press("ArrowLeft");
  await app.page.keyboard.press("ArrowUp");
  await app.page.keyboard.press("Shift+ArrowUp");
  const moved = (await floats(app))[0];
  assert.deepEqual([home.left - moved.left, home.top - moved.top], [16, 80], "16px a key, 64 with Shift");
  // Moved by keys, it says when it reaches an edge or a corner.
  for (let i = 0; i < 40; i++) await app.page.keyboard.press("Shift+ArrowUp");
  assert.equal(await app.page.locator(".media-float-said").textContent(), "At the top edge");
  for (let i = 0; i < 40; i++) await app.page.keyboard.press("Shift+ArrowLeft");
  assert.equal(await app.page.locator(".media-float-said").textContent(), "In the top left corner");
  assert.equal((await video(app)).state, 1, "moving it doesn't stop it");
  await app.page.keyboard.press("Home");
  assert.deepEqual((await floats(app))[0], home, "Home: back in the corner");
  await app.page.keyboard.press("ArrowLeft");
  await app.page.locator(`${BOX} .media-float-bar .label`).dblclick();
  assert.deepEqual((await floats(app))[0], home, "a double-click: back in the corner");
  await app.page.keyboard.press("ArrowLeft");
  await app.command("Reset floating video position");
  await waitFor(async () => JSON.stringify((await floats(app))[0]) === JSON.stringify(home), "Reset floating video position");
  assert.equal(await app.page.evaluate(() => localStorage.getItem("common-ink.media-float")), null, "and the spot is forgotten");
  assert.deepEqual(await watched(app), untouched);
});

/** A page on another site the app may frame, posting what a player would: playing, with a title. */
const IMPOSTOR = `<!doctype html><script>
  window.posted = 0;
  const send = () => {
    window.posted++;
    parent.postMessage(JSON.stringify({ event: "onStateChange", info: 1 }), "*");
    parent.postMessage(JSON.stringify({ event: "infoDelivery", info: { playerState: 1, videoData: { title: "Impostor" } } }), "*");
    parent.postMessage({ type: "playback_update", payload: { isPaused: false } }, "*");
  };
  send();
  setInterval(send, 100);
</script>`;

browserTest(h, "a player is heard only from its own site: its frame sent to another site the app frames can't say it plays", { sites: { ...SITES, "platform.twitter.com": IMPOSTOR } }, async (app) => {
  await app.writeFile("Video.md", NOTE);
  await app.goto({}, "Video");
  const f = (await (await app.page.$(FRAME))!.contentFrame())!;
  await f.waitForFunction(() => "player" in window);
  // The frame goes to a page on X's site (one the page's policy lets it frame), in the same frame.
  await f.evaluate(() => (location.href = "https://platform.twitter.com/impostor")).catch(() => {});
  const impostor = async () => (await (await app.page.$(FRAME))!.contentFrame())?.evaluate(() => (window as unknown as { posted?: number }).posted ?? 0).catch(() => 0);
  await waitFor(async () => ((await impostor()) ?? 0) > 5, "the impostor has said it plays, again and again");
  assert.equal(await app.page.locator(".mini-player:not([hidden])").count(), 0, "nothing plays, as far as the app knows");
  assert.equal(await app.page.evaluate(() => document.body.innerText.includes("Impostor")), false, "its title shows nowhere");
});

browserTest(h, "a file dropped in an extension's frame doesn't leave every embed ignoring clicks", { scenario: "empty" }, async (app) => {
  // A file dragged in over the page lets drags through the embeds; its drop, in a frame, never reaches the page.
  await app.page.evaluate(() => {
    const files = new DataTransfer();
    files.items.add(new File(["x"], "a.txt"));
    document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: files, bubbles: true }));
  });
  assert.equal(await app.page.evaluate(() => document.querySelector(".embed-layer")?.classList.contains("is-passing")), true, "drags pass through while one is on");
  await app.page.mouse.move(300, 300);
  await app.page.mouse.move(310, 310);
  assert.equal(await app.page.evaluate(() => document.querySelector(".embed-layer")?.classList.contains("is-passing")), false, "the pointer moving again means the drag is over");
});
