// The Google Calendar data source end to end, against the fake Calendar API: full and incremental
// sync, 410 Gone, pushes with etags, the three scopes on a series, conflicts, and invalid_grant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeGoogle } from "../worker/src/fake-google.ts";
import { authorKey, type Author } from "../worker/src/files.ts";
import { DATA_SCOPES } from "../worker/src/google.ts";
import { runOperation } from "../worker/src/operations.ts";
import { recordPath } from "../worker/src/records.ts";
import type { Occurrence } from "../worker/src/calendar.ts";
import { memoryStore } from "./store.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const LA = "America/Los_Angeles";

/** Ada's Google: a primary calendar in Los Angeles, a shared one she can only read, and one she can only see free/busy times of. */
function google() {
  const fake = new FakeGoogle();
  fake.addCalendar({ id: "ada@example.com", summary: "Ada", primary: true, accessRole: "owner", backgroundColor: "#4F6BD8", timeZone: LA });
  fake.addCalendar({ id: "team@group.calendar.google.com", summary: "Team", accessRole: "reader", backgroundColor: "#2f9e44", timeZone: "UTC", selected: false });
  fake.addCalendar({ id: "boss@example.com", summary: "Boss", accessRole: "freeBusyReader" });
  fake.put("ada@example.com", { id: "standup", summary: "Standup", start: { dateTime: "2026-10-05T09:00:00-07:00", timeZone: LA }, end: { dateTime: "2026-10-05T09:15:00-07:00", timeZone: LA }, recurrence: ["RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=America/Los_Angeles:20261008T090000"] });
  fake.put("ada@example.com", { id: "standup_20261006T160000Z", summary: "Standup (late)", recurringEventId: "standup", originalStartTime: { dateTime: "2026-10-06T09:00:00-07:00", timeZone: LA }, start: { dateTime: "2026-10-06T10:00:00-07:00", timeZone: LA }, end: { dateTime: "2026-10-06T10:15:00-07:00", timeZone: LA } });
  fake.put("ada@example.com", { id: "standup_20261007T160000Z", status: "cancelled", recurringEventId: "standup", originalStartTime: { dateTime: "2026-10-07T09:00:00-07:00", timeZone: LA } });
  fake.put("ada@example.com", { id: "dentist", summary: "Dentist", location: "12 High Street", start: { dateTime: "2026-10-06T21:30:00Z" }, end: { dateTime: "2026-10-06T22:15:00Z" } });
  fake.put("team@group.calendar.google.com", { id: "offsite", summary: "Offsite", start: { date: "2026-10-08" }, end: { date: "2026-10-10" } });
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, fake.fetch);
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  return { fake, store };
}

const op = async (store: ReturnType<typeof memoryStore>, name: Parameters<typeof runOperation>[0], args: Record<string, unknown>) => {
  const result = await runOperation(name, args, store, ada);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const week = { from: "2026-10-05T00:00:00-07:00", to: "2026-10-12T00:00:00-07:00", zone: LA };
const listed = async (store: ReturnType<typeof memoryStore>) => ((await op(store, "list_events", week)) as Occurrence[]).map((o) => `${o.start.slice(0, 16)} ${o.title}`);

test("a first sync brings in calendars and events as records by the sync, series, changes and cancellations included", async () => {
  const { store } = google();
  const state = (await op(store, "sync_calendar", {})) as { state: string; calendars: number; events: number };
  assert.deepEqual([state.state, state.calendars, state.events], ["ok", 2, 5]);
  assert.deepEqual(await op(store, "list_calendars", {}), [
    { id: "primary", title: "Ada", color: "#4f6bd8", primary: true, writable: true, timeZone: LA },
    { id: "team@group.calendar.google.com", title: "Team", color: "#2f9e44", writable: false, timeZone: "UTC", selected: false },
  ]);
  assert.deepEqual(await listed(store), [
    "2026-10-05T16:00 Standup",
    "2026-10-06T17:00 Standup (late)",
    "2026-10-06T21:30 Dentist",
    "2026-10-08 Offsite",
    "2026-10-09T16:00 Standup",
  ]);
  const path = recordPath({ source: "google", kind: "event", collection: "primary", id: "dentist" });
  assert.equal(JSON.parse(store.files.read(path)!.text).start, "2026-10-06T14:30:00", "a time Google gives in UTC is kept as a wall time in its calendar's zone");
  assert.equal(JSON.parse(store.files.read(path)!.text).timeZone, LA);
  assert.deepEqual(store.files.recent({ path }).map((c) => authorKey(c.author)), ["sync:google-calendar"]);
});

test("later syncs bring in only what changed, by sync token, and a 410 starts again from nothing", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, summary: "Dentist (cleaning)" });
  fake.remove("ada@example.com", "standup");
  await op(store, "sync_calendar", { force: true });
  assert.ok(fake.calls.some((c) => c.includes("/calendars/primary/events?") && c.includes("syncToken=")), "an incremental sync");
  assert.deepEqual(await listed(store), ["2026-10-06T21:30 Dentist (cleaning)", "2026-10-08 Offsite"], "the series went, with its changed occurrence");
  fake.expireSyncTokens();
  fake.put("team@group.calendar.google.com", { id: "retro", summary: "Retro", start: { date: "2026-10-09" }, end: { date: "2026-10-10" } });
  const offsite = fake.event("team@group.calendar.google.com", "offsite")!;
  fake.put("team@group.calendar.google.com", { ...offsite, status: "cancelled" });
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(await listed(store), ["2026-10-06T21:30 Dentist (cleaning)", "2026-10-09 Retro"], "a full sync dropped what Google no longer has");
});

test("edits go to Google with our ids and etags, one occurrence, this and following, and all", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  const made = (await op(store, "create_event", { title: "Lunch", start: "2026-10-07T12:00", timeZone: LA })) as { address: string; status: string };
  assert.equal(made.status, "saved");
  const id = made.address.split("/").at(-1)!;
  assert.deepEqual(fake.event("ada@example.com", id)?.start, { dateTime: "2026-10-07T12:00:00", timeZone: LA, date: null });
  await op(store, "update_event", { address: "event:google/primary/standup_20261005T160000Z", title: "Kickoff", scope: "this" });
  assert.equal(fake.event("ada@example.com", "standup_20261005T160000Z")?.summary, "Kickoff", "Google made the occurrence and changed it");
  await op(store, "update_event", { address: "event:google/primary/standup_20261009T160000Z", location: "Room 4", scope: "following" });
  assert.deepEqual(fake.event("ada@example.com", "standup")?.recurrence, ["RRULE:FREQ=DAILY;COUNT=4", "EXDATE;TZID=America/Los_Angeles:20261008T090000"]);
  await op(store, "delete_event", { address: "event:google/primary/dentist" });
  assert.equal(fake.event("ada@example.com", "dentist")?.status, "cancelled");
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(await listed(store), [
    "2026-10-05T16:00 Kickoff",
    "2026-10-06T17:00 Standup (late)",
    "2026-10-07T19:00 Lunch",
    "2026-10-08 Offsite",
    "2026-10-09T16:00 Standup",
  ]);
  assert.equal(((await op(store, "read_event", { address: "event:google/primary/standup_20261009T160000Z" })) as { event: { location?: string } } | null)?.event.location, undefined, "the split-off series has the location, not the old one");
  const team = await runOperation("update_event", { address: "event:google/team%40group.calendar.google.com/offsite", title: "x" }, store, ada);
  assert.deepEqual(team, { ok: false, error: "Team can't be changed here" });
});

test("when Google changed an event too, the edits merge field by field, and Google's wins where both changed one thing", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, location: "14 High Street" });
  await op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (Dr Lee)" });
  assert.deepEqual([fake.event("ada@example.com", "dentist")?.summary, fake.event("ada@example.com", "dentist")?.location], ["Dentist (Dr Lee)", "14 High Street"]);
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, summary: "Dentist (moved)" });
  await op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (mine)" });
  assert.equal(fake.event("ada@example.com", "dentist")?.summary, "Dentist (moved)");
  const state = store.sources.status("ada@example.com").sources[0];
  assert.equal(state.conflict, "Dentist (moved): Google's title replaced yours, which is still in its history");
  const path = recordPath({ source: "google", kind: "event", collection: "primary", id: "dentist" });
  assert.ok(store.files.recent({ path }).some((c) => store.files.versionAt(path, c.revision)?.includes('"title": "Dentist (mine)"')), "ours is in history");
});

test("when Google ends our access, edits wait with a reconnect state, and go once you reconnect", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  fake.revoked = true;
  const waiting = (await op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (waiting)" })) as { status: string; error: string };
  assert.equal(waiting.status, "queued");
  assert.match(waiting.error, /Google ended Common Ink's access to your calendar/);
  const state = store.sources.status("ada@example.com").sources[0];
  assert.deepEqual([state.state, state.pending], ["needs-reconnect", 1]);
  assert.equal((await op(store, "sync_calendar", { force: true }) as { state: string }).state, "needs-reconnect");
  fake.revoked = false;
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh-2", scopes: DATA_SCOPES });
  const after = (await op(store, "sync_calendar", { force: true })) as { state: string; pending: number };
  assert.deepEqual([after.state, after.pending], ["ok", 0]);
  assert.equal(fake.event("ada@example.com", "dentist")?.summary, "Dentist (waiting)");
});

test("a sync leaves an event with an edit waiting to go out as it is here", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  fake.revoked = true;
  await op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (mine)" });
  fake.revoked = false;
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, location: "Moved" });
  // Reconnected, but not yet flushed: a sync that only pulls must not undo the waiting edit.
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh-2", scopes: DATA_SCOPES });
  await store.sources.sync();
  assert.equal(fake.event("ada@example.com", "dentist")?.summary, "Dentist (mine)");
  assert.equal(fake.event("ada@example.com", "dentist")?.location, "Moved", "Google's change merged in");
});
