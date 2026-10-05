import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest, type ExtensionManifest } from "../worker/src/extensions.ts";
import { coveringKey, decide, globMatches, hostMatches, parseGrants, type Grants } from "../worker/src/permissions.ts";
import { PermissionBroker, PermissionDenied, type Choice } from "../web/src/broker.ts";

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

/** A broker whose prompts are answered from a script, recording what each prompt asked. */
function broker(answers: Choice[], builtIn = false) {
  const prompts: string[][] = [];
  const saved: string[] = [];
  let grants: Record<string, Record<string, "allow" | "deny">> = {};
  const b = new PermissionBroker({
    grants: () => grants,
    isBuiltIn: () => builtIn,
    save: async (id, key, answer) => {
      saved.push(`${id} ${key} ${answer}`);
      grants = { ...grants, [id]: { ...grants[id], [key]: answer } };
    },
    prompt: async (_m, asks, joined) => {
      const shown = asks.map((a) => a.key);
      prompts.push(shown);
      joined((a) => shown.push(a.key));
      await new Promise((r) => setTimeout(r, 5));
      return answers.shift() ?? "deny";
    },
    changed: () => {},
  });
  return { b, prompts, saved };
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

test("an undeclared ask is refused without a prompt; Escape refuses for now without keeping it", async () => {
  const { b, prompts, saved } = broker(["dismiss"]);
  await assert.rejects(b.check(weather, { kind: "network", target: "evil.example" }), /didn't declare that it may connect to evil\.example/);
  await assert.rejects(b.check(weather, { kind: "network", target: "api.weather.gov" }), PermissionDenied);
  await assert.rejects(b.check(weather, { kind: "network", target: "api.weather.gov" }), PermissionDenied);
  assert.equal(prompts.length, 1);
  assert.deepEqual(saved, []);
  assert.deepEqual(
    b.log.map((e) => [e.kind, e.detail, e.outcome]),
    [
      ["network", "api.weather.gov", "denied"],
      ["network", "api.weather.gov", "denied"],
      ["network", "evil.example", "denied"],
    ],
  );
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
  assert.deepEqual([b.log[0].kind, b.log[0].detail, b.log[0].outcome], ["network", "https://api.weather.gov/points", "allowed"]);
});
