import assert from "node:assert/strict";
import { test } from "node:test";
import { attrsRecord, directiveText, parseAttrs, parseDirectiveLine, serializeAttrs, withValues } from "../web/src/directives.ts";

test("a directive's attributes read in order, quoted or bare, and a bare key is true", () => {
  const attrs = parseAttrs(`duration=25m label="Deep work" note='a "quote"' muted`);
  assert.deepEqual(attrsRecord(attrs), { duration: "25m", label: "Deep work", note: 'a "quote"', muted: "true" });
  assert.deepEqual(
    attrs.map((a) => a.quote),
    ["", '"', "'", ""],
  );
  assert.deepEqual(parseDirectiveLine('::timer{duration=25m label="Focus"}'), { kind: "leaf", name: "timer", attrs: parseAttrs('duration=25m label="Focus"') });
  assert.deepEqual(parseDirectiveLine(":::kanban"), { kind: "open", name: "kanban", attrs: [] });
  assert.equal(parseDirectiveLine("::timer{duration=25m} and more"), null, "a directive is a line of its own");
  assert.equal(parseDirectiveLine(":::"), null);
});

test("written again, attributes keep their order and quotes; new ones go before id; a blank takes one out", () => {
  const attrs = parseAttrs(`label='Deep work' duration=25m id=tea`);
  assert.equal(serializeAttrs(withValues(attrs, { duration: "50m" })), "label='Deep work' duration=50m id=tea");
  assert.equal(serializeAttrs(withValues(attrs, { duration: undefined, sound: "bell" })), "label='Deep work' sound=bell id=tea");
  assert.equal(serializeAttrs(withValues(attrs, { label: "" })), "duration=25m id=tea");
  assert.equal(serializeAttrs(withValues([], { label: "Two words", at: "07:30", folder: "Projects/Work" })), 'label="Two words" at=07:30 folder=Projects/Work', "quotes only where they're needed");
  assert.equal(serializeAttrs(withValues(parseAttrs(`label="x"`), { label: 'say "hi"' })), `label="say 'hi'"`, "a value can't hold its own quote");
  assert.equal(directiveText("::", { name: "timer", attrs: [] }), "::timer");
  assert.equal(directiveText(":::", { name: "kanban", attrs: parseAttrs("done=Shipped") }), ":::kanban{done=Shipped}");
});
