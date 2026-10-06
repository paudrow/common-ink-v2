// The app's built files under /assets/, which the browser gets straight from the static assets without
// the Worker: they ask for HTTPS and aren't sniffed, and a name that isn't there (answered with the
// app's page, as every unknown address is) can't run or be framed there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

const h = harness();

test("a built file asks for HTTPS and isn't sniffed, and a missing one can't run as a page or a script", async () => {
  const page = await (await fetch(`${h.base}/`)).text();
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(page)![1];
  const found = await fetch(`${h.base}${script}`);
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(found.headers.get("X-Content-Type-Options"), "nosniff");
  const missing = await fetch(`${h.base}/assets/not-there-123.js`);
  assert.equal(missing.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(missing.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(missing.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.doesNotMatch(missing.headers.get("Content-Type") ?? "", /javascript/);
});

test("anything but a GET under /uploads/ answers with the uploads' policy, not the app's", async () => {
  const res = await fetch(`${h.base}/uploads/x.svg`, { method: "POST" });
  assert.notEqual(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /^sandbox;/);
});
