// One process at a time: the browser test files run side by side, each in its own process, and a
// build empties the dist folder that the others' Workers serve from.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A lock that names no process (one that ended between making the folder and naming itself) is taken after this long. */
const UNNAMED_MS = 10_000;

/** The process holding the lock at `dir`, if it named itself. */
function holder(dir: string): number | null {
  try {
    return Number(readFileSync(path.join(dir, "pid"), "utf8")) || null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run `fn` holding the lock at `dir` (a folder, since making one either succeeds or finds it there), waiting for whoever holds it. */
export function oneAtATime<T>(dir: string, fn: () => T): T {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let told = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(path.join(dir, "pid"), String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = holder(dir);
      const age = Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (pid ? !alive(pid) : age > UNNAMED_MS) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (pid && pid !== told) {
        told = pid;
        console.error(`Waiting for process ${pid} to finish building the app (${dir})`);
      }
      Atomics.wait(pause, 0, 0, 200);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
