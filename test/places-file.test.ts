import assert from "node:assert/strict";
import { test } from "node:test";
import type { Author, FilePath } from "../worker/src/files.ts";
import { PLACES_PATH } from "../worker/src/places.ts";
import { memoryKV, Offline, type Network } from "../web/src/offline.ts";
import { withSaved, writePlacesKey } from "../web/src/places-file.ts";
import { memoryStore } from "./store.ts";

const you: Author = { kind: "user", email: "you@example.com" };

function setup() {
  const store = memoryStore();
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
  const save = (name: string, query: string) => writePlacesKey(offline, "saved", (now) => withSaved(now, name, query), "the saved searches", (m) => void notices.push(m));
  const bar = (ids: string[]) => writePlacesKey(offline, "bar", () => ids, "the bottom bar", (m) => void notices.push(m));
  return { store, offline, notices, save, bar, setUp: (v: boolean) => (up = v) };
}

const placesNow = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.files.read(PLACES_PATH as FilePath)!.text);

test("offline, a second change to places.json builds on the first, and both are saved once back", async () => {
  const { store, offline, save, bar, setUp, notices } = setup();
  store.files.write({ path: PLACES_PATH, text: '{\n  "saved": {"Tours": "tour"}\n}\n', base: 0, author: you });
  await offline.read(PLACES_PATH);
  setUp(false);
  await bar(["feed", "tasks.tasks"]);
  await save("Garden", "garden");
  await save("Launch", "launch");
  assert.equal(notices.length, 3);
  setUp(true);
  assert.deepEqual((await offline.flush()).sent, [PLACES_PATH]);
  assert.deepEqual(placesNow(store), { saved: { Tours: "tour", Garden: "garden", Launch: "launch" }, bar: ["feed", "tasks.tasks"] });
});

test("online, a change after one held offline sends both, and lets the held one go", async () => {
  const { store, offline, save, setUp } = setup();
  setUp(false);
  await save("Garden", "garden");
  setUp(true);
  await save("Launch", "launch");
  assert.deepEqual(placesNow(store).saved, { Garden: "garden", Launch: "launch" });
  assert.deepEqual(await offline.unsent(), []);
});

test("saved searches with a trailing comma are kept, and ones that can't be read aren't written over", async () => {
  assert.deepEqual(withSaved('{"saved": {"Tours": "tour",}, "bar": ["feed"]}', "Plans", "plan"), { Tours: "tour", Plans: "plan" });
  assert.equal(withSaved('{"saved": {"Tours": tour}}', "Plans", "plan"), null);
  const { store, save, notices } = setup();
  store.files.write({ path: PLACES_PATH, text: '{"saved": {"Tours": tour}}', base: 0, author: you });
  await save("Plans", "plan");
  assert.equal(store.files.read(PLACES_PATH)!.text, '{"saved": {"Tours": tour}}');
  assert.deepEqual(notices, ["places.json can't be read: fix it to change the saved searches."]);
});
