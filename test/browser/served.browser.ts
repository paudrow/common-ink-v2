// What the Worker serves as script or as a file, against the real Worker: an upload's type comes from
// its name, not from the uploads file anyone may edit; a workspace extension's code is served as a
// script to the page only once it's trusted; and every page says to use HTTPS from now on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

const h = harness();

async function write(path: string, text: string) {
  const current = await fetch(`${h.base}/api/file?path=${encodeURIComponent(path)}`);
  const base = current.ok ? ((await current.json()) as { revision: number }).revision : 0;
  const res = await fetch(`${h.base}/api/file`, { method: "PUT", body: JSON.stringify({ path, text, base }) });
  assert.ok(res.ok, `write ${path}: ${res.status}`);
}

test("an upload is served as the type its name gives, whatever the uploads file says", async () => {
  const up = await fetch(`${h.base}/api/upload?name=notes.txt`, { method: "PUT", body: "alert(document.domain)" });
  assert.ok(up.ok);
  const uploads = JSON.parse(((await (await fetch(`${h.base}/api/file?path=.common-ink%2Fuploads.json`)).json()) as { text: string }).text);
  for (const u of uploads.uploads) if (u.name === "notes.txt") u.type = "text/javascript";
  await write(".common-ink/uploads.json", JSON.stringify(uploads));
  const res = await fetch(`${h.base}/uploads/notes.txt`);
  assert.equal(res.headers.get("Content-Type"), "text/plain");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("a workspace extension's code is a script for the page only once it's trusted", async () => {
  await write(".common-ink/extensions/gadget/extension.json", JSON.stringify({ name: "Gadget" }));
  await write(".common-ink/extensions/gadget/index.js", "export default { activate() {} };\n");
  assert.equal((await fetch(`${h.base}/extensions/gadget/index.js`)).status, 404);
  await write(".common-ink/users/tester@localhost/settings.json", JSON.stringify({ "extensions.trusted": ["gadget"] }));
  const trusted = await fetch(`${h.base}/extensions/gadget/index.js`);
  assert.equal(trusted.status, 200);
  assert.equal(await trusted.text(), "export default { activate() {} };\n");
});

test("pages, the API and uploads tell the browser to use HTTPS for a year", async () => {
  for (const path of ["/", "/api/files", "/uploads/notes.txt"]) {
    assert.equal((await fetch(`${h.base}${path}`)).headers.get("Strict-Transport-Security"), "max-age=31536000", path);
  }
});

test("redirects and the sandbox route ask for HTTPS too", async () => {
  const v1 = await fetch(`${h.base}/s/abc`, { redirect: "manual" });
  assert.equal(v1.status, 302);
  for (const res of [v1, await fetch(`${h.base}/sandbox/host`), await fetch(`${h.base}/sandbox/host.js`)]) {
    assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000", res.url);
  }
});
