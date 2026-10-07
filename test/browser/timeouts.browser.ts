// A browser test whose page never answers fails at its timeout, and the rest of its file still runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

test("a stuck browser test fails at its timeout, and the next test in its file runs", { timeout: 240_000 }, async () => {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--test", "--test-reporter=tap", path.join(import.meta.dirname, "stuck.fixture.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a stuck run is stopped with the Worker and the file's process it started.
    detached: true,
    // Set, it makes the child a part of this run, which runs no files of its own.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const killer = setTimeout(() => process.kill(-child.pid!, "SIGKILL"), 180_000);
  const code = await new Promise<number | null>((done) => child.on("close", done));
  clearTimeout(killer);
  assert.notEqual(code, null, `the file ran to its end by itself:\n${out}`);
  const results = out.match(/^(?:not )?ok \d+ - .+$/gm);
  assert.deepEqual(results, ["not ok 1 - waits on its page forever", "not ok 2 - holds its page's thread forever", "ok 3 - runs after them"], out);
  assert.equal(out.match(/error: 'test timed out after 5000ms'/g)?.length, 2, out);
});
