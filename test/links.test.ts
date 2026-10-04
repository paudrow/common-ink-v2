import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotePath } from "../worker/src/notes.ts";
import { noteLinkAt, notePathFor } from "../web/src/links.ts";

const from = "Projects/Plan.md" as NotePath;

test(":e takes a note's name with or without .md", () => {
  assert.equal(notePathFor("Ideas"), "Ideas.md");
  assert.equal(notePathFor("Ideas.md"), "Ideas.md");
  assert.equal(notePathFor(" Projects/Plan "), "Projects/Plan.md");
  assert.equal(notePathFor("https://example.com"), null);
  assert.equal(notePathFor(""), null);
});

test("gd follows a [[link]] from the top of the workspace", () => {
  const line = "See [[Reading list]] and [[Projects/Plan|the plan]].";
  assert.equal(noteLinkAt(line, 4, from), "Reading list.md");
  assert.equal(noteLinkAt(line, 19, from), "Reading list.md");
  assert.equal(noteLinkAt(line, 30, from), "Projects/Plan.md");
  assert.equal(noteLinkAt(line, 2, from), null);
  assert.equal(noteLinkAt(line, 20, from), null);
});

test("gd follows a markdown link relative to the note it's in", () => {
  assert.equal(noteLinkAt("[budget](Budget.md)", 3, from), "Projects/Budget.md");
  assert.equal(noteLinkAt("[home](../Welcome.md)", 3, from), "Welcome.md");
  assert.equal(noteLinkAt("[list](Reading%20list.md)", 3, from), "Projects/Reading list.md");
  assert.equal(noteLinkAt("[list](<../Reading list.md>)", 3, from), "Reading list.md");
  assert.equal(noteLinkAt("[site](https://example.com)", 3, from), null);
});
