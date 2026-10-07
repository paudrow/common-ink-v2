import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { runOperation, type OperationName } from "../worker/src/operations.ts";
import { mergePins } from "../worker/src/pins.ts";
import { memoryStore } from "./store.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const claude: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };

async function run(store: ReturnType<typeof memoryStore>, name: OperationName, args: Record<string, unknown>, author: Author = ada) {
  const out = await runOperation(name, args, store, author);
  return (out.ok ? out.value : { error: out.error }) as Record<string, unknown>;
}

function workspace() {
  const store = memoryStore();
  for (const path of ["A.md", "B.md", "C.md"]) store.files.write({ path: path as FilePath, text: `# ${path}\nlaunch`, base: 0, author: ada });
  return store;
}

test("pinning writes the pins file as one change, in the order pinned, and is:pinned finds them", async () => {
  const store = workspace();
  assert.deepEqual((await run(store, "pin", { paths: ["C.md", "A.md"] }, claude)).pinned, ["C.md", "A.md"]);
  assert.deepEqual((await run(store, "pin", { paths: ["B.md", "C.md"] })).pinned, ["C.md", "A.md", "B.md"], "new pins go after, and a pinned one stays where it is");
  assert.equal(store.files.read(".common-ink/pins.json" as FilePath)?.text, '{\n  "pinned": [\n    "C.md",\n    "A.md",\n    "B.md"\n  ]\n}\n');
  const found = (await run(store, "search", { query: "is:pinned sort:title" })) as { results: Array<{ path: string; pinned?: true }> };
  assert.deepEqual(found.results.map((r) => [r.path, r.pinned]), [["A.md", true], ["B.md", true], ["C.md", true]]);
  const rest = (await run(store, "search", { query: "-is:pinned" })) as { results: Array<{ path: string }> };
  assert.deepEqual(rest.results, []);
  assert.deepEqual(await run(store, "pin", { paths: ["Nowhere.md"] }), { error: "There's no note at Nowhere.md" });
});

test("undoing a pin unpins, and unpin takes notes out, keeping the others' order", async () => {
  const store = workspace();
  const done = await run(store, "pin", { paths: ["A.md", "B.md", "C.md"] });
  assert.deepEqual((await run(store, "unpin", { paths: ["B.md"] })).pinned, ["A.md", "C.md"]);
  await run(store, "undo", { revisions: [done.revision] });
  assert.deepEqual(((await run(store, "search", { query: "is:pinned" })) as { results: unknown[] }).results, []);
});

test("pins merge as an ordered set: an older write keeps others' pins and unpins", () => {
  const base = '{"pinned":["A.md","B.md"]}';
  const theirs = '{"pinned":["A.md","B.md","C.md"]}';
  const mine = '{"pinned":["B.md","D.md"]}';
  assert.deepEqual(JSON.parse(mergePins(mine, base, theirs)!).pinned, ["B.md", "C.md", "D.md"]);
});
