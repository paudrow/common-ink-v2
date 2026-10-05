import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconnectNeeded, type Adapter } from "../worker/src/adapter.ts";
import { authorKey, type Author, type FilePath } from "../worker/src/files.ts";
import { runOperation } from "../worker/src/operations.ts";
import { addressOf, keyOfPath, parseAddress, recordPath, recordText } from "../worker/src/records.ts";
import type { Occurrence } from "../worker/src/calendar.ts";
import { memoryStore } from "./store.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };
const claude: Author = { kind: "agent", name: "Claude", by: "ada@example.com" };
const SEED: Author = { kind: "agent", name: "Preview seed" };

/** A workspace with the Sample calendar's records, as a scenario seeds them. */
function sampleWorkspace(adapters: Adapter[] = [], fixtures = true) {
  const store = memoryStore({ fixtures, google: null }, undefined, adapters);
  const source = fixtures ? "sample" : "google";
  const put = (path: FilePath, record: object) => store.files.write({ path, text: recordText(record), base: store.files.read(path)?.revision ?? 0, author: SEED });
  put(recordPath({ source, kind: "calendar", collection: "", id: "work" }), { id: "work", title: "Work", color: "#4f6bd8", primary: true });
  put(recordPath({ source, kind: "calendar", collection: "", id: "holidays" }), { id: "holidays", title: "Holidays", color: "#2f9e44", writable: false });
  put(recordPath({ source, kind: "event", collection: "work", id: "standup" }), {
    id: "standup",
    calendar: "work",
    title: "Standup",
    allDay: false,
    start: "2026-10-05T09:00:00",
    end: "2026-10-05T09:15:00",
    timeZone: "UTC",
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"],
  });
  put(recordPath({ source, kind: "event", collection: "holidays", id: "fall" }), { id: "fall", calendar: "holidays", title: "Fall break", allDay: true, start: "2026-10-08", end: "2026-10-10" });
  return store;
}

const op = async (store: ReturnType<typeof memoryStore>, name: Parameters<typeof runOperation>[0], args: Record<string, unknown>, author: Author = ada) => {
  const result = await runOperation(name, args, store, author);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const week = { from: "2026-10-05T00:00:00Z", to: "2026-10-12T00:00:00Z" };
const titles = (os: unknown) => (os as Occurrence[]).map((o) => `${o.start.slice(0, 16)} ${o.title}`);

test("a record's address and its file name each other", () => {
  const key = { source: "google" as const, kind: "event" as const, collection: "en.usa#holiday@group.v.calendar.google.com", id: "abc_20261005T090000Z" };
  assert.equal(addressOf(key), "event:google/en.usa%23holiday%40group.v.calendar.google.com/abc_20261005T090000Z");
  assert.deepEqual(parseAddress(addressOf(key)), key);
  assert.equal(recordPath(key), ".common-ink/records/google/events/en.usa#holiday@group.v.calendar.google.com/abc_20261005T090000Z.json");
  assert.deepEqual(keyOfPath(recordPath(key)), key);
  assert.equal(parseAddress("event:dropbox/x/y"), null);
});

test("the Sample calendar lists its calendars and a week's occurrences, and records stay out of the file list", async () => {
  const store = sampleWorkspace();
  assert.deepEqual((await op(store, "list_calendars", {}) as Array<{ id: string }>).map((c) => c.id), ["work", "holidays"]);
  assert.deepEqual(titles(await op(store, "list_events", week)), [
    "2026-10-05T09:00 Standup",
    "2026-10-07T09:00 Standup",
    "2026-10-08 Fall break",
  ]);
  assert.deepEqual(store.files.list(), [], "record files aren't notes or settings");
  assert.equal(store.sources.status("ada@example.com").sources[0].events, 2);
});

test("an agent's edits are records changed by it, with history, and the file itself can't be written", async () => {
  const store = sampleWorkspace();
  const made = (await op(store, "create_event", { title: "Dentist", start: "2026-10-06T14:30", timeZone: "UTC", location: "12 High Street" }, claude)) as { address: string; status: string };
  assert.equal(made.status, "saved");
  const found = (await op(store, "read_event", { address: made.address })) as { event: { end: string; calendar: string }; path: string };
  assert.deepEqual([found.event.end, found.event.calendar], ["2026-10-06T15:00:00", "work"]);
  const history = store.files.recent({ path: found.path as FilePath });
  assert.deepEqual(history.map((c) => authorKey(c.author)), ["agent:Claude:ada@example.com"]);
  const write = await runOperation("write_file", { path: found.path, text: "{}", base: history[0].revision }, store, ada);
  assert.deepEqual(write, { ok: false, error: `${found.path} is a data source's record: change it with update_event` });
});

test("this, this and following, and all occurrences, from MCP's operations", async () => {
  const store = sampleWorkspace();
  const wed = "event:sample/work/standup_20261007T090000Z";
  await op(store, "update_event", { address: wed, start: "2026-10-07T10:00", scope: "this" });
  assert.deepEqual(titles(await op(store, "list_events", week)).slice(0, 2), ["2026-10-05T09:00 Standup", "2026-10-07T10:00 Standup"]);
  const split = (await op(store, "update_event", { address: "event:sample/work/standup_20261012T090000Z", title: "Sync", scope: "following" })) as { address: string };
  assert.match(split.address, /^event:sample\/work\/[0-9a-v]{26}$/);
  assert.deepEqual(titles(await op(store, "list_events", { from: "2026-10-12T00:00:00Z", to: "2026-10-15T00:00:00Z" })), ["2026-10-12T09:00 Sync", "2026-10-14T09:00 Sync"]);
  await op(store, "update_event", { address: "event:sample/work/standup", location: "Room 4", scope: "all" });
  assert.equal(((await op(store, "read_event", { address: "event:sample/work/standup_20261005T090000Z" })) as { event: { location: string } }).event.location, "Room 4");
  await op(store, "delete_event", { address: "event:sample/work/standup_20261005T090000Z", scope: "this" });
  assert.deepEqual(titles(await op(store, "list_events", week)), ["2026-10-07T10:00 Standup", "2026-10-08 Fall break"]);
});

test("a calendar that can't be changed refuses edits, saying which", async () => {
  const store = sampleWorkspace();
  const result = await runOperation("update_event", { address: "event:sample/holidays/fall", title: "Break" }, store, ada);
  assert.deepEqual(result, { ok: false, error: "Holidays can't be changed here" });
});

test("undo puts a record back through its source, and conflicts when it changed since", async () => {
  const store = sampleWorkspace();
  const path = recordPath({ source: "sample", kind: "event", collection: "work", id: "standup" });
  await op(store, "update_event", { address: "event:sample/work/standup", title: "Daily standup" });
  const [renamed] = store.files.recent({ path });
  await op(store, "update_event", { address: "event:sample/work/standup", location: "Room 4" });
  assert.equal(((await op(store, "undo", { revisions: [renamed.revision] })) as Array<{ status: string }>)[0].status, "conflict");
  const [moved] = store.files.recent({ path });
  assert.deepEqual(((await op(store, "undo", { revisions: [moved.revision] })) as Array<{ status: string }>).map((r) => r.status), ["undone"]);
  assert.equal(JSON.parse(store.files.read(path)!.text).location, undefined);
  assert.equal(store.files.recent({ path })[0].undoes, moved.revision);
});

test("an edit the source can't take yet is kept, says why, and goes once the source is back", async () => {
  let down: Error | null = new ReconnectNeeded("Google wants you to sign in again");
  const pushed: string[] = [];
  const google: Adapter = {
    source: "google",
    title: "Google Calendar",
    push: async (o) => {
      if (down) throw down;
      pushed.push(`${o.op} ${o.event.id}`);
      return { etag: `"${pushed.length}"` };
    },
  };
  const store = sampleWorkspace([google], false);
  store.sources.connect({ email: "ada@example.com", refreshToken: "r", scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/contacts.readonly"] });
  const queued = (await op(store, "update_event", { address: "event:google/work/standup", title: "Standup (offline)" })) as { status: string; error: string };
  assert.deepEqual([queued.status, queued.error], ["queued", "Google wants you to sign in again"]);
  assert.equal(store.sources.status("ada@example.com").sources[0].state, "needs-reconnect");
  assert.equal(store.sources.status("ada@example.com").sources[0].pending, 1);
  assert.equal(JSON.parse(store.files.read(recordPath({ source: "google", kind: "event", collection: "work", id: "standup" }))!.text).title, "Standup (offline)", "the edit is kept here meanwhile");
  down = null;
  store.sources.connect({ email: "ada@example.com", refreshToken: "r2", scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/contacts.readonly"] });
  assert.equal(await store.sources.flush("google"), null);
  assert.deepEqual(pushed, ["put standup"]);
  assert.deepEqual([store.sources.status("ada@example.com").sources[0].state, store.sources.status("ada@example.com").sources[0].pending], ["ok", 0]);
});

test("the records index is made from the files, the same however often", () => {
  const store = sampleWorkspace();
  const before = store.db.all("SELECT * FROM records ORDER BY path");
  store.sources.records.rebuild(store.files.under(".common-ink/records/"));
  store.sources.records.rebuild(store.files.under(".common-ink/records/"));
  assert.deepEqual(store.db.all("SELECT * FROM records ORDER BY path"), before);
  assert.equal(before.length, 4);
});
