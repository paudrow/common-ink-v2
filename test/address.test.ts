import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import { fileFromUrl, urlForFile } from "../web/src/address.ts";

test("the address names any File exactly, and reads back the same", () => {
  for (const path of ["Reading list.md", "Projects/Q4 plan.md", ".common-ink/users/preview@common-ink/settings.json", ".common-ink/layout.json"] as FilePath[]) {
    assert.equal(fileFromUrl(urlForFile(path)), path);
  }
});

test("older ?note= links still work, and nothing is guessed", () => {
  assert.equal(fileFromUrl("?note=Welcome.md"), "Welcome.md");
  assert.equal(fileFromUrl("?note=.common-ink%2Fsettings.json"), ".common-ink/settings.json");
  assert.equal(fileFromUrl("?file=Welcome"), null, "no .md is added");
  assert.equal(fileFromUrl("?file=..%2Fsecret.md"), null);
  assert.equal(fileFromUrl(""), null);
});
