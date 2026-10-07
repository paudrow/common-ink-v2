// The browser test files run side by side, each in its own process, and build the app when it's out of
// date: oneAtATime lets one build while the others wait, since a build empties what they serve.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("processes that ask for the lock at once take turns, each finishing before the next starts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "build-lock-"));
  try {
    const log = path.join(dir, "log");
    const script = path.join(dir, "turn.ts");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
import { oneAtATime } from ${JSON.stringify(path.join(root, "test/browser/lock.ts"))};
oneAtATime(${JSON.stringify(path.join(dir, "lock"))}, () => {
  appendFileSync(${JSON.stringify(log)}, "in " + process.argv[2] + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  appendFileSync(${JSON.stringify(log)}, "out " + process.argv[2] + "\\n");
});
`,
    );
    const runs = ["a", "b", "c", "d"].map(
      (name) =>
        new Promise<number | null>((done) => spawn(process.execPath, ["--import", "tsx", script, name], { cwd: root, stdio: "inherit" }).on("exit", done)),
    );
    assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 8);
    for (let i = 0; i < lines.length; i += 2) assert.equal(lines[i + 1], lines[i].replace("in", "out"), `turn ${i / 2 + 1} ends before another starts: ${lines.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
