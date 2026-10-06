import assert from "node:assert/strict";
import { test } from "node:test";
import { linePatch } from "../../web/src/line-diff.ts";
import { forAll, type Rng } from "./gen.ts";

/** Lines from a small set, so many repeat (as blank lines do), and an edit of them. */
const lines = (r: Rng) => r.array(0, 30, (r) => r.pick(["", "", "a", "b", "c", "- x"]));
const edited = (r: Rng, a: string[]) => {
  const b = [...a];
  for (let k = r.int(0, 4); k > 0; k--) {
    const at = r.int(0, b.length);
    if (r.bool()) b.splice(at, r.int(0, 3), ...r.array(0, 3, (r) => r.pick(["", "new", "a", "z"])));
    else if (b.length) b[Math.min(at, b.length - 1)] = "changed";
  }
  return b;
};

test("a line patch, applied to the lines before, gives the lines after", () => {
  forAll((r) => { const a = lines(r); return { a, b: edited(r, a) }; }, ({ a, b }) => {
    const out: string[] = [];
    let at = 0;
    for (const { buffer1, buffer2 } of linePatch(a, b)) {
      out.push(...a.slice(at, buffer1.offset), ...buffer2.chunk);
      at = buffer1.offset + buffer1.length;
    }
    out.push(...a.slice(at));
    assert.deepEqual(out, b);
  }, { runs: 500 });
});
