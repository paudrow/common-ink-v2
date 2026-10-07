// A browser test whose page never answers fails at its timeout, and the rest of its file still runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const RESULTS = path.resolve(import.meta.dirname, "../../test-results");
const evidence = (test: string) => path.join(RESULTS, test.replace(/[^\w]+/g, "-"));

test("a stuck browser test fails at its timeout, its page is closed, and the next test in its file runs", { timeout: 240_000 }, async () => {
  for (const t of ["waits on its page forever", "runs after them"]) fs.rmSync(evidence(t), { recursive: true, force: true });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", "--test", "--test-reporter=tap", path.join(import.meta.dirname, "stuck.fixture.ts")], {
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a stuck run is stopped with the file's process and the Worker it started.
    // (Chrome isn't in it: it goes by itself once the pipe to it closes.)
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
  // Its screenshot, too, unless the machine is so busy that taking one outlasts the evidence's ten seconds.
  assert.ok(fs.existsSync(path.join(evidence("waits on its page forever"), "errors.txt")), "a stuck test keeps its evidence");
  assert.ok(!fs.existsSync(evidence("runs after them")), "a test that passed keeps none");
});
