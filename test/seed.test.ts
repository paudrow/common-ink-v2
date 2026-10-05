import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSeed, fillDates, readSections, tryThisPr } from "../scripts/seed.ts";

function examples(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "common-ink-seed-"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test("this repo's examples/preview files are well formed", () => {
  const sections = readSections(path.resolve(import.meta.dirname, "../examples/preview"));
  assert.ok(sections.length > 0);
});

test("a section's notes come from its folder", () => {
  const dir = examples({
    "notes.json": JSON.stringify({ pr: 2, title: "Notes", steps: ["Write one"] }),
    "notes/Ideas.md": "# Ideas\n",
    "notes/picture.png": "not a note",
  });
  assert.deepEqual(readSections(dir), [{ slug: "notes", pr: 2, title: "Notes", steps: ["Write one"], notes: [{ path: "Ideas.md", text: "# Ideas\n" }], edits: [] }]);
});

test("a malformed section is an error that names its file", () => {
  const dir = examples({ "broken.json": JSON.stringify({ pr: "2", title: "Broken", steps: [] }) });
  assert.throws(() => readSections(dir), /broken\.json/);
});

test("Try this PR lists this PR's steps first, then the rest newest first", () => {
  const sections = [
    { slug: "a", pr: 4, title: "Scaffold", steps: ["Open it"], notes: [], edits: [] },
    { slug: "b", pr: 5, title: "Storage", steps: ["Save", "Reload"], notes: [], edits: [] },
    { slug: "c", pr: 6, title: "Editor", steps: ["Type"], notes: [], edits: [] },
  ];
  assert.equal(
    tryThisPr(sections, { number: 5, title: "Storage", url: "https://github.com/o/r/pull/5", sha: "0123456789abcdef" }),
    [
      "# Try this PR (#5)",
      "",
      "**Storage** · [open the pull request](https://github.com/o/r/pull/5) · deployed from `0123456`",
      "",
      "This Preview has its own notes. Change anything: each deploy adds back missing sample notes and rewrites this one.",
      "",
      "## Storage (#5)",
      "",
      "1. Save",
      "2. Reload",
      "",
      "## Editor (#6)",
      "",
      "1. Type",
      "",
      "## Scaffold (#4)",
      "",
      "1. Open it",
      "",
    ].join("\n"),
  );
});

test("the seed keeps sample notes and replaces Try this PR, and its id follows its content", () => {
  const sections = [{ slug: "a", pr: 4, title: "Scaffold", steps: ["Open it"], notes: [{ path: "Welcome.md", text: "# Welcome\n" }], edits: [] }];
  const seed = buildSeed(sections, { number: 4 });
  assert.deepEqual(
    seed.notes.map((n) => [n.path, n.replace]),
    [
      ["Welcome.md", false],
      ["Try this PR.md", true],
    ],
  );
  assert.equal(buildSeed(sections, { number: 4 }).id, seed.id);
  assert.notEqual(buildSeed(sections, { number: 4, sha: "abc" }).id, seed.id);
});

test("sample notes can say dates relative to the day the Preview deploys", () => {
  assert.equal(fillDates("due:{{today}} due:{{today+3}} due:{{today-1}}", "2026-12-30"), "due:2026-12-30 due:2027-01-02 due:2026-12-29");
});
