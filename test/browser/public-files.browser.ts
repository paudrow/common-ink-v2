// The site's icons, manifest and link-preview image are public, as production runs it (Google sign-in,
// no dev user): tabs, home screens and crawlers get them signed out. Nothing else opens up. With a dev
// user, as in Previews, the page links them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ensureBuilt, startWorker, type LocalWorker } from "./launch.ts";

const PUBLIC = [
  ["/favicon.ico", "image/x-icon"],
  ["/favicon.svg", "image/svg+xml"],
  ["/apple-touch-icon.png", "image/png"],
  ["/icon-192.png", "image/png"],
  ["/icon-512.png", "image/png"],
  ["/icon-maskable-512.png", "image/png"],
  ["/site.webmanifest", "application/manifest+json"],
  ["/social.png", "image/png"],
];

let signedOut: LocalWorker;
let dev: LocalWorker;

before(async () => {
  ensureBuilt();
  [signedOut, dev] = await Promise.all([startWorker({ GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", SESSION_SECRET: "test-session-secret-at-least-32-chars" }), startWorker()]);
});

after(async () => {
  await Promise.all([signedOut?.stop(), dev?.stop()]);
});

const get = (base: string, path: string, method = "GET") => fetch(`${base}${path}`, { method, redirect: "manual" });

test("signed out, each icon, the manifest and the link-preview image answer 200 with their type", async () => {
  for (const [path, type] of PUBLIC) {
    for (const method of ["GET", "HEAD"]) {
      const res = await get(signedOut.base, path, method);
      assert.equal(res.status, 200, `${method} ${path}`);
      assert.equal(res.headers.get("Content-Type"), type, `${method} ${path}`);
      assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400", `${method} ${path}`);
      assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", `${method} ${path}`);
    }
  }
});

test("the manifest is Common Ink's, and every icon it names is public", async () => {
  const manifest = (await (await get(signedOut.base, "/site.webmanifest")).json()) as { name: string; icons: Array<{ src: string; type: string }> };
  assert.equal(manifest.name, "Common Ink");
  for (const icon of manifest.icons) {
    const res = await get(signedOut.base, icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get("Content-Type"), icon.type, icon.src);
  }
});

test("signed out, the app, its API, notes, uploads and paths near the public ones still need sign-in", async () => {
  for (const path of ["/", "/?file=Welcome.md", "/Welcome.md", "/uploads/photo.png", "/favicon.ico/", "/favicon.svg.map", "/icons/favicon.ico", "/index.html", "/seed.json"]) {
    const res = await get(signedOut.base, path);
    assert.equal(res.status, 302, path);
    assert.match(res.headers.get("Location") ?? "", /\/auth\/google\?next=/, path);
  }
  for (const [method, path] of [["GET", "/api/files"], ["GET", "/api/me"], ["GET", "/mcp"], ["POST", "/favicon.ico"], ["PUT", "/social.png"]]) {
    assert.equal((await get(signedOut.base, path, method)).status, 401, `${method} ${path}`);
  }
});

test("with a dev user, as in Previews, the page links the icons and manifest, and the app and its API open as before", async () => {
  const html = await (await get(dev.base, "/")).text();
  assert.match(html, /<link rel="icon" href="\/favicon.svg" type="image\/svg\+xml" \/>/);
  assert.match(html, /<link rel="manifest" href="\/site.webmanifest" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/v2.commonink.app\/social.png" \/>/);
  const me = (await (await get(dev.base, "/api/me")).json()) as { email?: string };
  assert.equal(me.email, "tester@localhost");
  const icon = await get(dev.base, "/favicon.svg");
  assert.equal(icon.headers.get("Content-Type"), "image/svg+xml");
  assert.match(await icon.text(), /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#5b5bd6"\/>/);
});
