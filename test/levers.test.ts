// Test levers (docs/TESTING.md): read from the address and a cookie, on only with LEVERS and a dev user,
// and never set where production gets its settings.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { leverInstant, leversCookie, leversFromCookie, leversOn, readLevers } from "../worker/src/levers.ts";
import { readScenarios, readSections, scenarioSeed } from "../scripts/seed.ts";
import { replay } from "../worker/src/net-replay.ts";
import { linkCard } from "../worker/src/link-card.ts";

const root = path.resolve(import.meta.dirname, "..");

test("levers come from the address: a bad value is ignored, and an empty one clears", () => {
  const set = readLevers(new URLSearchParams("now=2026-10-05T09:00&permissions=allow&net=replay&offline=1&file=Chores.md"));
  assert.deepEqual(set, { now: "2026-10-05T09:00", permissions: "allow", net: "replay", offline: true });
  assert.deepEqual(readLevers(new URLSearchParams("now=yesterday&permissions=maybe&net=&offline=0"), set), { now: "2026-10-05T09:00", permissions: "allow", offline: false });
});

test("levers last in a cookie, and come back out of a Cookie header among others", () => {
  const cookie = leversCookie({ now: "2026-10-05", net: "replay" });
  assert.equal(cookie, "common-ink-levers=now%3D2026-10-05%26net%3Dreplay; Path=/; SameSite=Lax");
  assert.deepEqual(leversFromCookie(`session=abc; ${cookie.split(";")[0]}; other=1`), { now: "2026-10-05", net: "replay" });
  assert.deepEqual(leversFromCookie("common-ink-levers=%zz"), {});
  assert.deepEqual(leversFromCookie(null), {});
});

test("levers are on only with LEVERS and a dev user, so a production Worker never honours them", () => {
  assert.equal(leversOn({ LEVERS: "1", DEV_USER: "dev@localhost" }), true);
  assert.equal(leversOn({ LEVERS: "1" }), false);
  assert.equal(leversOn({ DEV_USER: "dev@localhost" }), false);
  assert.equal(leversOn({ LEVERS: "true", DEV_USER: "dev@localhost" }), false);
});

test("a date alone is local midnight; real and no lever are the real clock", () => {
  assert.equal(leverInstant("2026-10-05"), new Date(2026, 9, 5).getTime());
  assert.equal(leverInstant("2026-10-05T09:30"), new Date(2026, 9, 5, 9, 30).getTime());
  assert.equal(leverInstant("real"), null);
  assert.equal(leverInstant(undefined), null);
});

test("production sets none of the dev-only variables, and Previews set levers with a dev user", () => {
  const config = JSON.parse(
    fs
      .readFileSync(path.join(root, "worker/wrangler.jsonc"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n"),
  );
  const devOnly = ["LEVERS", "DEV_USER", "SEED", "DATA_FIXTURES"];
  assert.deepEqual(Object.keys(config.vars ?? {}).filter((k) => devOnly.includes(k)), []);
  assert.equal(config.previews.vars.LEVERS, "1");
  assert.ok(config.previews.vars.DEV_USER);
  const deploy = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").split(/\n  (?=\S)/).find((job) => job.startsWith("deploy:"))!;
  assert.ok(deploy.includes("npm run deploy"), "found the production deploy job");
  assert.deepEqual(devOnly.filter((k) => deploy.includes(k)), []);
});

test("every scenario builds: its sections exist, its dates follow its clock, and it opens on a note it has", () => {
  const sections = readSections(path.join(root, "examples/preview"));
  const scenarios = readScenarios(path.join(root, "test/scenarios"));
  assert.deepEqual(scenarios.map((s) => s.name), ["calendar", "embeds", "empty", "extensions", "google", "history", "lists", "tasks"]);
  const tasks = scenarioSeed(scenarios.find((s) => s.name === "tasks")!, sections, "2030-01-01");
  assert.deepEqual(tasks.scenario, { name: "tasks", now: "2026-10-05T09:00" });
  assert.match(tasks.notes.find((n) => n.path === "Chores.md")!.text, /Water the plants due:2026-10-05 rec:3d/);
  assert.deepEqual(JSON.parse(tasks.notes.find((n) => n.path === ".common-ink/layout.json")!.text).root.tabs, [{ file: "Chores.md" }]);
  assert.deepEqual(scenarioSeed(scenarios.find((s) => s.name === "empty")!, sections).notes, []);
  const extensions = scenarioSeed(scenarios.find((s) => s.name === "extensions")!, sections);
  assert.ok(extensions.notes.some((n) => n.path === ".common-ink/extensions/word-count/extension.json"), "installs Word count");
});

test("replayed network: a recorded page makes its card without the network, and an unrecorded one says how to record it", async () => {
  const net = replay({
    "https://example.org/pen": { status: 200, headers: { "Content-Type": "text/html" }, body: '<html><head><title>Fountain pen</title><meta property="og:description" content="A pen with a nib"></head></html>' },
  });
  const card = await linkCard("https://example.org/pen", net);
  assert.equal(card.title, "Fountain pen");
  assert.equal(card.description, "A pen with a nib");
  await assert.rejects(linkCard("https://example.org/other", net), /no recording of it .*npm run net:record -- https:\/\/example\.org\/other/);
});
