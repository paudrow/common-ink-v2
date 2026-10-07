// One process at a time: the browser test files run side by side, each in its own process, and a
// build empties the dist folder that the others' Workers serve from.
import { mkdirSync, rmSync, statSync } from "node:fs";

/** A lock left by a process that died holding it is taken after this long. */
const STALE_MS = 10 * 60_000;

/** Run `fn` holding the lock at `dir` (a folder, since making one either succeeds or finds it there), waiting for whoever holds it. */
export function oneAtATime<T>(dir: string, fn: () => T): T {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const since = Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (since > STALE_MS) rmSync(dir, { recursive: true, force: true });
      else Atomics.wait(pause, 0, 0, 200);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
