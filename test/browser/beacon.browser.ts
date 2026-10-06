// A save sent with navigator.sendBeacon as a page goes away (POST /api/file/beacon): it saves as a
// PUT does, merging a stale base and never overwriting, the same save twice writes once, and only a
// request that proves it's from this site gets in, since a beacon is a simple request with no preflight.
import assert from "node:assert/strict";
import { browserTest, harness } from "./harness.ts";
import type { App } from "./pages.ts";

const h = harness();

async function file(app: App, path: string): Promise<{ text: string; revision: number } | null> {
  const res = await app.page.context().request.get(`${app.base}/api/file?path=${encodeURIComponent(path)}`);
  return res.ok() ? res.json() : null;
}

/** Changes to a file, newest first. */
async function changes(app: App, path: string): Promise<number> {
  const res = await app.page.context().request.get(`${app.base}/api/history?path=${encodeURIComponent(path)}`);
  return ((await res.json()) as unknown[]).length;
}

browserTest(h, "a page's sendBeacon saves a note, the same save again writes nothing more, and a stale one merges", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n\none\n");
  const { revision } = (await file(app, "Plan.md"))!;
  const beacon = (body: object) => app.page.evaluate((b) => navigator.sendBeacon("/api/file/beacon", JSON.stringify(b)), body);
  assert.equal(await beacon({ path: "Plan.md", base: revision, text: "# Plan\n\none\ntwo\n" }), true);
  for (let i = 0; i < 40 && (await file(app, "Plan.md"))?.text !== "# Plan\n\none\ntwo\n"; i++) await app.page.waitForTimeout(100);
  assert.equal((await file(app, "Plan.md"))?.text, "# Plan\n\none\ntwo\n");
  const written = await changes(app, "Plan.md");
  await beacon({ path: "Plan.md", base: revision, text: "# Plan\n\none\ntwo\n" });
  await app.page.waitForTimeout(500);
  assert.equal(await changes(app, "Plan.md"), written, "sent again, it writes nothing");
  // Someone else's edit at the top, then a beacon still based on the revision before it: both stay.
  const now = (await file(app, "Plan.md"))!;
  await app.page.context().request.put(`${app.base}/api/file`, { data: { path: "Plan.md", base: now.revision, text: "# Plan for Monday\n\none\ntwo\n" } });
  await beacon({ path: "Plan.md", base: now.revision, text: "# Plan\n\none\ntwo\nthree\n" });
  for (let i = 0; i < 40 && !(await file(app, "Plan.md"))?.text.includes("three"); i++) await app.page.waitForTimeout(100);
  assert.equal((await file(app, "Plan.md"))?.text, "# Plan for Monday\n\none\ntwo\nthree\n");
  // A stale one that clashes changes nothing.
  const clash = await app.page.context().request.post(`${app.base}/api/file/beacon`, { headers: { Origin: app.base, "Content-Type": "text/plain" }, data: JSON.stringify({ path: "Plan.md", base: revision, text: "# Plan for Tuesday\n\none\n" }) });
  assert.equal(clash.status(), 409);
  assert.equal((await file(app, "Plan.md"))?.text, "# Plan for Monday\n\none\ntwo\nthree\n");
});

browserTest(h, "a beacon save that doesn't prove it's from this site is refused, and a cross-site form post can't save", { scenario: "empty" }, async (app) => {
  await app.writeFile("Plan.md", "# Plan\n");
  const { revision } = (await file(app, "Plan.md"))!;
  const body = JSON.stringify({ path: "Plan.md", base: revision, text: "# Owned\n" });
  const post = (route: string, headers: Record<string, string>) => app.page.context().request.post(`${app.base}${route}`, { headers: { "Content-Type": "text/plain", ...headers }, data: body });
  assert.equal((await post("/api/file/beacon", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status(), 403, "another site");
  assert.equal((await post("/api/file/beacon", { "Sec-Fetch-Site": "cross-site" })).status(), 403, "another site, without an Origin");
  assert.equal((await post("/api/file/beacon", {})).status(), 403, "nothing saying where it's from");
  assert.equal((await post("/api/file", { Origin: "https://evil.example" })).status(), 403, "a form post to the file route");
  assert.equal((await file(app, "Plan.md"))?.text, "# Plan\n");
  assert.equal((await post("/api/file/beacon", { "Sec-Fetch-Site": "same-origin" })).status(), 200, "this site, as a browser says it");
});
