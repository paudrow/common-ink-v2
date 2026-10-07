import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../worker/src/query.ts";
import { complete, hasFilter, Search, toggleFilter, type FilterInfo } from "../web/src/search.ts";
import { findTasks } from "../web/src/extensions/tasks/search.ts";
import { tasksIn } from "../web/src/extensions/tasks/tasks.ts";
import { findEvents } from "../web/src/extensions/calendar/search.ts";
import type { Occurrence } from "../worker/src/calendar.ts";
import type { ExtensionManifest } from "../worker/src/extensions.ts";

const FILTERS: FilterInfo[] = [
  { key: "is", description: "", values: ["archived", "pinned", "trashed"] },
  { key: "in", description: "", values: ["Projects/", "My Folder/"] },
];

test("a chip writes its filter into the query, and a second tap takes it out", () => {
  assert.equal(toggleFilter("launch", "from:agent"), "launch from:agent ");
  assert.equal(toggleFilter("launch  from:agent beta", "from:agent"), "launch beta ");
  assert.equal(toggleFilter("", "type:event"), "type:event ");
  assert.equal(toggleFilter("from:agent", "from:agent"), "");
  assert.deepEqual([hasFilter("x FROM:Agent", "from:agent"), hasFilter("x -from:agent", "from:agent")], [true, false]);
});

test("Tab completes a filter's key, then its value, then moves on to the next value", () => {
  assert.deepEqual(complete("launch i", 8, FILTERS), { text: "launch is:", caret: 10 });
  assert.deepEqual(complete("launch is:ar", 12, FILTERS), { text: "launch is:archived", caret: 18 });
  assert.deepEqual(complete("is:archived", 11, FILTERS), { text: "is:pinned", caret: 9 });
  assert.deepEqual(complete("-in:my x", 6, FILTERS), { text: '-in:"My Folder/" x', caret: 16 });
  assert.equal(complete("launch", 6, FILTERS), null);
  assert.equal(complete("due:to", 6, FILTERS), null);
});

const manifest = (search: ExtensionManifest["contributes"]["search"], id = "tasks") => ({ id, contributes: { search } }) as ExtensionManifest;

test("search asks each kind of result, and type: picks which", async () => {
  const asked: string[] = [];
  const search = new Search({
    manifests: () => [manifest({ types: [{ type: "task", title: "Tasks" }], filters: [{ filter: "due", description: "", values: [] }] })],
    notes: { search: (q) => (asked.push(`notes: ${JSON.stringify(q.terms)}`), { results: [{ title: "Launch plan", run() {} }] }) },
  });
  search.provide("task", { search: (q) => (asked.push(`tasks: ${q.terms.length}`), [{ title: "Record the demo", run() {} }]) }, "tasks");
  const titles = async (text: string) => (await search.find(text, 5)).map((s) => `${s.title}: ${s.results.map((r) => r.title).join(", ")}`);
  assert.deepEqual(await titles("launch"), ["Notes: Launch plan", "Tasks: Record the demo"]);
  assert.deepEqual(await titles("launch type:task"), ["Tasks: Record the demo"]);
  assert.deepEqual(await titles("demo due:today"), ["Tasks: Record the demo"]);
  assert.deepEqual(await titles(""), ["Recent: Launch plan"]);
  assert.equal(asked.at(-1), 'notes: [{"kind":"filter","key":"is","value":"archived","negated":true},{"kind":"filter","key":"sort","value":"edited","negated":false}]');
});

test("tasks match their words, is:open and is:done, and their note's folder", () => {
  const tasks = [
    ...tasksIn("Projects/Launch.md", "- [ ] Record the demo due:2026-10-07\n- [x] Freeze the copy\n- [ ] Draft changelog due:2026-10-06", "Launch"),
    ...tasksIn("Journal/2026-10-05.md", "- [ ] Call the dentist", "2026-10-05"),
  ];
  const found = (q: string) => findTasks(tasks, parse(q)).map((t) => t.summary);
  assert.deepEqual(found("the"), ["Record the demo", "Call the dentist", "Freeze the copy"]);
  assert.deepEqual(found("is:open in:projects"), ["Draft changelog", "Record the demo"]);
  assert.deepEqual(found("is:done"), ["Freeze the copy"]);
  assert.deepEqual(found("-in:Projects"), ["Call the dentist"]);
  assert.deepEqual(found("demo from:agent"), []);
});

test("events match their title and place, a series once at its next time, coming ones first", () => {
  const at = (id: string, title: string, start: string, more: Partial<Occurrence> = {}): Occurrence => ({ address: `event:sample/work/${id}`, id, calendar: "work", title, status: "confirmed", allDay: false, start, end: start.replace("T09", "T10"), ...more });
  const now = Date.parse("2026-10-05T12:00:00Z");
  const events = [
    at("s1", "Standup", "2026-10-02T09:00:00Z", { series: "s" }),
    at("s2", "Standup", "2026-10-06T09:00:00Z", { series: "s" }),
    at("s3", "Standup", "2026-10-07T09:00:00Z", { series: "s" }),
    at("d", "Dentist", "2026-10-09T09:00:00Z", { location: "Main St" }),
    at("r", "Retro", "2026-09-30T09:00:00Z"),
  ];
  assert.deepEqual(findEvents(events, parse(""), now).map((o) => o.id), ["s2", "d", "r"]);
  assert.deepEqual(findEvents(events, parse("main"), now).map((o) => o.id), ["d"]);
  assert.deepEqual(findEvents(events, parse("standup is:archived"), now), []);
});

test("one kind of result has one provider: the first extension to declare it", async () => {
  const search = new Search({ manifests: () => [manifest({ types: [{ type: "task", title: "Tasks" }], filters: [] }), manifest({ types: [{ type: "task", title: "Tasks" }], filters: [] }, "hijack")], notes: { search: () => ({ results: [] }) } });
  assert.throws(() => search.provide("task", { search: () => [] }, "hijack"), /belongs to tasks, not hijack/);
  assert.deepEqual(search.types().map((t) => t.type), ["note", "task"]);
});

test("a provider that never answers is left out after a moment, and notes come first", async () => {
  const search = new Search({ manifests: () => [manifest({ types: [{ type: "slow", title: "Slow" }], filters: [] }, "slowpoke")], notes: { search: () => ({ results: [{ title: "Garden plan", run() {} }] }) } });
  search.provide("slow", { search: () => new Promise(() => {}) }, "slowpoke");
  const seen: string[][] = [];
  const start = Date.now();
  const found = await search.find("garden", 5, (sections) => seen.push(sections.map((s) => s.title)));
  assert.ok(Date.now() - start < 1500);
  assert.deepEqual([found.map((s) => s.title), seen[0]], [["Notes"], ["Notes"]]);
});

test("-type: leaves a kind out, and notes that can't be searched say why", async () => {
  const search = new Search({ manifests: () => [manifest({ types: [{ type: "task", title: "Tasks" }], filters: [] })], notes: { search: () => Promise.reject(new TypeError("Failed to fetch")) } });
  search.provide("task", { search: () => [{ title: "Pay rent", run() {} }] }, "tasks");
  assert.deepEqual((await search.find("pay -type:task", 5)).map((s) => [s.title, s.note ?? s.results.length]), [["Notes", "Search needs a connection: notes by name are below"]]);
});

test("Tab completes a quoted value, spaces and all", () => {
  assert.deepEqual(complete('hello in:"My F', 14, FILTERS), { text: 'hello in:"My Folder/"', caret: 21 });
  assert.deepEqual(complete('in:"my', 6, FILTERS), { text: 'in:"My Folder/"', caret: 15 });
});

test("a find within some paths asks each kind for only what's there, before its limit, and leaves out kinds it may not see", async () => {
  const asked: string[] = [];
  const search = new Search({
    manifests: () => [manifest({ types: [{ type: "task", title: "Tasks" }], filters: [] }), manifest({ types: [{ type: "event", title: "Events" }], filters: [] }, "calendar")],
    notes: { search: (_q, _limit, within) => (asked.push(`notes ${JSON.stringify(within)}`), { results: [{ title: "Decoy", path: "Public/Decoy.md", run() {} }], more: true }) },
  });
  // A provider that ignores `within` still has what's outside it taken out before the limit is applied.
  search.provide("task", { search: (_q, _limit, within) => (asked.push(`tasks ${JSON.stringify(within)}`), [{ title: "Secret task", path: "Secret/Plan.md", run() {} }, { title: "Public task", path: "Public/Decoy.md", run() {} }, { title: "No file", run() {} }]) }, "tasks");
  search.provide("event", { search: () => (asked.push("events"), [{ title: "Dentist", run() {} }]) }, "calendar");
  const found = await search.find("zebra", 1, undefined, (type) => (type === "event" ? [] : ["Public/**"]));
  assert.deepEqual(
    found.map((s) => [s.title, s.results.map((r) => r.title), s.more ?? false]),
    [
      ["Notes", ["Decoy"], true],
      ["Tasks", ["Public task"], false],
    ],
  );
  assert.deepEqual(asked, ['notes ["Public/**"]', 'tasks ["Public/**"]']);
  // Unscoped, a kind's results are as its provider gives them.
  assert.deepEqual((await search.find("zebra", 5)).map((s) => s.results.length), [1, 3, 1]);
});

test("Tab after a closed quoted value moves on to the next value", () => {
  assert.deepEqual(complete('in:"My Folder/"', 15, FILTERS), { text: "in:Projects/", caret: 12 });
});

test("a kind of result is answered only by its owner now: a provider given while another owned it isn't asked", async () => {
  let owner = "squatter";
  const search = new Search({
    manifests: () => [manifest({ types: [{ type: "count", title: "Counts" }], filters: [] }, "squatter"), manifest({ types: [{ type: "count", title: "Counts" }], filters: [] }, "counter")],
    owner: () => owner,
    notes: { search: () => ({ results: [] }) },
  });
  search.provide("count", { search: () => [{ title: "From the squatter", run() {} }] }, "squatter");
  assert.deepEqual((await search.find("from", 5)).flatMap((s) => s.results.map((r) => r.title)), ["From the squatter"]);
  owner = "counter";
  assert.deepEqual((await search.find("from", 5)).flatMap((s) => s.results.map((r) => r.title)), []);
  assert.throws(() => search.provide("count", { search: () => [] }, "squatter"), /belongs to counter, not squatter/);
});
