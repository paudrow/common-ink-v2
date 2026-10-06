// An upload opened by itself, in a real browser, the first time and again: it stays under the upload's
// own policy however the browser asks for it, and the sandbox's code is never a script for this site's
// pages, sandboxed or not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

const h = harness();

async function write(path: string, text: string) {
  const current = await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`);
  const base = current.ok ? ((await current.json()) as { revision: number }).revision : 0;
  assert.ok((await fetch(`${h.base}/api/file`, { method: "PUT", body: JSON.stringify({ path, text, base }) })).ok);
}

test("an SVG upload opened twice runs nothing as this site, and answers a revalidation with its own policy", async () => {
  await write(".common-ink/extensions/gadget/extension.json", JSON.stringify({ name: "Gadget" }));
  await write(".common-ink/extensions/gadget/index.js", "document.title = 'RAN as ' + location.origin;\n");
  const { token } = (await (await fetch(`${h.base}/api/sandbox/token?extension=gadget`)).json()) as { token: string };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>still</title><script href="/sandbox/code/${token}/index.js"></script><rect width="10" height="10"/></svg>`;
  const up = (await (await fetch(`${h.base}/api/upload?name=chart.svg`, { method: "PUT", body: svg })).json()) as { upload: { hash: string } };
  const first = await fetch(`${h.base}/uploads/chart.svg`);
  const again = await fetch(`${h.base}/uploads/chart.svg`, { headers: { "If-None-Match": `"${up.upload.hash}"` } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("Content-Security-Policy"), first.headers.get("Content-Security-Policy"));
  assert.match(again.headers.get("Content-Security-Policy") ?? "", /^sandbox;/);

  const context = await h.browser.newContext();
  const page = await context.newPage();
  for (let visit = 0; visit < 2; visit++) {
    await page.goto(`${h.base}/uploads/chart.svg`);
    await page.waitForTimeout(800);
    assert.equal(await page.title(), "still", `visit ${visit + 1}`);
  }
  await context.close();
});

test("the sandbox's code isn't served to a page of this site's own origin", async () => {
  const { token } = (await (await fetch(`${h.base}/api/sandbox/token?extension=gadget`)).json()) as { token: string };
  const code = (site: string) => fetch(`${h.base}/sandbox/code/${token}/index.js`, { headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Dest": "script" } });
  assert.equal((await code("same-origin")).status, 404);
  assert.equal((await code("cross-site")).status, 200);
});
