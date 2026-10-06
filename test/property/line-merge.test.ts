import assert from "node:assert/strict";
import { test } from "node:test";
import { diff3Merge, diffPatch, type IPatchRes } from "node-diff3";
import { lineMerge, linePatch } from "../../worker/src/line-diff.ts";
import { forAll, type Rng } from "./gen.ts";

/** node-diff3's own merge over the whole text, as Files merged before. */
function wholeMerge(a: string[], o: string[], b: string[]): string[] | null {
  const regions = diff3Merge(a, o, b, { excludeFalseConflicts: true });
  return regions.some((r) => r.conflict) ? null : regions.flatMap((r) => r.ok ?? []);
}

const applied = (a: string[], patch: IPatchRes<string>[]) => {
  const out: string[] = [];
  let at = 0;
  for (const { buffer1, buffer2 } of patch) {
    out.push(...a.slice(at, buffer1.offset), ...buffer2.chunk);
    at = buffer1.offset + buffer1.length;
  }
  return [...out, ...a.slice(at)];
};
const size = (patch: IPatchRes<string>[]) => patch.reduce((n, h) => n + h.buffer1.length + h.buffer2.chunk.length, 0);

/** Up to four edits: lines cut, lines added, from `vocab`. */
const edited = (r: Rng, from: string[], vocab: string[]) => {
  const out = [...from];
  for (let k = r.int(1, 4); k > 0; k--) out.splice(r.int(0, out.length), r.int(0, 3), ...r.array(0, 3, (r) => r.pick(vocab)));
  return out;
};

/** A note's lines: most say something of their own, with blank lines and rules between, which repeat. */
const note = (r: Rng) => {
  let n = 0;
  return r.array(0, 120, (r) => (r.bool(0.2) ? "" : r.bool(0.05) ? "---" : `line ${n++}`));
};
const NOTE_EDITS = ["", "", "---", "new", "newer"];

/** Lines from so few values that nearly every one repeats. */
const repetitive = (r: Rng) => r.array(0, 40, (r) => r.pick(["", "", "a", "b"]));
const REPETITIVE_EDITS = ["", "a", "b", "x"];

test("a line patch rebuilds the lines after, and is as small as node-diff3's over the whole text", () => {
  forAll(
    (r) => {
      const a = r.bool() ? note(r) : repetitive(r);
      return { a, b: edited(r, a, r.bool() ? NOTE_EDITS : REPETITIVE_EDITS) };
    },
    ({ a, b }) => {
      const patch = linePatch(a, b);
      assert.deepEqual(applied(a, patch), b);
      assert.equal(size(patch), size(diffPatch(a, b)));
    },
    { runs: 500 },
  );
});

test("on a note's lines, the patch and the merge are node-diff3's own over the whole text", () => {
  forAll(
    (r) => {
      const o = note(r);
      return { o, a: edited(r, o, NOTE_EDITS), b: edited(r, o, NOTE_EDITS) };
    },
    ({ o, a, b }) => {
      assert.deepEqual(linePatch(o, a), diffPatch(o, a));
      assert.deepEqual(lineMerge(a, o, b), wholeMerge(a, o, b));
    },
    { runs: 500 },
  );
});

test("on a few short lines that nearly all repeat, the merge is node-diff3's own too", () => {
  forAll(
    (r) => {
      const o = r.array(0, 12, (r) => r.pick(["", "", "a", "b", "c"]));
      return { o, a: edited(r, o, REPETITIVE_EDITS), b: edited(r, o, REPETITIVE_EDITS) };
    },
    ({ o, a, b }) => assert.deepEqual(lineMerge(a, o, b), wholeMerge(a, o, b)),
    { runs: 500 },
  );
});

test("merges with edits at the very start or end, or the same edit on both sides, come out as node-diff3's", () => {
  const o = ["# Plan", "", "one", "", "two", "", "three"];
  const cases: Array<[string, string[], string[], string[] | null]> = [
    ["both change the first line differently", ["# Plans", ...o.slice(1)], ["# The plan", ...o.slice(1)], null],
    ["both change the last line differently", [...o.slice(0, -1), "3"], [...o.slice(0, -1), "III"], null],
    ["one changes the first line, the other the last", ["# Plans", ...o.slice(1)], [...o.slice(0, -1), "3"], ["# Plans", ...o.slice(1, -1), "3"]],
    ["both add the same line at the start", ["new", ...o], ["new", ...o], ["new", ...o]],
    ["both add different lines at the end", [...o, "four"], [...o, "4"], null],
    ["one adds at the start, the other at the end", ["new", ...o], [...o, "four"], ["new", ...o, "four"]],
    ["both make the same edit in the middle", [...o.slice(0, 4), "TWO", ...o.slice(5)], [...o.slice(0, 4), "TWO", ...o.slice(5)], [...o.slice(0, 4), "TWO", ...o.slice(5)]],
    ["both make the same edits, at both ends", ["# Plans", ...o.slice(1, -1), "3"], ["# Plans", ...o.slice(1, -1), "3"], ["# Plans", ...o.slice(1, -1), "3"]],
    ["both cut everything", [], [], []],
    ["one cuts the first line, the other the last", o.slice(1), o.slice(0, -1), o.slice(1, -1)],
    ["neither changes anything", o, o, o],
  ];
  for (const [name, a, b, merged] of cases) {
    assert.deepEqual(lineMerge(a, o, b), merged, name);
    assert.deepEqual(lineMerge(a, o, b), wholeMerge(a, o, b), `${name}, as node-diff3`);
  }
  assert.deepEqual(lineMerge(["a"], [], ["a"]), ["a"], "from nothing, the same line on both sides");
  assert.deepEqual(lineMerge(["a"], [], ["b"]), null, "from nothing, different lines");
});
