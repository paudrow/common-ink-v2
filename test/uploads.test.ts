import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author } from "../worker/src/files.ts";
import { runOperation } from "../worker/src/operations.ts";
import { cleanName, parseUploads, placeName, sha256, showsInline, typeFor, UPLOADS_PATH, uploadsText, type Upload } from "../worker/src/uploads.ts";
import { memoryStore } from "./store.ts";

const you: Author = { kind: "user", email: "you@example.com" };
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

test("an upload's name is made safe to be an address", () => {
  assert.equal(cleanName("photo.PNG"), "photo.png");
  assert.equal(cleanName("C:\\Users\\me\\My  photo (1).jpg"), "My photo 1.jpg");
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName(".hidden"), "hidden");
  assert.equal(cleanName("a#b?c%d.pdf"), "abcd.pdf");
  assert.equal(cleanName("///"), null);
  assert.equal(cleanName(`${"x".repeat(300)}.pdf`)!.length, 120);
});

test("types come from the name; only some are shown in the page", () => {
  assert.equal(typeFor("photo.jpg"), "image/jpeg");
  assert.equal(typeFor("notes.pdf"), "application/pdf");
  assert.equal(typeFor("thing.exe"), "application/octet-stream");
  assert.ok(showsInline("image/png") && showsInline("application/pdf") && showsInline("video/mp4"));
  assert.ok(!showsInline("application/zip") && !showsInline("application/octet-stream") && !showsInline("text/html"));
});

test("a name that's taken by other bytes gets a number; the same bytes under it are the same upload", () => {
  const list: Upload[] = [
    { name: "photo.png", hash: "a".repeat(64), size: 1, type: "image/png" },
    { name: "photo-2.png", hash: "b".repeat(64), size: 1, type: "image/png" },
  ];
  assert.deepEqual(placeName(list, "photo.png", "a".repeat(64)), { name: "photo.png", existing: true });
  assert.deepEqual(placeName(list, "photo.png", "c".repeat(64)), { name: "photo-3.png", existing: false });
  assert.deepEqual(placeName(list, "photo.png", "b".repeat(64)), { name: "photo-2.png", existing: true });
  assert.deepEqual(placeName(list, "notes", "c".repeat(64)), { name: "notes", existing: false });
  assert.deepEqual(parseUploads(uploadsText(list)), list);
  assert.equal(uploadsText(list).split("\n").filter((l) => l.includes('"hash"')).length, 2, "one upload per line");
});

test("uploading keeps the bytes once and records the upload as a change by its author, which undo takes back", async () => {
  const store = memoryStore();
  const first = await store.upload("photo.PNG", bytes("pixels"), you);
  if (first.status !== "uploaded") return assert.fail(`not uploaded: ${first.status}`);
  assert.deepEqual(first.upload, { name: "photo.png", hash: await sha256(bytes("pixels")), size: 6, type: "image/png" });
  assert.equal(first.url, "/uploads/photo.png");
  assert.deepEqual(store.blobs.data.get(`blobs/${first.upload.hash}`), bytes("pixels"));
  const [change] = store.files.recent({ path: UPLOADS_PATH });
  assert.deepEqual(change.author, you);

  const again = await store.upload("photo.png", bytes("pixels"), you);
  assert.equal(again.status, "existing");
  const other = await store.upload("photo.png", bytes("other pixels"), you);
  assert.equal(other.status === "uploaded" && other.upload.name, "photo-2.png");
  assert.equal(store.blobs.data.size, 2);
  assert.equal(store.files.recent({ path: UPLOADS_PATH }).length, 2, "the repeat recorded nothing");

  store.files.undo([change.revision + 1], you);
  assert.deepEqual(
    parseUploads(store.files.read(UPLOADS_PATH)!.text).map((u) => u.name),
    ["photo.png"],
  );
  assert.equal(store.blobs.data.size, 2, "the bytes stay, so redo can bring the upload back");
});

test("empty, nameless and oversized uploads are refused", async () => {
  const store = memoryStore();
  assert.deepEqual(await store.upload("a.txt", new ArrayBuffer(0), you), { status: "refused", error: "a.txt is empty" });
  assert.deepEqual(await store.upload("/", bytes("x"), you), { status: "refused", error: "An upload needs a file name" });
  const big = await store.upload("big.bin", new ArrayBuffer(25 * 1024 * 1024 + 1), you);
  assert.equal(big.status, "refused");
});

test("agents upload through the operations with base64, and list uploads with their addresses", async () => {
  const store = memoryStore();
  const agent: Author = { kind: "agent", name: "Claude", by: "you@example.com" };
  const up = await runOperation("upload_file", { name: "chart.svg", data: Buffer.from("<svg/>").toString("base64") }, store, agent);
  assert.ok(up.ok);
  assert.deepEqual(up.value, { status: "uploaded", name: "chart.svg", hash: await sha256(bytes("<svg/>")), size: 6, type: "image/svg+xml", url: "/uploads/chart.svg" });
  const list = await runOperation("list_uploads", {}, store, agent);
  assert.ok(list.ok && (list.value as Array<{ url: string }>)[0].url === "/uploads/chart.svg");
  const bad = await runOperation("upload_file", { name: "x.txt", data: "" }, store, agent);
  assert.deepEqual(bad, { ok: false, error: "x.txt is empty" });
});

test("an upload's bytes are read only up to the limit, however the body comes", async () => {
  const { bytesUpTo } = await import("../worker/src/uploads.ts");
  let pulled = 0;
  const body = (chunks: number, size: number) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ >= chunks) return controller.close();
        controller.enqueue(new Uint8Array(size).fill(7));
      },
    });
  const small = await bytesUpTo(body(3, 4), 100);
  assert.deepEqual(small && [...new Uint8Array(small)], Array(12).fill(7));
  pulled = 0;
  assert.equal(await bytesUpTo(body(1000, 40), 100), null);
  assert.ok(pulled < 10, `it stopped reading at the limit, after ${pulled} chunks`);
  assert.equal((await bytesUpTo(null, 100))?.byteLength, 0);
});
