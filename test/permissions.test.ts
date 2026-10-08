import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest, type ExtensionManifest } from "../worker/src/extensions.ts";
import { coveringKey, decide, globMatches, hostMatches, parseGrants, readableIn, type Grants } from "../worker/src/permissions.ts";
import { PermissionBroker, PermissionDenied, type Choice } from "../web/src/broker.ts";
import type { Trigger } from "../web/src/permission-words.ts";

const weather = parseManifest(
  {
    name: "Weather",
    permissions: {
      network: { hosts: ["api.weather.gov", "*.tiles.example"], why: "Fetch forecasts" },
      "files:read": { paths: ["Journal/**", "Plans/*.md"], why: "Read your journal" },
      "clipboard:write": { why: "Copy the forecast" },
    },
  },
  "weather",
) as ExtensionManifest;

test("globs and hosts match the way they read", () => {
  assert.ok(globMatches("Journal/**", "Journal/2026/Oct.md"));
  assert.ok(globMatches("**", "Plan.md"));
  assert.ok(globMatches("Plans/*.md", "Plans/Q4.md"));
  assert.ok(!globMatches("Plans/*.md", "Plans/2026/Q4.md"));
  assert.ok(globMatches("**/notes.md", "notes.md") && globMatches("**/notes.md", "a/b/notes.md"));
  assert.ok(!globMatches("Journal/**", "Journalism.md"));
  assert.ok(hostMatches("api.weather.gov", "API.weather.gov"));
  assert.ok(hostMatches("*.tiles.example", "a.tiles.example"));
  assert.ok(!hostMatches("*.tiles.example", "tiles.example") && !hostMatches("*.tiles.example", "eviltiles.example"));
});

test("an ask is covered by the declared scope it falls in, and nothing else", () => {
  assert.equal(coveringKey(weather, { kind: "network", target: "api.weather.gov" }), "network:api.weather.gov");
  assert.equal(coveringKey(weather, { kind: "network", target: "b.tiles.example" }), "network:*.tiles.example");
  assert.equal(coveringKey(weather, { kind: "network", target: "evil.example" }), null);
  assert.equal(coveringKey(weather, { kind: "files:read", target: "Journal/Mon.md" }), "files:read:Journal/**");
  assert.equal(coveringKey(weather, { kind: "files:read", target: "Secrets.md" }), null);
  assert.equal(coveringKey(weather, { kind: "files:write", target: "Journal/Mon.md" }), null, "not declared at all");
  assert.equal(coveringKey(weather, { kind: "files:read", scope: "Journal/**" }), "files:read:Journal/**");
  assert.equal(coveringKey(weather, { kind: "clipboard:write" }), "clipboard:write");
});

test("what to do: undeclared never, then your answer, then built-ins allowed, then ask", () => {
  const net = { kind: "network" as const, target: "api.weather.gov" };
  assert.deepEqual(decide(weather, { kind: "network", target: "evil.example" }, {}), { outcome: "undeclared" });
  assert.deepEqual(decide(weather, net, {}), { outcome: "ask", key: "network:api.weather.gov" });
  assert.deepEqual(decide(weather, net, { weather: { "network:api.weather.gov": "deny" } }, { builtIn: true }), { outcome: "deny", key: "network:api.weather.gov" });
  assert.deepEqual(decide(weather, net, {}, { builtIn: true }), { outcome: "allow", key: "network:api.weather.gov" });
  assert.deepEqual(decide(weather, net, {}, { builtIn: false, once: new Set(["weather network:api.weather.gov"]) }), { outcome: "allow", key: "network:api.weather.gov" });
  assert.deepEqual(parseGrants({ weather: { a: "allow", b: "maybe" }, other: "no" }), { weather: { a: "allow" } });
});

/** A broker whose prompts are answered from a script, recording what each prompt asked, and why now. */
function broker(answers: Choice[], builtIn = false) {
  const prompts: string[][] = [];
  const triggers: Array<Trigger | null> = [];
  const saved: string[] = [];
  const told: string[] = [];
  let grants: Record<string, Record<string, "allow" | "deny">> = {};
  const b = new PermissionBroker({
    grants: () => grants,
    isBuiltIn: () => builtIn,
    save: async (id, key, answer) => {
      saved.push(`${id} ${key} ${answer}`);
      grants = { ...grants, [id]: { ...grants[id], [key]: answer } };
    },
    prompt: async (_m, asks, joined, trigger) => {
      const shown = asks.map((a) => a.key);
      prompts.push(shown);
      triggers.push(trigger);
      joined((a) => shown.push(a.key));
      await new Promise((r) => setTimeout(r, 5));
      return answers.shift() ?? "deny";
    },
    undeclared: (denied) => told.push(denied.message),
    changed: () => {},
  });
  return { b, prompts, triggers, saved, told };
}

test("asked once: Allow once lasts the session, Always allow is kept, Don't allow is kept and not asked again", async () => {
  const { b, prompts, saved } = broker(["once", "always", "deny"]);
  await b.check(weather, { kind: "network", target: "api.weather.gov" });
  await b.check(weather, { kind: "network", target: "api.weather.gov" });
  assert.equal(prompts.length, 1, "allowed once, not asked again this session");
  await b.check(weather, { kind: "clipboard:write" });
  await assert.rejects(b.check(weather, { kind: "files:read", target: "Journal/Mon.md" }), PermissionDenied);
  await assert.rejects(b.check(weather, { kind: "files:read", target: "Journal/Tue.md" }), PermissionDenied);
  assert.equal(prompts.length, 3, "a denial isn't asked about again");
  assert.deepEqual(saved, ["weather clipboard:write allow", "weather files:read:Journal/** deny"]);
});

test("one Don't allow is enough: an ask while the answer is being kept gets it, without a second prompt", async () => {
  const prompts: string[][] = [];
  const saved: string[] = [];
  let grants: Grants = {};
  let saving!: () => void;
  const b = new PermissionBroker({
    grants: () => grants,
    isBuiltIn: () => false,
    // Keeping an answer takes a while: a write, then settings read again.
    save: (id, key, answer) =>
      new Promise((done) => {
        saved.push(`${id} ${key} ${answer}`);
        saving = () => {
          grants = { [id]: { [key]: answer } };
          done();
        };
      }),
    prompt: async (_m, asks) => {
      prompts.push(asks.map((a) => a.key));
      return "deny";
    },
    undeclared: () => {},
    changed: () => {},
  });
  const first = b.check(weather, { kind: "files:read", target: "Journal/Mon.md" });
  await new Promise((r) => setTimeout(r, 0));
  // The extension tries again (it heard its settings save, say) before the answer is in settings.
  await assert.rejects(b.check(weather, { kind: "files:read", target: "Journal/Tue.md" }), PermissionDenied);
  saving();
  await assert.rejects(first, PermissionDenied);
  await assert.rejects(b.check(weather, { kind: "files:read", target: "Journal/Wed.md" }), PermissionDenied);
  assert.equal(prompts.length, 1, "asked once");
  assert.deepEqual(saved, ["weather files:read:Journal/** deny"], "and kept once");
});

test("an undeclared ask is refused without a prompt, and you hear of it once; Escape refuses for now without keeping it", async () => {
  const { b, prompts, saved, told } = broker(["dismiss"]);
  await assert.rejects(b.check(weather, { kind: "network", target: "evil.example" }), { message: "Weather can't connect to evil.example: it only asked to connect to api.weather.gov or any site under tiles.example." });
  await assert.rejects(b.check(weather, { kind: "network", target: "evil2.example" }), PermissionDenied);
  await assert.rejects(b.check(weather, { kind: "files:write", target: "Journal/Mon.md" }), { message: "Weather can't change the note Journal/Mon: it never asked for that." });
  assert.deepEqual(told, ["Weather can't connect to evil.example: it only asked to connect to api.weather.gov or any site under tiles.example.", "Weather can't change the note Journal/Mon: it never asked for that."], "once per kind");
  await assert.rejects(b.check(weather, { kind: "network", target: "api.weather.gov" }), { message: "Weather can't connect to api.weather.gov: you didn't allow it this time. Change that in Extensions → Weather." });
  await assert.rejects(b.check(weather, { kind: "network", target: "api.weather.gov" }), PermissionDenied);
  assert.equal(prompts.length, 1);
  assert.deepEqual(saved, []);
  assert.deepEqual(
    b.log.slice(0, 3).map((e) => [e.ask.kind, e.ask.target, e.outcome]),
    [
      ["network", "api.weather.gov", "denied"],
      ["network", "api.weather.gov", "denied"],
      ["files:write", "Journal/Mon.md", "denied"],
    ],
  );
});

test("a kept Don't allow says which of your answers refused it, in its words", async () => {
  const { b } = broker(["deny"]);
  await assert.rejects(b.check(weather, { kind: "files:read", target: "Journal/Mon.md" }), { message: "Weather can't read the note Journal/Mon: you don't allow it to read everything in Journal. Change that in Extensions → Weather." });
  await assert.rejects(b.check(weather, { kind: "files:read", target: "Journal/Tue.md" }), { message: "Weather can't read the note Journal/Tue: you don't allow it to read everything in Journal. Change that in Extensions → Weather." });
});

test("a prompt says what you just did that the extension is acting on, and nothing once it's a while ago", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { b, triggers } = broker(["once", "once", "once", "once"]);
  b.cause("weather", { kind: "command", title: "Show the forecast" });
  b.cause("weather", { kind: "view", name: "Forecast" });
  await b.check(weather, { kind: "network", target: "api.weather.gov" });
  b.cause("other", { kind: "view", name: "Elsewhere" });
  t.mock.timers.tick(5_000);
  await b.check(weather, { kind: "clipboard:write" });
  t.mock.timers.tick(6_000);
  await b.check(weather, { kind: "files:read", scope: "Journal/**" });
  b.cause("weather", { kind: "view", name: "Forecast" });
  await b.check(weather, { kind: "files:read", scope: "Plans/*.md" });
  assert.deepEqual(triggers, [{ kind: "command", title: "Show the forecast" }, { kind: "command", title: "Show the forecast" }, null, { kind: "view", name: "Forecast" }], "the view drawing is the reason only when nothing just now is");
});

test("prompts come one at a time, and an extension's asks while its prompt is up join it", async () => {
  const { b, prompts } = broker(["once", "once"]);
  const other = { ...weather, id: "other", name: "Other" };
  const asks = [
    b.check(weather, { kind: "network", target: "api.weather.gov" }),
    b.check(other, { kind: "clipboard:write" }),
    b.check(weather, { kind: "clipboard:write" }),
  ];
  await Promise.all(asks);
  assert.deepEqual(prompts, [["network:api.weather.gov", "clipboard:write"], ["clipboard:write"]]);
});

test("built-ins have what they declare until you deny it", async () => {
  const { b, prompts } = broker([], true);
  await b.check(weather, { kind: "network", target: "api.weather.gov" });
  assert.equal(prompts.length, 0);
});

test("a request in flight shows as busy and lands in the log", async () => {
  const { b } = broker([]);
  let release!: () => void;
  const running = b.inFlightWhile("weather", "https://api.weather.gov/points", () => new Promise<void>((r) => (release = r)));
  assert.deepEqual(b.busy(), ["weather"]);
  assert.equal(b.log[0].outcome, "in flight");
  release();
  await running;
  assert.deepEqual(b.busy(), []);
  assert.deepEqual([b.log[0].ask, b.log[0].url, b.log[0].outcome], [{ kind: "network", target: "api.weather.gov" }, "https://api.weather.gov/points", "allowed"]);
});

test("what an extension may list is what it may read: the first declared scope that covers a path decides", () => {
  const scopes = ["Notes/**", "Notes/Secret/**", "Journal/**"];
  const may = readableIn(scopes, [false, true, true]);
  const m = parseManifest({ name: "Lister", permissions: { "files:read": { paths: scopes, why: "List" } } }, "lister") as ExtensionManifest;
  const grants: Grants = { lister: { "files:read:Notes/**": "deny", "files:read:Notes/Secret/**": "allow", "files:read:Journal/**": "allow" } };
  const paths = ["Notes/Secret/Plan.md", "Notes/Plan.md", "Journal/2026-10-08.md", "Other.md"];
  assert.deepEqual(paths.filter(may), ["Journal/2026-10-08.md"]);
  assert.deepEqual(paths.filter(may), paths.filter((target) => decide(m, { kind: "files:read", target }, grants).outcome === "allow"), "as files.read decides");
});
