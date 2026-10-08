import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author } from "../worker/src/files.ts";
import { PLACES_PATH } from "../worker/src/places.ts";
import { memoryKV, Offline, type Network } from "../web/src/offline.ts";
import { changePlaces, placesChangeOf, sendPlaces, withSaved, type PlacesChange } from "../web/src/places-file.ts";
import { memoryStore } from "./store.ts";

const you: Author = { kind: "user", email: "you@example.com" };

/** One browser's places.json changes, sent as main.ts sends them, over a network that can be cut. */
function setup(store = memoryStore()) {
  let up = true;
  const gate = <T>(fn: () => T): Promise<T> => (up ? Promise.resolve(fn()) : Promise.reject(new TypeError("Failed to fetch")));
  const net: Network = {
    list: () => gate(() => store.files.list()),
    read: (path) => gate(() => store.files.read(path) ?? { path, text: "", revision: 0 }),
    write: (path, text, base, edit) => gate(() => store.files.write({ path, text, base, author: you, ...(edit ? { edit } : {}) })),
    editApplied: (path, edit) => gate(() => store.files.editApplied(path, edit)),
  };
  const offline = new Offline(memoryKV(), net);
  const notices: string[] = [];
  const flush = async () => {
    const { refused } = await offline.flushOps((op) => sendPlaces(offline, placesChangeOf(op)!));
    for (const { error } of refused) notices.push(`refused: ${error}`);
  };
  const change = (c: PlacesChange) => changePlaces(offline, c, c.key === "bar" ? "the bottom bar" : "the saved searches", flush, (m) => void notices.push(m));
  const save = (name: string, query: string) => change({ key: "saved", name, query });
  const bar = (ids: string[]) => change({ key: "bar", ids });
  return { store, offline, notices, save, bar, flush, setUp: (v: boolean) => (up = v) };
}

const placesNow = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.files.read(PLACES_PATH)!.text);

test("offline, changes to places.json wait, and are all made once back, with nothing left held and no clash", async () => {
  const { store, offline, save, bar, flush, setUp, notices } = setup();
  store.files.write({ path: PLACES_PATH, text: '{\n  "saved": {"Tours": "tour"}\n}\n', base: 0, author: you });
  setUp(false);
  await bar(["feed", "tasks.tasks"]);
  await save("Garden", "garden");
  await save("Launch", "launch");
  assert.equal(notices.length, 3);
  setUp(true);
  await flush();
  assert.deepEqual(placesNow(store), { saved: { Tours: "tour", Garden: "garden", Launch: "launch" }, bar: ["feed", "tasks.tasks"] });
  assert.deepEqual([await offline.ops(), await offline.unsent(), notices.filter((n) => n.startsWith("refused"))], [[], [], []]);
});

test("a search saved offline on a laptop while the phone changes the bar: both are kept, and nothing clashes", async () => {
  const store = memoryStore();
  store.files.write({ path: PLACES_PATH, text: '{\n  "bar": ["feed"]\n}\n', base: 0, author: you });
  const laptop = setup(store);
  laptop.setUp(false);
  await laptop.save("Garden", "garden");
  const phone = setup(store);
  await phone.bar(["feed", "calendar.calendar"]);
  laptop.setUp(true);
  await laptop.flush();
  assert.deepEqual(placesNow(store), { bar: ["feed", "calendar.calendar"], saved: { Garden: "garden" } });
  assert.deepEqual([await laptop.offline.ops(), await laptop.offline.unsent(), laptop.notices.filter((n) => n.startsWith("refused"))], [[], [], []]);
});

test("online, a change is made at once on the file as it is", async () => {
  const { store, save, notices } = setup();
  await save("Garden", "garden");
  store.files.write({ path: PLACES_PATH, text: `${store.files.read(PLACES_PATH)!.text.trimEnd().slice(0, -1)},\n  "bar": ["feed"]\n}\n`, base: store.files.read(PLACES_PATH)!.revision, author: you });
  await save("Launch", "launch");
  assert.deepEqual([placesNow(store), notices], [{ saved: { Garden: "garden", Launch: "launch" }, bar: ["feed"] }, []]);
});

test("saved searches with a trailing comma are kept, and ones that can't be read aren't written over", async () => {
  assert.deepEqual(withSaved('{"saved": {"Tours": "tour",}, "bar": ["feed"]}', "Plans", "plan"), { Tours: "tour", Plans: "plan" });
  assert.equal(withSaved('{"saved": {"Tours": tour}}', "Plans", "plan"), null);
  const { store, offline, save, notices } = setup();
  store.files.write({ path: PLACES_PATH, text: '{"saved": {"Tours": tour}}', base: 0, author: you });
  await save("Plans", "plan");
  assert.equal(store.files.read(PLACES_PATH)!.text, '{"saved": {"Tours": tour}}');
  assert.deepEqual([notices, await offline.ops()], [["refused: places.json can't be read: fix it, then make the change again"], []]);
});
