// Rules from PRINCIPLES.md and the project's conventions, checked over every tracked file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && fs.existsSync(path.join(root, f)));

test("no YAML, except the workflow and Dependabot files GitHub reads only as YAML", () => {
  const yaml = files.filter((f) => /\.ya?ml$/.test(f) && !f.startsWith(".github/"));
  assert.deepEqual(yaml, []);
});

test("no markdown file starts with frontmatter", () => {
  const withFrontmatter = files.filter((f) => f.endsWith(".md") && fs.readFileSync(path.join(root, f), "utf8").startsWith("---"));
  assert.deepEqual(withFrontmatter, []);
});

test("the product is called Common Ink everywhere", () => {
  const oldName = new RegExp(`\\b${["qu", "ire"].join("")}\\b`, "i");
  const named = files.filter((f) => f !== "package-lock.json" && (oldName.test(f) || oldName.test(fs.readFileSync(path.join(root, f), "utf8"))));
  assert.deepEqual(named, []);
});

test("every stylesheet's braces balance, so no rule swallows the ones after it", () => {
  for (const f of files.filter((f) => f.endsWith(".css"))) {
    let depth = 0;
    for (const ch of fs.readFileSync(path.join(root, f), "utf8")) {
      depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      assert.ok(depth >= 0, `${f} closes a brace it never opened`);
    }
    assert.equal(depth, 0, `${f} leaves a brace open`);
  }
});
