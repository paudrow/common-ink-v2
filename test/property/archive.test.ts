import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../../worker/src/files.ts";
import { runOperation } from "../../worker/src/operations.ts";
import { memoryStore } from "../store.ts";
import { forAll, type Rng } from "./gen.ts";

const NOTES = ["a.md", "b.md", "c.md", "d.md"];
const AUTHORS: Author[] = [{ kind: "user", email: "ada@example.com" }, { kind: "agent", name: "Claude", by: "ada@example.com" }];

type Step = { op: "archive" | "unarchive"; path: string; author: number } | { op: "undo"; which: number; author: number };
const step = (r: Rng): Step => (r.bool(0.3) ? { op: "undo", which: r.int(0, 20), author: r.int(0, 1) } : { op: r.pick(["archive", "unarchive"] as const), path: r.pick(NOTES), author: r.int(0, 1) });

test("archive changes compose as a set: undoing any of them never clashes, and takes back only its own path", async () => {
  const cases: Step[][] = [];
  forAll((r) => r.array(1, 25, step), (steps) => void cases.push(steps), { runs: 300 });
  for (const steps of cases) {
    const store = memoryStore();
    for (const p of NOTES) store.files.write({ path: p as FilePath, text: `# ${p}`, base: 0, author: AUTHORS[0] });
    const model = new Set<string>();
    const done: Array<{ revision: number; path: string; archived: boolean; undone: boolean }> = [];
    for (const s of steps) {
      if (s.op === "undo") {
        const target = done.filter((d) => !d.undone)[s.which];
        if (!target) continue;
        const out = await runOperation("undo", { revisions: [target.revision] }, store, AUTHORS[s.author]);
        assert.ok(out.ok);
        const [result] = out.value as Array<{ status: string }>;
        assert.notEqual(result.status, "conflict", JSON.stringify(steps));
        target.undone = true;
        if (target.archived) model.delete(target.path);
        else model.add(target.path);
      } else {
        const out = await runOperation(s.op, { paths: [s.path] }, store, AUTHORS[s.author]);
        assert.ok(out.ok, JSON.stringify(out));
        const { revision } = out.value as { revision: number | null };
        if (revision !== null) done.push({ revision, path: s.path, archived: s.op === "archive", undone: false });
        if (s.op === "archive") model.add(s.path);
        else model.delete(s.path);
      }
      const listed = await runOperation("list_files", {}, store, AUTHORS[0]);
      const archived = (listed.ok ? (listed.value as Array<{ path: string; archived?: true }>) : []).filter((f) => f.archived).map((f) => f.path);
      assert.deepEqual(archived, [...model].sort(), JSON.stringify(steps));
    }
  }
});
