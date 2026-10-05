// Link embeds in a real browser against the real Worker: a link alone on its line becomes its site's
// embed, and the page's policy lets it frame only the hosts of link embeds that are on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { harness, writeFile } from "./harness.ts";

const h = harness();

test("a YouTube link alone on its line plays from youtube-nocookie.com, which the page may frame only while Link embeds is on", async () => {
  const page = await h.browser.newPage({ viewport: { width: 1200, height: 900 } });
  const policy = async () => (await page.goto(`${h.base}/?file=${encodeURIComponent("Link embeds tour.md")}`))!.headers()["content-security-policy"];
  assert.match(await policy(), /frame-src [^;]*https:\/\/www\.youtube-nocookie\.com/);
  const video = await page.waitForSelector('.cm-url-embed[data-url-embed="youtube"] iframe');
  assert.equal(await video.getAttribute("src"), "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ");
  assert.match((await video.getAttribute("sandbox"))!, /allow-scripts/, "a frame of its own, that can't reach the app");
  await writeFile(page, ".common-ink/settings.json", JSON.stringify({ "extensions.disabled": ["link-embeds"] }));
  assert.doesNotMatch(await policy(), /youtube|twitter|bsky|spotify/);
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".cm-url-embed").count(), 0, "off, links are links");
  await writeFile(page, ".common-ink/settings.json", "{}");
  await page.close();
});

// Each site's embed page, stood in for: transparent, with no color-scheme (as X's, Bluesky's and
// Spotify's are), and a rounded card at its top, shorter than the frame.
const SITE = `<!doctype html><html><body style="margin:0"><div style="height:80px;border-radius:12px;background:#2a6;border:1px solid #6c9"></div></body></html>`;

/** The color of one pixel of the page, as [r, g, b]. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const png = (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString("base64");
  const blank = await page.context().newPage();
  const rgb = await blank.evaluate(
    `(async () => { const img = new Image(); img.src = "data:image/png;base64,${png}"; await img.decode(); const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)]; })()`,
  );
  await blank.close();
  return rgb as number[];
}

test("in dark mode, a site's embed shows the note behind it outside its card: no white canvas, no border or corners of ours", async () => {
  const context = await h.browser.newContext({ viewport: { width: 1200, height: 1600 }, colorScheme: "dark" });
  await context.route(/^https:\/\/(platform\.twitter\.com|embed\.bsky\.app|open\.spotify\.com|www\.youtube-nocookie\.com)\//, (route) => route.fulfill({ contentType: "text/html", body: SITE }));
  const page = await context.newPage();
  await page.goto(h.base);
  await page.waitForSelector(".cm-content");
  const links = ["https://x.com/jack/status/20", "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"];
  await writeFile(page, "Corners.md", `# Corners\n\n${links.join("\n\n")}\n\nEnd.\n`);
  await page.goto(`${h.base}/?file=Corners.md`);
  await page.click(".cm-line >> text=End.");
  await page.waitForFunction(() => document.querySelectorAll(".cm-url-embed iframe").length === 4);
  const looks = await page.evaluate(`[...document.querySelectorAll(".cm-url-embed")].map((w) => {
    const box = w.querySelector(".site-frame"), f = box.querySelector("iframe");
    const s = (e) => getComputedStyle(e);
    const r = box.getBoundingClientRect(), fr = f.getBoundingClientRect();
    return { id: w.dataset.urlEmbed, src: f.src, colorScheme: s(f).colorScheme, backgrounds: [w, box, f].map((e) => s(e).backgroundColor), borders: [w, box, f].map((e) => s(e).borderTopWidth), radius: s(box).borderTopLeftRadius, clips: s(box).overflow, fits: Math.abs(r.width - fr.width) < 1 && Math.abs(r.height - fr.height) < 1, rect: [fr.left, fr.top, fr.width, fr.height] };
  })`);
  const radius: Record<string, string> = { x: "12px", bluesky: "32px", spotify: "12px", youtube: "12px" };
  for (const l of looks as Array<{ id: string; src: string; colorScheme: string; backgrounds: string[]; borders: string[]; radius: string; clips: string; fits: boolean; rect: number[] }>) {
    assert.equal(l.colorScheme, "normal", `${l.id}: the frame's color-scheme is its page's, so Chrome paints no canvas behind it`);
    assert.deepEqual(l.backgrounds, ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"], `${l.id}: nothing of ours behind the frame`);
    assert.deepEqual(l.borders, ["0px", "0px", "0px"], `${l.id}: the site's card is the only edge`);
    assert.equal(l.radius, radius[l.id], `${l.id}: cut to the site's own corners`);
    assert.equal(l.clips, "hidden");
    assert.ok(l.fits, `${l.id}: the box is the frame's size, with no gap below or beside it`);
    if (l.id !== "youtube") assert.match(l.src, /theme=dark|colorMode=dark|theme=0/, `${l.id}: asked for in the app's dark theme`);
  }
  // Below the card, inside the frame, is the note's own background.
  const x = (looks as Array<{ id: string; rect: number[] }>).find((l) => l.id === "x")!.rect;
  const note = await pixel(page, x[0] + 20, x[1] - 4);
  const inFrame = await pixel(page, x[0] + 20, x[1] + 200);
  assert.ok(note.every((c) => c < 80), `the note is dark (${note})`);
  assert.deepEqual(inFrame, note, "the frame shows the note behind it, not a white canvas");
  // Light again: the posts load again, asked for in light.
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => /theme=light/.test(document.querySelector<HTMLIFrameElement>('.cm-url-embed[data-url-embed="x"] iframe')!.src));
  assert.match(await page.locator('.cm-url-embed[data-url-embed="bluesky"] iframe').getAttribute("src") ?? "", /colorMode=light/);
  await context.close();
});
