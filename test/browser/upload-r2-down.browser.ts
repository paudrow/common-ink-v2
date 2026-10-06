// Uploads while R2 can't be reached: serving answers 503 under the upload's own policy, and an upload is
// refused with a reason and records nothing. R2 is made unreachable the way it fails on this machine: its
// blobs folder can't be read or written, while its metadata still can.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { unstable_dev } from "wrangler";
import { ensureBuilt } from "./launch.ts";

const root = path.resolve(import.meta.dirname, "../..");
const persistTo = fs.mkdtempSync(path.join(os.tmpdir(), "r2-down-"));
let base = "";
let stop = async () => {};

before(async () => {
  ensureBuilt();
  const worker = await unstable_dev("", {
    config: path.join(root, "worker/wrangler.jsonc"),
    vars: { DEV_USER: "tester@localhost", SEED: "1", LEVERS: "1" },
    experimental: { disableExperimentalWarning: true },
    persistTo,
    logLevel: "none",
  } as never);
  base = `http://${worker.address}:${worker.port}`;
  stop = () => worker.stop();
});
after(async () => {
  await stop();
  fs.rmSync(persistTo, { recursive: true, force: true });
});

async function whileR2IsDown(body: () => Promise<void>) {
  const blobs = path.join(persistTo, "v3/r2/common-ink-v2-uploads/blobs");
  fs.chmodSync(blobs, 0o000);
  try {
    await body();
  } finally {
    fs.chmodSync(blobs, 0o755);
  }
}

const uploads = async () => (await fetch(`${base}/api/file?path=${encodeURIComponent(".common-ink/uploads.json")}`)).json();

test("an upload that can't be read answers 503 under the upload's policy, and serves again once R2 is back", async () => {
  assert.equal((await fetch(`${base}/api/upload?name=chart.svg`, { method: "PUT", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" })).status, 200);
  await whileR2IsDown(async () => {
    const res = await fetch(`${base}/uploads/chart.svg`);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "60");
    assert.equal(res.headers.get("Content-Security-Policy"), "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(await res.text(), "Uploads can't be read right now. Try again in a minute.\n");
  });
  const back = await fetch(`${base}/uploads/chart.svg`);
  assert.equal(back.status, 200);
  assert.equal(await back.text(), "<svg xmlns='http://www.w3.org/2000/svg'/>");
});

test("a HEAD for an upload asks R2 only whether it's there, so it answers while the bytes can't be read", async () => {
  await whileR2IsDown(async () => {
    const res = await fetch(`${base}/uploads/chart.svg`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "image/svg+xml");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /^sandbox;/);
    assert.equal(await res.text(), "");
  });
});

test("an upload while R2 is down is refused with a reason and leaves the uploads file as it was", async () => {
  const before = await uploads();
  await whileR2IsDown(async () => {
    const res = await fetch(`${base}/api/upload?name=photo.png`, { method: "PUT", body: "new bytes" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "photo.png wasn't uploaded: uploads can't be stored right now. Try again in a minute." });
  });
  assert.deepEqual(await uploads(), before);
});
