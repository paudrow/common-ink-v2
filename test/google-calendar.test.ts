// The Google Calendar data source end to end, against the fake Calendar API: full and incremental
// sync, 410 Gone, pushes with etags, the three scopes on a series, conflicts, and invalid_grant.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeGoogle, sampleGoogle } from "../worker/src/fake-google.ts";
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

test("saving a series from the editor with its times as they were keeps its changed occurrences in Google", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  // What the editor sends on Save: every field, times and repeat as they were.
  await op(store, "update_event", {
    address: "event:google/primary/standup_20261005T160000Z",
    scope: "all",
    title: "Daily sync",
    allDay: false,
    start: "2026-10-05T09:00",
    end: "2026-10-05T09:15",
    timeZone: LA,
    location: null,
    description: null,
    recurrence: ["RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=America/Los_Angeles:20261008T090000"],
  });
  const late = fake.event("ada@example.com", "standup_20261006T160000Z");
  assert.deepEqual([late?.summary, late?.status], ["Standup (late)", "confirmed"]);
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(await listed(store), [
    "2026-10-05T16:00 Daily sync",
    "2026-10-06T17:00 Standup (late)",
    "2026-10-06T21:30 Dentist",
    "2026-10-08 Offsite",
    "2026-10-09T16:00 Daily sync",
  ]);
});

test("edits that waited for Google all keep what Google changed meanwhile", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  fake.revoked = true;
  await op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (Dr Lee)" });
  await op(store, "update_event", { address: "event:google/primary/dentist", location: "Room 4" });
  fake.revoked = false;
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, description: "Bring forms" });
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh-2", scopes: DATA_SCOPES });
  await store.sources.sync();
  const g = fake.event("ada@example.com", "dentist")!;
  assert.deepEqual([g.summary, g.location, g.description], ["Dentist (Dr Lee)", "Room 4", "Bring forms"]);
  const here = ((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { title: string; location?: string; description?: string } }).event;
  assert.deepEqual([here.title, here.location, here.description], ["Dentist (Dr Lee)", "Room 4", "Bring forms"]);
});

test("an edit Google refuses goes back to how Google has it, says why, and doesn't hold up the edits after it", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  fake.refusing.set("dentist", "Invalid value for: summary");
  const refused = await runOperation("update_event", { address: "event:google/primary/dentist", title: "Dentist (Dr Lee)" }, store, ada);
  const why = "Google Calendar refused the change to Dentist (Dr Lee): Invalid value for: summary. It's back as it was, and the change is in its history.";
  assert.deepEqual(refused, { ok: false, error: why });
  assert.equal(((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { title: string } }).event.title, "Dentist");
  await op(store, "update_event", { address: "event:google/primary/standup_20261005T160000Z", title: "Kickoff", scope: "this" });
  assert.equal(fake.event("ada@example.com", "standup_20261005T160000Z")?.summary, "Kickoff");
  const state = store.sources.status("ada@example.com").sources[0];
  assert.deepEqual([state.state, state.pending, state.conflict], ["ok", 0, why]);
});

test("edits made at once go to Google once each, in order", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  const before = fake.calls.length;
  await Promise.all([
    op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (Dr Lee)" }),
    op(store, "update_event", { address: "event:google/primary/standup_20261005T160000Z", title: "Kickoff", scope: "this" }),
  ]);
  assert.deepEqual(
    fake.calls.slice(before).filter((c) => !c.startsWith("POST /token")),
    ["PATCH /calendar/v3/calendars/primary/events/dentist", "PATCH /calendar/v3/calendars/primary/events/standup_20261005T160000Z"],
  );
});

test("moving a whole series a day moves changed occurrences next to each other along, and Google keeps both", async () => {
  const { fake, store } = google();
  const at = (day: string, time: string) => ({ dateTime: `2026-10-${day}T${time}:00`, timeZone: LA });
  fake.put("ada@example.com", { id: "sync", summary: "Sync", start: at("12", "08:00"), end: at("12", "08:30"), recurrence: ["RRULE:FREQ=DAILY;COUNT=4"] });
  fake.put("ada@example.com", { id: "sync_20261013T150000Z", summary: "Sync (Tue)", recurringEventId: "sync", originalStartTime: at("13", "08:00"), start: at("13", "08:00"), end: at("13", "08:30") });
  fake.put("ada@example.com", { id: "sync_20261014T150000Z", summary: "Sync (Wed)", recurringEventId: "sync", originalStartTime: at("14", "08:00"), start: at("14", "08:00"), end: at("14", "08:30") });
  await op(store, "sync_calendar", {});
  await op(store, "update_event", { address: "event:google/primary/sync_20261012T150000Z", start: "2026-10-13T08:00", scope: "all", zone: LA });
  const there = (id: string) => [fake.event("ada@example.com", id)?.summary, fake.event("ada@example.com", id)?.status];
  assert.deepEqual(there("sync_20261014T150000Z"), ["Sync (Tue)", "confirmed"], "Tuesday's change is on Wednesday now");
  assert.deepEqual(there("sync_20261015T150000Z"), ["Sync (Wed)", "confirmed"], "Wednesday's is on Thursday");
  await op(store, "sync_calendar", { force: true });
  const next = { from: "2026-10-12T00:00:00-07:00", to: "2026-10-19T00:00:00-07:00", zone: LA };
  assert.deepEqual(((await op(store, "list_events", next)) as Occurrence[]).map((o) => `${o.start.slice(0, 16)} ${o.title}`), [
    "2026-10-13T15:00 Sync",
    "2026-10-14T15:00 Sync (Tue)",
    "2026-10-15T15:00 Sync (Wed)",
    "2026-10-16T15:00 Sync",
  ]);
});

test("undoing a change to one occurrence puts it back as its series has it, in Google too", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  await op(store, "update_event", { address: "event:google/primary/standup_20261009T160000Z", title: "Kickoff", scope: "this" });
  const [renamed] = store.files.recent({ limit: 1 });
  assert.deepEqual(await op(store, "undo", { revisions: [renamed.revision] }).then((r) => (r as Array<{ status: string }>).map((u) => u.status)), ["undone"]);
  const there = fake.event("ada@example.com", "standup_20261009T160000Z");
  assert.deepEqual([there?.summary, there?.status], ["Standup", "confirmed"], "Google has the occurrence back, not cancelled");
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(await listed(store), [
    "2026-10-05T16:00 Standup",
    "2026-10-06T17:00 Standup (late)",
    "2026-10-06T21:30 Dentist",
    "2026-10-08 Offsite",
    "2026-10-09T16:00 Standup",
  ]);
});

test("undoing deleting one occurrence brings it back in Google too", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  await op(store, "delete_event", { address: "event:google/primary/standup_20261009T160000Z", scope: "this" });
  assert.equal(fake.event("ada@example.com", "standup_20261009T160000Z")?.status, "cancelled");
  const [deleted] = store.files.recent({ limit: 1 });
  await op(store, "undo", { revisions: [deleted.revision] });
  assert.equal(fake.event("ada@example.com", "standup_20261009T160000Z")?.status, "confirmed");
  await op(store, "sync_calendar", { force: true });
  assert.ok((await listed(store)).includes("2026-10-09T16:00 Standup"));
});

type Edit = [Parameters<typeof runOperation>[0], Record<string, unknown>];

/**
 * Ada's own Google with one series, changed as `setup` says, then edited as `edit` says, and the
 * edit's changes undone in the batches `plan` makes of them (by default all together).
 */
async function undoAll(series: (fake: FakeGoogle) => void, edit: Edit[], setup: Edit[] = [], plan: (revisions: number[]) => number[][] = (r) => [r]) {
  const fake = new FakeGoogle();
  fake.addCalendar({ id: "ada@example.com", summary: "Ada", primary: true, accessRole: "owner", timeZone: LA });
  series(fake);
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, fake.fetch);
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  await op(store, "sync_calendar", {});
  for (const [name, args] of setup) await op(store, name, args);
  const month = { from: "2026-10-01T00:00:00-07:00", to: "2026-11-01T00:00:00-07:00", zone: LA };
  const shown = async () => ((await op(store, "list_events", month)) as Occurrence[]).map((o) => `${o.start.slice(0, 16)} ${o.title}`);
  const before = await shown();
  const since = store.files.recent({ limit: 1 })[0].revision;
  for (const [name, args] of edit) await op(store, name, args);
  const mine = store.files.recent({ limit: 100 }).filter((c) => c.revision > since && c.author.kind === "user").map((c) => c.revision);
  const statuses: string[] = [];
  for (const batch of plan(mine)) statuses.push(...((await op(store, "undo", { revisions: batch })) as Array<{ status: string }>).map((u) => u.status));
  const here = await shown();
  await op(store, "sync_calendar", { force: true });
  return { before, statuses, here, synced: await shown() };
}

const at = (day: string, time: string) => ({ dateTime: `2026-10-${day}T${time}:00`, timeZone: LA });

test("undoing a whole daily series moved two hours puts every changed and cancelled occurrence back, here and in Google", async () => {
  const run = await undoAll(
    (fake) => {
      fake.put("ada@example.com", { id: "d", summary: "Daily", start: at("05", "09:00"), end: at("05", "09:15"), recurrence: ["RRULE:FREQ=DAILY;COUNT=6"] });
      fake.put("ada@example.com", { id: "d_20261006T160000Z", summary: "Daily (late)", recurringEventId: "d", originalStartTime: at("06", "09:00"), start: at("06", "10:00"), end: at("06", "10:15") });
      fake.put("ada@example.com", { id: "d_20261007T160000Z", status: "cancelled", recurringEventId: "d", originalStartTime: at("07", "09:00") });
      fake.put("ada@example.com", { id: "d_20261008T160000Z", summary: "Daily (renamed)", recurringEventId: "d", originalStartTime: at("08", "09:00"), start: at("08", "09:00"), end: at("08", "09:15") });
    },
    [["update_event", { address: "event:google/primary/d_20261005T160000Z", start: "2026-10-05T11:00", scope: "all", zone: LA }]],
  );
  assert.ok(run.statuses.every((s) => s === "undone"), run.statuses.join());
  assert.deepEqual(run.here, run.before);
  assert.deepEqual(run.synced, run.before);
});

test("undoing a weekly series moved a day puts it back, here and in Google", async () => {
  const run = await undoAll(
    (fake) => {
      fake.put("ada@example.com", { id: "w", summary: "Weekly", start: at("05", "11:00"), end: at("05", "12:00"), recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4"] });
      fake.put("ada@example.com", { id: "w_20261012T180000Z", summary: "Weekly (changed)", recurringEventId: "w", originalStartTime: at("12", "11:00"), start: at("12", "11:00"), end: at("12", "12:00") });
      fake.put("ada@example.com", { id: "w_20261019T180000Z", status: "cancelled", recurringEventId: "w", originalStartTime: at("19", "11:00") });
    },
    [["update_event", { address: "event:google/primary/w_20261005T180000Z", start: "2026-10-06T11:00", scope: "all", zone: LA }]],
  );
  assert.deepEqual(run.here, run.before);
  assert.deepEqual(run.synced, run.before);
});

test("after renaming one occurrence and deleting another, undoing a move of their series puts them back, with no others added", async () => {
  const run = await undoAll(
    (fake) => fake.put("ada@example.com", { id: "s", summary: "Standup", start: at("05", "09:00"), end: at("05", "09:15"), recurrence: ["RRULE:FREQ=DAILY;COUNT=5"] }),
    [["update_event", { address: "event:google/primary/s_20261005T160000Z", start: "2026-10-05T11:00", scope: "all", zone: LA }]],
    [
      ["update_event", { address: "event:google/primary/s_20261007T160000Z", title: "Kickoff", scope: "this", zone: LA }],
      ["delete_event", { address: "event:google/primary/s_20261008T160000Z", scope: "this", zone: LA }],
    ],
  );
  assert.deepEqual(run.here, run.before);
  assert.deepEqual(run.synced, run.before);
});

test("a sync that was already under way when an edit went out leaves the edit as it is here", async () => {
  const { fake } = google();
  let held: Promise<void> | null = null;
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, async (input, init) => {
    const answer = await fake.fetch(input, init);
    if (held && String(input).includes("/calendars/primary/events?")) await held;
    return answer;
  });
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  await op(store, "sync_calendar", {});
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, location: "14 High Street" });
  let release!: () => void;
  held = new Promise<void>((r) => (release = r));
  const syncing = op(store, "sync_calendar", { force: true });
  await new Promise((r) => setTimeout(r, 10));
  const editing = op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (Dr Lee)" });
  await new Promise((r) => setTimeout(r, 10));
  release();
  held = null;
  await Promise.all([syncing, editing]);
  const here = ((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { title: string } }).event;
  assert.equal(here.title, "Dentist (Dr Lee)", "the page Google sent before the edit doesn't put the old title back");
  await op(store, "update_event", { address: "event:google/primary/dentist", description: "Bring forms" });
  const g = fake.event("ada@example.com", "dentist")!;
  assert.deepEqual([g.summary, g.location, g.description], ["Dentist (Dr Lee)", "14 High Street", "Bring forms"]);
  assert.equal(store.sources.status("ada@example.com").sources[0].conflict, undefined, "the next edit went with the etag Google gave ours, not the page's older one");
});

test("syncs asked for while one runs share one more after it, so they take turns and see what changed meanwhile", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  const before = fake.calls.length;
  const first = store.sources.sync();
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, summary: "Dentist (moved)" });
  const [, b, c] = await Promise.all([first, store.sources.sync(), store.sources.sync()]);
  assert.deepEqual(c, b);
  const lists = fake.calls.slice(before).map((call, i) => [call, i] as const).filter(([call]) => call.startsWith("GET /calendar/v3/users/me/calendarList"));
  assert.equal(lists.length, 2);
  const events = fake.calls.slice(before).map((call, i) => [call, i] as const).filter(([call]) => call.includes("/events?"));
  assert.ok(events.filter(([, i]) => i < lists[1][1]).length >= 2, "the second began after the first had read every calendar");
  assert.equal(((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { title: string } }).event.title, "Dentist (moved)");
});

test("an event Google changed after an edit made during a sync comes in on a later sync", async () => {
  const { fake } = google();
  let gate: Promise<void> | null = null;
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, async (input, init) => {
    if (gate && String(input).includes("/calendars/primary/events?")) await gate;
    return fake.fetch(input, init);
  });
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  await op(store, "sync_calendar", {});
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const syncing = op(store, "sync_calendar", { force: true });
  await new Promise((r) => setTimeout(r, 10));
  await op(store, "update_event", { address: "event:google/primary/dentist", location: "Room 1" });
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, location: "Room 9" });
  gate = null;
  open();
  await syncing;
  await op(store, "sync_calendar", { force: true });
  const here = ((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { location?: string } }).event;
  assert.equal(here.location, "Room 9");
});

test("the sample fake Google's week is around the day it's given, in New York, whatever the clock says", async () => {
  const fake = sampleGoogle("2026-10-05");
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, fake.fetch);
  store.sources.connect({ email: "tester@localhost", refreshToken: "fake", scopes: DATA_SCOPES });
  await store.sources.sync();
  const week = (await runOperation("list_events", { from: "2026-10-05T00:00:00-04:00", to: "2026-10-10T00:00:00-04:00", zone: "America/New_York" }, store, ada)) as { ok: true; value: Occurrence[] };
  assert.deepEqual(week.value.map((o) => `${o.start.slice(0, 16)} ${o.title}`), [
    "2026-10-05T13:00 Standup",
    "2026-10-06T13:00 Standup",
    "2026-10-06T18:30 Dentist",
    "2026-10-07T13:00 Standup",
    "2026-10-08 Offsite",
    "2026-10-08T13:00 Standup",
    "2026-10-09T13:00 Standup",
  ]);
});

test("Google's change made while our push of the same event was in flight comes in on a later sync", async () => {
  const { fake } = google();
  let failing = 2;
  let pageGate: Promise<void> | null = null;
  let openPage!: () => void;
  let pushGate: Promise<void> | null = null;
  let openPush!: () => void;
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, async (input, init) => {
    const patch = init?.method === "PATCH" && String(input).endsWith("/events/dentist");
    if (patch && failing-- > 0) return new Response("{}", { status: 503 });
    if (pageGate && String(input).includes("/calendars/primary/events?")) await pageGate;
    const answer = await fake.fetch(input, init);
    if (patch && pushGate) {
      fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, location: "Room 9" });
      openPage();
      await pushGate;
    }
    return answer;
  });
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  await op(store, "sync_calendar", {});
  assert.equal(((await op(store, "update_event", { address: "event:google/primary/dentist", title: "Dentist (Dr Lee)" })) as { status: string }).status, "queued");
  pageGate = new Promise<void>((r) => (openPage = r));
  pushGate = new Promise<void>((r) => (openPush = r));
  const syncing = store.sources.sync();
  await new Promise((r) => setTimeout(r, 10));
  const pushing = store.sources.flush("google");
  await syncing;
  pageGate = null;
  openPush();
  await pushing;
  pushGate = null;
  await store.sources.sync();
  const here = ((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { title: string; location?: string } }).event;
  assert.deepEqual([here.title, here.location], ["Dentist (Dr Lee)", "Room 9"]);
});

test("after a full sync that left an event for a change made meanwhile, the next sync is incremental and still brings Google's version", async () => {
  const { fake } = google();
  let gate: Promise<void> | null = null;
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, async (input, init) => {
    if (gate && String(input).includes("/calendars/primary/events?")) await gate;
    return fake.fetch(input, init);
  });
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  await op(store, "sync_calendar", {});
  fake.expireSyncTokens();
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const syncing = op(store, "sync_calendar", { force: true });
  await new Promise((r) => setTimeout(r, 10));
  await op(store, "update_event", { address: "event:google/primary/dentist", location: "Room 1" });
  fake.put("ada@example.com", { ...fake.event("ada@example.com", "dentist")!, location: "Room 9" });
  gate = null;
  open();
  await syncing;
  const before = fake.calls.length;
  await op(store, "sync_calendar", { force: true });
  const lists = fake.calls.slice(before).filter((c) => c.startsWith("GET /calendar/v3/calendars/primary/events?"));
  assert.ok(lists.length > 0 && lists.every((c) => c.includes("syncToken=")), `incremental: ${lists.join(", ")}`);
  const here = ((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { location?: string } }).event;
  assert.equal(here.location, "Room 9");
});

const daily = (fake: FakeGoogle) => {
  fake.put("ada@example.com", { id: "d", summary: "Daily", start: at("05", "09:00"), end: at("05", "09:15"), recurrence: ["RRULE:FREQ=DAILY;COUNT=6"] });
  fake.put("ada@example.com", { id: "d_20261006T160000Z", summary: "Daily (late)", recurringEventId: "d", originalStartTime: at("06", "09:00"), start: at("06", "10:00"), end: at("06", "10:15") });
  fake.put("ada@example.com", { id: "d_20261007T160000Z", status: "cancelled", recurringEventId: "d", originalStartTime: at("07", "09:00") });
  fake.put("ada@example.com", { id: "d_20261008T160000Z", summary: "Daily (renamed)", recurringEventId: "d", originalStartTime: at("08", "09:00"), start: at("08", "09:00"), end: at("08", "09:15") });
};
const weekly = (fake: FakeGoogle) => {
  fake.put("ada@example.com", { id: "w", summary: "Weekly", start: at("05", "11:00"), end: at("05", "12:00"), recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4"] });
  fake.put("ada@example.com", { id: "w_20261012T180000Z", summary: "Weekly (changed)", recurringEventId: "w", originalStartTime: at("12", "11:00"), start: at("12", "11:00"), end: at("12", "12:00") });
  fake.put("ada@example.com", { id: "w_20261019T180000Z", status: "cancelled", recurringEventId: "w", originalStartTime: at("19", "11:00") });
};
const moves: Array<[string, (fake: FakeGoogle) => void, Edit]> = [
  ["a daily series moved two hours", daily, ["update_event", { address: "event:google/primary/d_20261005T160000Z", start: "2026-10-05T11:00", scope: "all", zone: LA }]],
  ["a weekly series moved a day", weekly, ["update_event", { address: "event:google/primary/w_20261005T180000Z", start: "2026-10-06T11:00", scope: "all", zone: LA }]],
];
const shuffled = (revisions: number[], seed: number) => {
  const out = [...revisions];
  for (let i = out.length - 1, s = seed; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const plans: Array<[string, (revisions: number[]) => number[][]]> = [
  ["one at a time, newest first", (r) => [...r].sort((a, b) => b - a).map((x) => [x])],
  ["one at a time, oldest first", (r) => [...r].sort((a, b) => a - b).map((x) => [x])],
  ...[1, 2, 3].map((seed): [string, (r: number[]) => number[][]] => [`one at a time, shuffled (${seed})`, (r) => shuffled(r, seed).map((x) => [x])]),
  ["its occurrences first, then the series", (r) => [r.filter((x) => x !== Math.min(...r)), [Math.min(...r)]]],
];
for (const [what, series, move] of moves) {
  for (const [how, plan] of plans) {
    test(`undoing ${what} ${how} leaves it as it was, here and in Google`, async () => {
      const run = await undoAll(series, [move], [], plan);
      assert.deepEqual(run.statuses.filter((s) => s !== "undone"), []);
      assert.deepEqual(run.here, run.before);
      assert.deepEqual(run.synced, run.before);
    });
  }
}

test("a series moved, synced, undone, synced and moved again by hand ends where its first move did, here and in Google", async () => {
  const fake = new FakeGoogle();
  fake.addCalendar({ id: "ada@example.com", summary: "Ada", primary: true, accessRole: "owner", timeZone: LA });
  const at = (day: string, time: string) => ({ dateTime: `2026-10-${day}T${time}:00`, timeZone: LA });
  fake.put("ada@example.com", { id: "d", summary: "Daily", start: at("05", "09:00"), end: at("05", "09:15"), recurrence: ["RRULE:FREQ=DAILY;COUNT=6"] });
  fake.put("ada@example.com", { id: "d_20261006T160000Z", summary: "Daily (late)", recurringEventId: "d", originalStartTime: at("06", "09:00"), start: at("06", "10:00"), end: at("06", "10:15") });
  fake.put("ada@example.com", { id: "d_20261007T160000Z", status: "cancelled", recurringEventId: "d", originalStartTime: at("07", "09:00") });
  fake.put("ada@example.com", { id: "d_20261008T160000Z", summary: "Daily (renamed)", recurringEventId: "d", originalStartTime: at("08", "09:00"), start: at("08", "09:00"), end: at("08", "09:15") });
  const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, fake.fetch);
  store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
  const month = { from: "2026-10-01T00:00:00-07:00", to: "2026-11-01T00:00:00-07:00", zone: LA };
  const shown = async () => ((await op(store, "list_events", month)) as Occurrence[]).map((o) => `${o.start.slice(0, 16)} ${o.title}`);
  const move = { address: "event:google/primary/d_20261005T160000Z", start: "2026-10-05T11:00", scope: "all", zone: LA };
  await op(store, "sync_calendar", {});
  const before = await shown();
  const since = store.files.recent({ limit: 1 })[0].revision;
  await op(store, "update_event", move);
  await op(store, "sync_calendar", { force: true });
  const moved = await shown();
  const mine = store.files.recent({ limit: 100 }).filter((c) => c.revision > since && c.author.kind === "user").map((c) => c.revision);
  const undone = (await op(store, "undo", { revisions: mine })) as Array<{ status: string }>;
  assert.deepEqual(undone.filter((u) => u.status !== "undone"), []);
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(await shown(), before, "the undo, synced, is the series as it was");
  await op(store, "update_event", move);
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(await shown(), moved);
});

test("after a sync brings back Google's copy of an edit, the edit can still be undone and redone, and a made event undone", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  await op(store, "update_event", { address: "event:google/primary/standup_20261009T160000Z", title: "Kickoff", scope: "this" });
  const renamed = store.files.recent({ limit: 1 })[0].revision;
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(((await op(store, "undo", { revisions: [renamed] })) as Array<{ status: string }>).map((u) => u.status), ["undone"]);
  const undo = store.files.recent({ limit: 1 })[0].revision;
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(((await op(store, "undo", { revisions: [undo] })) as Array<{ status: string }>).map((u) => u.status), ["undone"], "redo");
  assert.equal(fake.event("ada@example.com", "standup_20261009T160000Z")?.summary, "Kickoff");
  const made = (await op(store, "create_event", { title: "Lunch", start: "2026-10-07T12:00", timeZone: LA })) as { address: string };
  const created = store.files.recent({ limit: 1 })[0].revision;
  await op(store, "sync_calendar", { force: true });
  assert.deepEqual(((await op(store, "undo", { revisions: [created] })) as Array<{ status: string }>).map((u) => u.status), ["undone"]);
  assert.equal(fake.event("ada@example.com", made.address.split("/").at(-1)!)?.status, "cancelled");
});

for (const [how, answer] of [
  ["answering a read with the event, cancelled", null],
  ["answering a read with 404", 404],
] as const) {
  test(`an event Google deleted during a sync in which we edited it goes on the next sync, Google ${how}`, async () => {
    const { fake } = google();
    let gate: Promise<void> | null = null;
    const store = memoryStore({ fixtures: false, google: { clientId: "c", clientSecret: "s" } }, async (input, init) => {
      if (gate && String(input).includes("/calendars/primary/events?")) await gate;
      if (answer && (init?.method ?? "GET") === "GET" && String(input).endsWith("/events/dentist")) return new Response("{}", { status: answer });
      return fake.fetch(input, init);
    });
    store.sources.connect({ email: "ada@example.com", refreshToken: "refresh", scopes: DATA_SCOPES });
    await op(store, "sync_calendar", {});
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const syncing = op(store, "sync_calendar", { force: true });
    await new Promise((r) => setTimeout(r, 10));
    await op(store, "update_event", { address: "event:google/primary/dentist", location: "Room 1" });
    fake.remove("ada@example.com", "dentist");
    gate = null;
    open();
    await syncing;
    await op(store, "sync_calendar", { force: true });
    assert.equal(await op(store, "read_event", { address: "event:google/primary/dentist" }), null);
  });
}

test("undoing everything an agent did undoes its several edits of one event together, here and in Google", async () => {
  const { fake, store } = google();
  await op(store, "sync_calendar", {});
  const agent: Author = { kind: "agent", name: "Planner", by: "ada@example.com" };
  const since = store.files.recent({ limit: 1 })[0].revision;
  for (const args of [{ title: "Dentist (Dr Lee)" }, { location: "14 High Street" }]) {
    const r = await runOperation("update_event", { address: "event:google/primary/dentist", ...args }, store, agent);
    assert.equal(r.ok, true);
  }
  await op(store, "sync_calendar", { force: true });
  const its = store.files.recent({ author: authorKey(agent) }).filter((c) => c.revision > since).map((c) => c.revision);
  assert.equal(its.length, 2);
  const undone = (await op(store, "undo", { revisions: its })) as Array<{ status: string }>;
  assert.deepEqual(undone.map((u) => u.status), ["undone", "undone"]);
  const here = ((await op(store, "read_event", { address: "event:google/primary/dentist" })) as { event: { title: string; location?: string } }).event;
  assert.deepEqual([here.title, here.location], ["Dentist", "12 High Street"]);
  assert.deepEqual([fake.event("ada@example.com", "dentist")?.summary, fake.event("ada@example.com", "dentist")?.location], ["Dentist", "12 High Street"]);
});
