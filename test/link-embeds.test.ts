import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { cardFromHtml, linkCard } from "../worker/src/link-card.ts";
import { appCsp } from "../worker/src/sandbox.ts";
import { embedFrameHosts } from "../worker/src/embed-list.ts";
import { parseManifest } from "../worker/src/extensions.ts";
import type { FilePath } from "../worker/src/files.ts";
import { memoryStore } from "./store.ts";
import linkEmbeds from "../web/src/extensions/link-embeds/extension.json" with { type: "json" };

const { window } = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window, document: window.document, MutationObserver: window.MutationObserver, requestAnimationFrame: (f: () => void) => setTimeout(f, 0), getComputedStyle: window.getComputedStyle, Window: window.Window });

test("a link's card is what its page says about itself, its picture fetched too", async () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="The Garden &amp; the Shed">
    <meta name="description" content="Plain description">
    <meta property="og:description" content='Grow &quot;more&quot; with less'>
    <meta property="og:image" content="/img/shed.png"><meta property="og:site_name" content="Garden Weekly"></head><body>…</body></html>`;
  assert.deepEqual(cardFromHtml(html, "https://garden.example/posts/1"), {
    url: "https://garden.example/posts/1",
    title: "The Garden & the Shed",
    description: 'Grow "more" with less',
    site: "Garden Weekly",
    imageUrl: "https://garden.example/img/shed.png",
  });
  assert.equal(cardFromHtml("<title>Just a title</title>", "https://www.plain.example/").site, "plain.example", "a page that says little gets its host as its site");
  const png = new Uint8Array([137, 80, 78, 71]);
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/")) return Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] });
    if (url.endsWith("/img/shed.png")) return new Response(png, { headers: { "Content-Type": "image/png" } });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  const card = await linkCard("https://garden.example/posts/1", { fetcher });
  assert.equal(card.image, "data:image/png;base64,iVBORw==", "the picture arrives as a data: URL, so the page loads nothing from the site");
  await assert.rejects(linkCard("http://127.0.0.1/admin", { fetcher }), /Private and local addresses/);
});

test("a card's picture comes only from a host the caller allows, like its page", async () => {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(url);
    if (url === "https://blog.example/post") return new Response('<head><title>Post</title><meta property="og:image" content="https://tracker.example/pixel.png"></head>', { headers: { "content-type": "text/html" } });
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  }) as typeof fetch;
  const card = await linkCard("https://blog.example/post", { fetcher, resolve: async () => ["93.184.216.34"], allowHost: (h) => h === "blog.example" });
  assert.equal(card.image, null);
  assert.deepEqual(asked, ["https://blog.example/post"]);
});

test("a card from a page with a character reference past Unicode is still a card", () => {
  assert.equal(cardFromHtml("<title>Big &#99999999; numbers &#65;</title>", "https://odd.example/").title, "Big \uFFFD numbers A");
});

test("the page may frame only the hosts of link embeds that are on, and drawn in the page", async () => {
  assert.match(appCsp("https://app.example", ["www.youtube-nocookie.com", "evil.example; script-src *"]), /frame-src https:\/\/app\.example\/sandbox\/ https:\/\/www\.youtube-nocookie\.com;/);
  const s = memoryStore();
  const you = { kind: "user" as const, email: "you@example.com" };
  const write = (path: string, text: string) => s.files.write({ path: path as FilePath, text, base: s.files.read(path as FilePath)?.revision ?? 0, author: you });
  assert.deepEqual(await embedFrameHosts(s, you.email), ["embed.bsky.app", "open.spotify.com", "platform.twitter.com", "www.youtube-nocookie.com"]);
  write(".common-ink/extensions/films/extension.json", JSON.stringify({ name: "Films", contributes: { urlEmbeds: [{ id: "vimeo", title: "Vimeo", pattern: "^https://vimeo\\\\.com/", frameHosts: ["player.vimeo.com"] }] } }));
  assert.ok(!(await embedFrameHosts(s, you.email)).includes("player.vimeo.com"), "a sandboxed extension can't put a frame in the page, so its hosts aren't allowed");
  write(".common-ink/users/you@example.com/settings.json", JSON.stringify({ "extensions.trusted": ["films"], "extensions.disabled": ["link-embeds"] }));
  assert.deepEqual(await embedFrameHosts(s, you.email), ["player.vimeo.com"], "a trusted one's are; one turned off has none");
});

test("each link embed's pattern takes its own links; anything else is a card", () => {
  const m = parseManifest(linkEmbeds, "link-embeds", { builtIn: true });
  assert.notEqual(typeof m, "string");
  const which = (url: string) => (m as Exclude<typeof m, string>).contributes.urlEmbeds.find((e) => new RegExp(e.pattern).test(url))?.id;
  assert.equal(which("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
  assert.equal(which("https://youtu.be/dQw4w9WgXcQ?t=30"), "youtube");
  assert.equal(which("https://youtube.com/shorts/abcdefghijk"), "youtube");
  assert.equal(which("https://x.com/someone/status/1790000000000000000"), "x");
  assert.equal(which("https://twitter.com/someone/status/123"), "x");
  assert.equal(which("https://bsky.app/profile/someone.bsky.social/post/3kabc"), "bluesky");
  assert.equal(which("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"), "spotify");
  assert.equal(which("https://example.com/a/page"), "link-card");
});

test("a link alone on its line is an embed; one in a sentence, a list or code isn't", async () => {
  const { EditorView } = await import("@codemirror/view");
  const { createState, addMarkdownSyntax } = await import("../web/src/editor.ts");
  const { DEFAULTS } = await import("../worker/src/settings.ts");
  const { findUrlEmbeds } = await import("../web/src/embeds.ts");
  addMarkdownSyntax((await import("@lezer/markdown")).GFM);
  const doc = ["# Links", "", "https://youtu.be/dQw4w9WgXcQ", "", "See https://example.com here.", "", "- https://example.com/in-a-list", "", "<https://example.com/angle>", "", "```", "https://example.com/code", "```", ""].join("\n");
  const view = new EditorView({ state: createState(doc, { json: false, readOnly: false, settings: DEFAULTS, extensions: [], onUpdate: () => {}, onBlur: () => {} }) });
  assert.deepEqual(
    findUrlEmbeds(view.state, { urlEmbed: (url) => (url.includes("youtu") ? "youtube" : "link-card") }).map((e) => [e.url, e.id]),
    [
      ["https://youtu.be/dQw4w9WgXcQ", "youtube"],
      ["https://example.com/angle", "link-card"],
    ],
  );
  view.destroy();
});
