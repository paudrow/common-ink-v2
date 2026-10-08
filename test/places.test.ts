import assert from "node:assert/strict";
import { test } from "node:test";
import { GO_KEYS, savedOf } from "../worker/src/places.ts";

test("saved searches are places.json's named queries, in the order written, and a broken file has none", () => {
  assert.deepEqual(savedOf('{"bar": ["feed"], "saved": {"Agent edits": "from:agent edited:<7d", "Projects": "in:Projects/"}}'), [
    { name: "Agent edits", query: "from:agent edited:<7d" },
    { name: "Projects", query: "in:Projects/" },
  ]);
  assert.deepEqual(savedOf('{"saved": {"Empty": "", "Not text": 3, "": "x", "Ok": " launch "}}'), [{ name: "Ok", query: "launch" }]);
  for (const text of ["", "{ broken", "[]", '{"saved": []}']) assert.deepEqual(savedOf(text), [], text);
});

test("the go keys name the places they go to, one key each", () => {
  assert.deepEqual(GO_KEYS, { f: "feed", "/": "search", d: "daily.today", t: "tasks.tasks", c: "calendar.calendar", a: "view:archive", x: "view:trash", s: "data-sources.sources", e: "extensions", ",": "settings" });
});
