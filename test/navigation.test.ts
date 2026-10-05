import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilePath } from "../worker/src/files.ts";
import { Navigation, type Place } from "../web/src/navigation.ts";

const at = (window: string, file: string, line: number, extra: Partial<Place> = {}): Place => ({ window, file: file as FilePath, pos: line * 10, line, ...extra });

test("the first place is where the page opened; a jump is a new place, a step is where you are, updated", () => {
  const nav = new Navigation();
  assert.deepEqual(nav.arrive(at("g1", "A.md", 1), true).how, "replace", "the browser's entry for the page is already there");
  assert.equal(nav.arrive(at("g1", "A.md", 5), false).how, "replace", "a step");
  assert.equal(nav.arrive(at("g1", "A.md", 9), true).how, "replace", "a jump of a few lines is still here");
  assert.equal(nav.here!.line, 9);
  assert.equal(nav.arrive(at("g1", "A.md", 40), true).how, "push", "far within the file");
  assert.equal(nav.arrive(at("g1", "B.md", 1), true).how, "push", "another file");
  assert.equal(nav.arrive(at("g2", "B.md", 1), true).how, "push", "another window");
  assert.deepEqual(nav.toJSON().visits.map((v) => [v.window, v.file, v.line]), [
    ["g1", "A.md", 9],
    ["g1", "A.md", 40],
    ["g1", "B.md", 1],
    ["g2", "B.md", 1],
  ]);
});

test("back and forward go by id, as the browser's history carries it; a jump after going back drops what was ahead", () => {
  const nav = new Navigation();
  const first = nav.arrive(at("g1", "A.md", 1), false).visit;
  const second = nav.arrive(at("g1", "B.md", 1), true).visit;
  nav.arrive(at("g1", "C.md", 1), true);
  assert.equal(nav.step(-1)!.id, second.id);
  assert.equal(nav.goTo(first.id)!.file, "A.md");
  assert.equal(nav.step(-1), null);
  assert.equal(nav.step(1)!.file, "B.md");
  const d = nav.arrive(at("g1", "D.md", 1), true).visit;
  assert.equal(nav.step(1), null, "B and C are gone");
  assert.equal(nav.goTo(second.id), null);
  assert.equal(nav.step(-1)!.id, first.id);
  assert.ok(d.id > second.id, "ids are never reused, so an old browser entry can't land somewhere else");
});

test("kept across a reload: the places, where you are, and ids that carry on", () => {
  const nav = new Navigation();
  nav.arrive(at("g1", "A.md", 1), false);
  const b = nav.arrive(at("g1", "B.md", 1), true).visit;
  const again = new Navigation(JSON.parse(JSON.stringify(nav)));
  assert.equal(again.here!.id, b.id);
  assert.equal(again.step(-1)!.file, "A.md");
  assert.ok(again.arrive(at("g1", "C.md", 1), true).visit.id > b.id);
  assert.equal(new Navigation({ visits: [], at: 3 }).here, null, "a broken one starts afresh");
});
