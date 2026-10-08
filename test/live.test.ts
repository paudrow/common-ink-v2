import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import { afterBurst } from "../web/src/live.ts";

test("after a burst of changes, every changed path is handed on once, not only the last", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const heard: string[] = [];
    const change = afterBurst(400, (p) => heard.push(p));
    for (const p of [".common-ink/archive.json", "Beta.md", "Beta.md", "Alpha.md"]) {
      change(p as FilePath);
      mock.timers.tick(100);
    }
    assert.deepEqual(heard, [], "nothing while the burst goes on");
    mock.timers.tick(400);
    assert.deepEqual(heard, [".common-ink/archive.json", "Beta.md", "Alpha.md"]);
    change("Gamma.md" as FilePath);
    mock.timers.tick(400);
    assert.deepEqual(heard.slice(3), ["Gamma.md"]);
  } finally {
    mock.timers.reset();
  }
});
