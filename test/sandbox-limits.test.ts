// What crosses a sandboxed frame's port, measured once: as JSON would write it, refusing anything that
// isn't plain data, and giving up as soon as it's past the limit. And each frame's share of a moment,
// kept as a running total, by size and by count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CallShare, measure } from "../web/src/sandbox.ts";

const LIMIT = 2_000_000;

test("a plain value measures as JSON writes it, escapes included", () => {
  for (const v of ["plain", '"quoted" and \\back\\', "\u0000\u001f\n\t", "😀 emoji", 7, -1.5e300, true, null, [], {}, [1, "two", [3]], [1, undefined], { a: 1, "b c": ["x"], d: { e: null }, gone: undefined }]) {
    assert.equal(measure(v, LIMIT), JSON.stringify(v).length, JSON.stringify(v));
  }
});

test("anything that isn't plain data is refused, however it's built", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let deep: unknown = 1;
  for (let i = 0; i < 20_000; i++) deep = [deep];
  for (const v of [new String("x"), new Date(0), new Map([["a", 1]]), new ArrayBuffer(8), cycle, deep, Object.create(null), () => 1, [() => 1]]) {
    assert.equal(measure(v, LIMIT), null, Object.prototype.toString.call(v));
  }
});

test("a value past the limit is found out without walking all of it, a sparse array's holes included", () => {
  const sparse: unknown[] = [];
  sparse.length = 60_000_000;
  const started = performance.now();
  assert.equal(measure(sparse, LIMIT), Infinity);
  assert.equal(measure(new Array(3_000_000).fill(7), LIMIT), Infinity);
  assert.equal(measure("x".repeat(LIMIT), LIMIT), Infinity);
  assert.ok(performance.now() - started < 200, "it stopped early");
  const holes = [1, , 3];
  assert.equal(measure(holes, LIMIT), JSON.stringify(holes).length, "a hole is a null, as JSON writes it");
});

test("a frame's share takes tiny calls in constant time each, and stops them by count as well as size", () => {
  const share = new CallShare({ size: 10_000_000, calls: 2_000, ms: 10_000 });
  const started = performance.now();
  let taken = 0;
  for (let i = 0; i < 400_000; i++) if (share.take(8, 1_000)) taken++;
  assert.ok(performance.now() - started < 300, `${Math.round(performance.now() - started)} ms`);
  assert.equal(taken, 2_000);
  assert.equal(share.take(8, 11_001), true, "the moment passed, so there's room again");
  const big = new CallShare({ size: 10_000_000, calls: 2_000, ms: 10_000 });
  assert.deepEqual([big.take(6_000_000, 0), big.take(6_000_000, 5_000), big.take(6_000_000, 10_001)], [true, false, true]);
});
