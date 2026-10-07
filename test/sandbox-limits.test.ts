// What crosses a sandboxed frame's port, measured once: as JSON would write it, refusing anything that
// isn't plain data, and giving up as soon as it's past the limit. And each frame's share of a moment,
// kept as a running total, by size and by count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CallShare, SandboxHost, measure } from "../web/src/sandbox.ts";

const LIMIT = 2_000_000;

test("a plain value measures as JSON writes it, escapes included", () => {
  for (const v of ["\ud800 lone \udfff surrogates", "plain", '"quoted" and \\back\\', "\u0000\u001f\n\t", "😀 emoji", 7, -1.5e300, true, null, [], {}, [1, "two", [3]], [1, undefined], { a: 1, "b c": ["x"], d: { e: null }, gone: undefined }]) {
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
  const share = new CallShare("Flood", { size: 10_000_000, calls: 2_000, ms: 10_000 });
  const started = performance.now();
  const refusals = new Set<string>();
  let taken = 0;
  for (let i = 0; i < 400_000; i++) {
    const refused = share.take(8, 1_000);
    if (refused === null) taken++;
    else refusals.add(refused);
  }
  assert.ok(performance.now() - started < 150, `${Math.round(performance.now() - started)} ms, refusals' words included`);
  assert.equal(taken, 2_000);
  assert.deepEqual([...refusals], ["Flood is calling too often: it can make 2,000 calls every 10 seconds"]);
  assert.equal(share.take(8, 11_001), null, "the moment passed, so there's room again");
  const big = new CallShare("Big", { size: 10_000_000, calls: 2_000, ms: 10_000 });
  assert.deepEqual([big.take(6_000_000, 0), big.take(6_000_000, 5_000), big.take(6_000_000, 10_001)], [null, "Big is sending too much at once: it can send 10,000,000 characters' worth every 10 seconds", null]);
});

const TOO_OFTEN = "Spammer is calling too often: it can make 2,000 calls every 10 seconds";

/** A port standing in for a frame's: what it was sent, counted, and the calls it gets, made up front. */
function framePort() {
  const sent = { results: 0, refusals: 0, other: [] as unknown[] };
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(m: { t: string; id?: string; message?: string }) {
      if (m.t === "result") sent.results++;
      else if (m.message === TOO_OFTEN) sent.refusals++;
      else sent.other.push(m);
    },
  };
  const calls = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ data: { t: "call", id: `${prefix}${i}`, method: "commands.shortcut", args: ["nope"] } }));
  return { port, sent, calls };
}

/** CPU time in ms, not the clock's: on a busy machine the clock also counts this process waiting its turn. */
function cpu(work: () => void) {
  const before = process.cpuUsage();
  work();
  const { user, system } = process.cpuUsage(before);
  return (user + system) / 1000;
}

test("a frame's flood of tiny calls past its share is refused at about the cost of answering each at all", async () => {
  // What answering 100,000 calls costs with nothing done for them: an async answer with words made once.
  const bare = framePort();
  bare.port.onmessage = (e) => void (async (id: string) => bare.port.postMessage({ t: "reject", id, message: TOO_OFTEN }))((e.data as { id: string }).id);
  bare.calls(20_000, "warm").forEach((m) => bare.port.onmessage!(m));
  const answering = bare.calls(100_000, "h");
  const alone = cpu(() => answering.forEach((m) => bare.port.onmessage!(m)));

  const { port, sent, calls } = framePort();
  void new SandboxHost({ name: "Spammer" } as never, async () => null, () => {}).talk(port as unknown as MessagePort);
  calls(2_000, "w").forEach((m) => port.onmessage!(m));
  await new Promise((r) => setTimeout(r, 0));
  calls(20_000, "warm").forEach((m) => port.onmessage!(m));
  const flooding = calls(100_000, "h");
  const flood = cpu(() => flooding.forEach((m) => port.onmessage!(m)));

  assert.deepEqual(sent, { results: 2_000, refusals: 120_000, other: [] });
  assert.ok(flood < 3 * alone + 30, `refusing 100,000 calls took ${Math.round(flood)} ms of CPU, against ${Math.round(alone)} ms to answer them at all`);
});
