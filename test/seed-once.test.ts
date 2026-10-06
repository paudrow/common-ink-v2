import assert from "node:assert/strict";
import { test } from "node:test";
import type { Seed } from "../worker/src/files.ts";
import { seedOnce, type SeedRun } from "../worker/src/seed-once.ts";

const seed: Seed = { id: "s1", notes: [] };

test("first requests that come at once share one seeding, and later ones don't seed again", async () => {
  const run: SeedRun = { done: false, running: null };
  let seeded = 0;
  const apply = async () => {
    await new Promise((r) => setTimeout(r, 20));
    seeded++;
  };
  await Promise.all(Array.from({ length: 10 }, () => seedOnce(run, async () => seed, apply)));
  await seedOnce(run, async () => seed, apply);
  assert.equal(seeded, 1);
});

test("a seeding that fails doesn't fail the request, and the next request tries again", async () => {
  const run: SeedRun = { done: false, running: null };
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await Promise.all([1, 2, 3].map(() => seedOnce(run, async () => { throw new Error("assets are slow"); }, async () => {})));
    assert.equal(errors.length, 1);
    let seeded = 0;
    await seedOnce(run, async () => seed, async () => void seeded++);
    assert.equal(seeded, 1);
  } finally {
    console.error = log;
  }
});
