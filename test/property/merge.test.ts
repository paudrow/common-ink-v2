import assert from "node:assert/strict";
import { test } from "node:test";
import { Files, merge, type Author, type FilePath, type WorkspaceFile } from "../../worker/src/files.ts";
import { memoryDb } from "../sqlite.ts";
import { forAll, type Rng } from "./gen.ts";

const VOCAB = ["one", "two", "three", ""];

/** A few random lines from a small vocabulary, so lines repeat as they do in real notes. */
const text = (r: Rng) => r.array(0, 8, () => r.pick(VOCAB)).join("\n");

/** A text with up to three random edits: lines cut, lines added. */
function edited(r: Rng, from: string): string {
  const lines = from.split("\n");
  for (let k = r.int(1, 3); k > 0; k--) lines.splice(r.int(0, lines.length), r.int(0, 2), ...r.array(0, 2, () => r.pick([...VOCAB, "four", "five"])));
  return lines.join("\n");
}

test("a merge with one side unchanged is the other side, and both sides making the same edit is that edit", () => {
  forAll(
    (r) => {
      const base = text(r);
      return { base, x: edited(r, base) };
    },
    ({ base, x }) => {
      assert.equal(merge(x, base, base), x, "only mine changed");
      assert.equal(merge(base, base, x), x, "only theirs changed");
      assert.equal(merge(x, base, x), x, "both changed the same way");
    },
    { runs: 300 },
  );
});

test("edits to separate lines, with a line neither touches between them, always merge into both edits", () => {
  forAll(
    (r) => {
      const n = r.int(2, 10);
      const base = Array.from({ length: n }, (_, i) => `line ${i}`);
      const s1 = r.int(0, n - 1);
      const e1 = r.int(s1, Math.min(s1 + 2, n - 1));
      const s2 = r.int(e1 + 1, n);
      const e2 = r.int(s2, Math.min(s2 + 2, n));
      const first = r.array(0, 2, () => `first ${r.int(0, 99)}`);
      const second = r.array(0, 2, () => `second ${r.int(0, 99)}`);
      return { base, first: { from: s1, to: e1, lines: first }, second: { from: s2, to: e2, lines: second }, mineFirst: r.bool() };
    },
    ({ base, first, second, mineFirst }) => {
      const apply = (...edits: Array<typeof first>) => {
        const lines = [...base];
        for (const e of [...edits].sort((a, b) => b.from - a.from)) lines.splice(e.from, e.to - e.from, ...e.lines);
        return lines.join("\n");
      };
      const [mine, theirs] = mineFirst ? [apply(first), apply(second)] : [apply(second), apply(first)];
      assert.equal(merge(mine, base.join("\n"), theirs), apply(first, second));
    },
    { runs: 300 },
  );
});

test("a merge comes out the same with mine and theirs swapped", () => {
  let merged = 0;
  forAll(
    (r) => {
      const base = text(r);
      return { base, x: edited(r, base), y: edited(r, base) };
    },
    ({ base, x, y }) => {
      const result = merge(x, base, y);
      assert.equal(merge(y, base, x), result);
      if (typeof result === "string") merged++;
    },
    { runs: 300 },
  );
  assert.ok(merged > 0, "some of the edits merged");
});

const AUTHORS: Author[] = [
  { kind: "user", email: "ada@example.com" },
  { kind: "agent", name: "Summarizer" },
];
const NOTES = ["A.md", "B.md", "C.md"] as FilePath[];

/** A write by an author, edited from a revision of the note they once read; or an undo of an earlier change. */
type Step = { op: "write"; by: number; note: number; base: number; at: number; cut: number; add: string[] } | { op: "undo"; by: number; pick: number };

const steps = (r: Rng): Step[] => {
  const notes = r.int(1, 3);
  return r.array(1, 30, () =>
    r.bool(0.85)
      ? { op: "write", by: r.int(0, 1), note: r.int(0, notes - 1), base: r.int(0, 9), at: r.int(0, 9), cut: r.int(0, 2), add: r.array(0, 3, () => r.pick([...VOCAB, "four", "five"])) }
      : { op: "undo", by: r.int(0, 1), pick: r.int(0, 99) },
  );
};

test("two authors writing from stale revisions, and undoing, keep revisions rising and every revision readable as it was written", () => {
  forAll(
    steps,
    (s) => {
      const files = new Files(memoryDb(), () => 1000);
      const wrote = new Map<number, { path: FilePath; text: string }>();
      const read = AUTHORS.map(() => new Map<FilePath, number[]>(NOTES.map((p) => [p, [0]])));
      let newest = 0;
      const saved = (by: number, before: WorkspaceFile | null, file: WorkspaceFile) => {
        assert.deepEqual(files.read(file.path), file, "the file a write returns is the note's newest");
        if (file.revision === before?.revision) assert.equal(file.text, before.text, "a write that records nothing leaves the note as it was");
        else {
          assert.ok(file.revision > newest, `revision ${file.revision} comes after ${newest}`);
          assert.equal(files.recent({ limit: 1 })[0].revision, file.revision, "it's the workspace's newest change");
          newest = file.revision;
          wrote.set(file.revision, { path: file.path, text: file.text });
        }
        read[by].get(file.path)!.push(file.revision);
      };
      for (const step of s) {
        if (step.op === "write") {
          const path = NOTES[step.note];
          const seen = read[step.by].get(path)!;
          const base = seen[step.base % seen.length];
          const lines = (base ? wrote.get(base)!.text : "").split("\n");
          lines.splice(step.at % (lines.length + 1), step.cut, ...step.add);
          const before = files.read(path);
          const result = files.write({ path, text: lines.join("\n"), base, author: AUTHORS[step.by] });
          if (result.status !== "conflict") saved(step.by, before, result.file);
          else {
            assert.deepEqual(files.read(path), before, "a conflict changes nothing");
            if (before) read[step.by].get(path)!.push(before.revision);
          }
        } else {
          const revisions = [...wrote.keys()];
          if (!revisions.length) continue;
          const revision = revisions[step.pick % revisions.length];
          const before = files.read(wrote.get(revision)!.path);
          const [result] = files.undo([revision], AUTHORS[step.by]);
          if (result.status === "undone") saved(step.by, before, result.file!);
          else assert.deepEqual(files.read(wrote.get(revision)!.path), before, `an undo that's ${result.status} changes nothing`);
        }
      }
      for (const [revision, { path, text }] of wrote) assert.equal(files.versionAt(path, revision), text, `${path} at revision ${revision}`);
      assert.deepEqual(
        files.recent({ limit: 500 }).map((c) => c.revision),
        [...wrote.keys()].sort((a, b) => b - a),
        "recent lists every change, newest first",
      );
    },
    { runs: 60 },
  );
});
