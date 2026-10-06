// A Preview's workspace is filled from its deploy's seed.json by the first requests an isolate gets
// (index.ts). Those come at once, a page and its API calls, so they share one seeding, and a seeding
// that fails is logged rather than failing them: the next request tries again.
import type { Seed } from "./files.ts";

/** One isolate's seeding: done, or the one running now. */
export interface SeedRun {
  done: boolean;
  running: Promise<void> | null;
}

export function seedOnce(run: SeedRun, load: () => Promise<Seed | null>, apply: (seed: Seed) => Promise<unknown>): Promise<void> {
  if (run.done) return Promise.resolve();
  run.running ??= (async () => {
    const seed = await load();
    if (seed) await apply(seed);
    run.done = true;
  })()
    .catch((err) => console.error("Seeding the workspace failed; the next request tries again.", err))
    .finally(() => (run.running = null));
  return run.running;
}
