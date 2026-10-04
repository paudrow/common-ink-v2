import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import { Jumps } from "../web/src/jumps.ts";

const [a, b, c] = ["A.md", "B.md", "C.md"] as FilePath[];

test("back and forward return to each note where the cursor was", () => {
  const jumps = new Jumps({ path: a, pos: 0 });
  jumps.visit({ path: a, pos: 5 }, b);
  jumps.visit({ path: b, pos: 7 }, c);
  assert.deepEqual(jumps.back({ path: c, pos: 2 }), { path: b, pos: 7 });
  assert.deepEqual(jumps.back({ path: b, pos: 8 }), { path: a, pos: 5 });
  assert.equal(jumps.back({ path: a, pos: 5 }), null);
  assert.deepEqual(jumps.forward({ path: a, pos: 6 }), { path: b, pos: 8 });
  assert.deepEqual(jumps.forward({ path: b, pos: 8 }), { path: c, pos: 2 });
  assert.equal(jumps.forward({ path: c, pos: 2 }), null);
});

test("opening a note after going back drops the notes ahead", () => {
  const jumps = new Jumps({ path: a, pos: 0 });
  jumps.visit({ path: a, pos: 0 }, b);
  jumps.back({ path: b, pos: 0 });
  jumps.visit({ path: a, pos: 3 }, c);
  assert.equal(jumps.forward({ path: c, pos: 0 }), null);
  assert.deepEqual(jumps.back({ path: c, pos: 0 }), { path: a, pos: 3 });
});
