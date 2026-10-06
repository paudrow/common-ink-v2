// Days people see are their own local days, not UTC's: in Chicago at 9 PM on Oct 5 it's 2 AM on Oct 6 in UTC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago } from "../web/src/describe.ts";
import { dayOfOccurrence } from "../web/src/extensions/calendar/links.ts";

function inZone(zone: string, check: () => void) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    check();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

const NINE_PM_CHICAGO = Date.parse("2026-10-06T02:00:00Z");

test("History says when a change older than a day was made by its local day", () => {
  inZone("America/Chicago", () => assert.equal(ago(NINE_PM_CHICAGO, NINE_PM_CHICAGO + 2 * 86_400_000), "2026-10-05"));
  inZone("Asia/Tokyo", () => assert.equal(ago(Date.parse("2026-10-05T20:00:00Z"), Date.parse("2026-10-08T00:00:00Z")), "2026-10-06"));
});

test("an occurrence's day, when its event can't be read, is the local day it starts on", () => {
  inZone("America/Chicago", () => {
    assert.equal(dayOfOccurrence({ allDay: false, start: "2026-10-06T02:00:00.000Z" }), "2026-10-05");
    assert.equal(dayOfOccurrence({ allDay: true, start: "2026-10-06" }), "2026-10-06");
  });
});
