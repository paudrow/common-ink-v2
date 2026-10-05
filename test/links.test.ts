import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import { linkAt, noteLinkAt, notePathFor } from "../web/src/links.ts";

const from = "Projects/Plan.md" as FilePath;

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

test("a link to a web page or an upload opens in a browser tab; one to a note opens the note", () => {
  const from = "Projects/Plan.md" as FilePath;
  assert.deepEqual(linkAt("[site](https://example.com/a)", 2, from), { url: "https://example.com/a" });
  assert.deepEqual(linkAt("![photo](/uploads/photo.png)", 3, from), { url: "/uploads/photo.png" });
  assert.deepEqual(linkAt("[[Reading list|books]]", 3, from), { note: "Reading list.md" });
  assert.equal(linkAt("[odd](mailto:x@example.com)", 2, from), null);
});
