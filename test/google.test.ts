import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_SCOPES, exchange } from "../worker/src/google.ts";
import { runOperation } from "../worker/src/operations.ts";
import { sign, verify } from "../worker/src/session.ts";
import { allowedEmails, sessionEmail, signInRoute, type SignInConfig } from "../worker/src/sign-in.ts";
import { fixtures } from "../worker/src/sources.ts";
import { memoryStore } from "./store.ts";

const SECRET = "test-secret";
const google = { clientId: "client-1", clientSecret: "shh" };
const config: SignInConfig = { google, sessionSecret: SECRET, allowed: allowedEmails("ada@example.com, sam@example.com") };
const ORIGIN = "https://common-ink-v2.example.workers.dev";

/** An ID token as Google's token endpoint returns it (the claims are what matter here). */
const idToken = (claims: Record<string, unknown>) => `x.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.y`;

/** Google's token endpoint and APIs, answering from a table of URL prefixes. */
function fakeGoogle(answers: Record<string, unknown>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ""}`);
    const key = Object.keys(answers).find((k) => url.startsWith(k));
    return key ? Response.json(answers[key]) : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("signed values come back as they were, and forged or expired ones don't", async () => {
  const value = await sign({ email: "ada@example.com" }, SECRET, 60, 1_000_000);
  assert.equal((await verify<{ email: string }>(value, SECRET, 1_000_000))?.email, "ada@example.com");
  assert.equal(await verify(value, "other-secret", 1_000_000), null);
  assert.equal(await verify(value, SECRET, 1_000_000 + 61_000), null);
  assert.equal(await verify(`${value.split(".")[0]}x.${value.split(".")[1]}`, SECRET, 1_000_000), null);
  assert.equal(await verify("nonsense", SECRET), null);
});

async function signIn(claims: Record<string, unknown>, data = false, token: Record<string, unknown> = {}) {
  const start = await signInRoute(new Request(`${ORIGIN}/auth/google?next=/?note=Plan.md${data ? "&data=1" : ""}`), new URL(`${ORIGIN}/auth/google?next=/?note=Plan.md${data ? "&data=1" : ""}`), config, async () => true);
  const location = new URL(start!.headers.get("Location")!);
  const stateCookie = start!.headers.get("Set-Cookie")!.split(";")[0];
  const connected: unknown[] = [];
  const callback = new URL(`${ORIGIN}/auth/google/callback?code=abc&state=${location.searchParams.get("state")}`);
  const res = await signInRoute(
    new Request(callback, { headers: { Cookie: stateCookie } }),
    callback,
    config,
    async (granted) => {
      connected.push(granted);
      return true;
    },
    fakeGoogle({ "https://oauth2.googleapis.com/token": { id_token: idToken(claims), ...token } }),
  );
  return { location, res: res!, connected };
}

test("signing in sends you to Google and back with a session for an allowed address", async () => {
  const { location, res } = await signIn({ aud: "client-1", iss: "https://accounts.google.com", email: "Ada@Example.com", email_verified: true });
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("client_id"), "client-1");
  assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/auth/google/callback`);
  assert.equal(location.searchParams.get("scope"), "openid email profile");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/?note=Plan.md");
  const session = res.headers.getSetCookie().find((c) => c.startsWith("ci_session="))!.split(";")[0];
  assert.equal(await sessionEmail(new Request(ORIGIN, { headers: { Cookie: session } }), SECRET), "ada@example.com");
});

test("an address that isn't allowed, or Google's answer for another app, gets no session", async () => {
  const stranger = await signIn({ aud: "client-1", iss: "accounts.google.com", email: "eve@example.com", email_verified: true });
  assert.equal(stranger.res.status, 403);
  assert.equal(stranger.res.headers.getSetCookie().some((c) => c.startsWith("ci_session=") && !c.startsWith("ci_session=;")), false);
  const otherApp = await signIn({ aud: "someone-else", iss: "accounts.google.com", email: "ada@example.com", email_verified: true });
  assert.equal(otherApp.res.status, 400);
  const unverified = await signIn({ aud: "client-1", iss: "accounts.google.com", email: "ada@example.com", email_verified: false });
  assert.equal(unverified.res.status, 400);
});

test("a callback without the state this browser started with is refused", async () => {
  const url = new URL(`${ORIGIN}/auth/google/callback?code=abc&state=guess`);
  const res = await signInRoute(new Request(url), url, config, async () => true);
  assert.equal(res?.status, 400);
});

test("connecting data asks for calendar and contacts offline, and keeps Google's refresh token", async () => {
  const { location, res, connected } = await signIn(
    { aud: "client-1", iss: "accounts.google.com", email: "ada@example.com", email_verified: true },
    true,
    { refresh_token: "refresh-1", scope: ["openid", ...DATA_SCOPES].join(" ") },
  );
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.ok(location.searchParams.get("scope")!.includes(DATA_SCOPES[0]));
  assert.equal(res.status, 302);
  assert.deepEqual(connected, [{ email: "ada@example.com", refreshToken: "refresh-1", scopes: ["openid", ...DATA_SCOPES] }]);
});

test("with Google connected, events and contacts come from Google, and its formats stay out of the app", async () => {
  const seen: string[] = [];
  const fetcher = fakeGoogle(
    {
      "https://oauth2.googleapis.com/token": { access_token: "access-1" },
      "https://www.googleapis.com/calendar/v3/calendars/primary/events": {
        items: [
          { id: "a", summary: "Standup", start: { dateTime: "2026-10-05T09:00:00Z" }, end: { dateTime: "2026-10-05T09:15:00Z" }, recurringEventId: "s" },
          { id: "b", status: "cancelled", start: { dateTime: "2026-10-06T09:00:00Z" }, end: { dateTime: "2026-10-06T09:15:00Z" } },
          { id: "c", summary: "Offsite", start: { date: "2026-10-08" }, end: { date: "2026-10-10" } },
        ],
      },
      "https://people.googleapis.com/v1/people/me/connections": {
        connections: [{ resourceName: "people/1", names: [{ displayName: "Sam" }], emailAddresses: [{ value: "sam@example.com" }] }, { resourceName: "people/2" }],
      },
    },
    seen,
  );
  const { sources } = memoryStore({ fixtures: false, google }, fetcher);
  await assert.rejects(sources.events("ada@example.com", "2026-10-05T00:00:00Z", "2026-10-19T00:00:00Z"), /isn't connected/);
  assert.deepEqual(sources.status("ada@example.com"), { using: "none", googleAvailable: true });
  assert.equal(sources.connect({ email: "ada@example.com", refreshToken: "r", scopes: ["openid"] }), false, "without the data scopes it isn't connected");
  assert.equal(sources.connect({ email: "ada@example.com", refreshToken: "r", scopes: DATA_SCOPES }), true);
  assert.equal(sources.status("ada@example.com").using, "google");
  assert.deepEqual(await sources.events("ada@example.com", "2026-10-05T00:00:00Z", "2026-10-19T00:00:00Z"), [
    { id: "a", title: "Standup", start: "2026-10-05T09:00:00Z", end: "2026-10-05T09:15:00Z", allDay: false, location: undefined, recurring: true, calendar: "primary" },
    { id: "c", title: "Offsite", start: "2026-10-08", end: "2026-10-10", allDay: true, location: undefined, recurring: false, calendar: "primary" },
  ]);
  assert.ok(seen.some((s) => s.startsWith("GET https://www.googleapis.com/calendar") && s.includes("singleEvents=true") && s.endsWith("Bearer access-1")));
  assert.deepEqual(await sources.contacts("ada@example.com", "sam"), [{ id: "people/1", name: "Sam", emails: ["sam@example.com"], phones: [], organization: undefined }]);
  sources.disconnect("ada@example.com");
  assert.equal(sources.status("ada@example.com").using, "none");
});

test("the recorded fixtures stand in for Google, with the calendar moved to start today", () => {
  const events = fixtures.events("2026-12-01T00:00:00Z", "2026-12-15T00:00:00Z", "2026-12-01");
  assert.deepEqual(
    events.map((e) => [e.title, e.start.slice(0, 10), e.recurring]),
    [
      ["Team standup", "2026-12-01", true],
      ["Team standup", "2026-12-02", true],
      ["Dentist", "2026-12-02", false],
      ["Team offsite", "2026-12-04", false],
      ["Team standup", "2026-12-04", true],
      ["Dinner with Sam", "2026-12-05", false],
      ["Weekly review", "2026-12-08", true],
    ],
  );
  assert.deepEqual(
    fixtures.contacts("example.org").map((c) => c.name),
    ["Ada Lovelace"],
  );
  assert.equal(fixtures.contacts().length, 3, "a person without a name isn't listed");
});

test("data source operations answer for the person, or the person an agent works for", async () => {
  const store = memoryStore();
  const mine = await runOperation("list_contacts", { query: "sam" }, store, { kind: "user", email: "ada@example.com" });
  assert.ok(mine.ok && (mine.value as unknown[]).length === 1);
  const agent = await runOperation("list_events", {}, store, { kind: "agent", name: "Claude", by: "ada@example.com" });
  assert.ok(agent.ok);
  const alone = await runOperation("list_events", {}, store, { kind: "agent", name: "Nightly" });
  assert.deepEqual(alone, { ok: false, error: "Data sources belong to a person, and this agent isn't working for one" });
  const bad = await runOperation("list_events", { from: "2026-10-10T00:00:00Z", to: "2026-10-01T00:00:00Z" }, store, { kind: "user", email: "a@b.c" });
  assert.equal(bad.ok, false);
});

test("Google's ID token is checked for this app and a confirmed email", async () => {
  const answer = (claims: Record<string, unknown>) => fakeGoogle({ "https://oauth2.googleapis.com/token": { id_token: idToken(claims) } });
  await assert.rejects(exchange(google, "c", "r", answer({ aud: "client-1", iss: "https://evil.example", email: "a@b.c", email_verified: true })), /wasn't for this app/);
  assert.equal((await exchange(google, "c", "r", answer({ aud: "client-1", iss: "accounts.google.com", email: "A@B.C", email_verified: true }))).email, "a@b.c");
});
