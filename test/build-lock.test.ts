// The browser test files run side by side, each in its own process, and build the app when it's out of
// date: oneAtATime lets one build while the others wait, since a build empties what they serve.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a lock whose process is gone, as after a Ctrl-C mid-build, is taken at once, and a waiter says who it waits for", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "build-lock-"));
  const lock = path.join(dir, "lock");
  const script = path.join(dir, "take.ts");
  writeFileSync(script, `import { oneAtATime } from ${JSON.stringify(path.join(root, "test/browser/lock.ts"))};\noneAtATime(${JSON.stringify(lock)}, () => process.stdout.write("built"));\n`);
  const holdLock = (pid: string | number) => (mkdirSync(lock), writeFileSync(path.join(lock, "pid"), String(pid)));
  try {
    holdLock(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
    const taken = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(taken.stdout, "built", `it builds within 10 seconds, not once the lock is stale (${taken.signal ?? taken.status})`);

    holdLock(process.pid);
    const waiter = spawn(process.execPath, ["--import", "tsx", script], { cwd: root });
    let said = "";
    waiter.stderr.on("data", (d) => (said += d));
    await new Promise((done) => setTimeout(done, 1500));
    rmSync(lock, { recursive: true });
    assert.equal(await new Promise((done) => waiter.on("exit", done)), 0);
    assert.match(said, new RegExp(`Waiting for process ${process.pid}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
