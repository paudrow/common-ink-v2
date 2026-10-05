// Link embeds in a real browser against the real Worker: a link alone on its line becomes its site's
// embed, and the page's policy lets it frame only the hosts of link embeds that are on.
import assert from "node:assert/strict";
import { test } from "node:test";
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
