import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DATA_SCOPES, exchange } from "../worker/src/google.ts";
import { runOperation } from "../worker/src/operations.ts";
import { cookie, sign, verify } from "../worker/src/session.ts";
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

async function signIn(claims: Record<string, unknown>, data = false, token: Record<string, unknown> = {}, next = "/?note=Plan.md") {
  const startUrl = new URL(`${ORIGIN}/auth/google?next=${encodeURIComponent(next)}${data ? "&data=1" : ""}`);
  const start = await signInRoute(new Request(startUrl), startUrl, config, async () => true);
  const location = new URL(start!.headers.get("Location")!);
  const stateSetCookie = start!.headers.get("Set-Cookie")!;
  const connected: unknown[] = [];
  const sent: string[] = [];
  const callback = new URL(`${ORIGIN}/auth/google/callback?code=abc&state=${location.searchParams.get("state")}`);
  const answer = fakeGoogle({ "https://oauth2.googleapis.com/token": { id_token: idToken(claims), ...token } });
  const res = await signInRoute(
    new Request(callback, { headers: { Cookie: stateSetCookie.split(";")[0] } }),
    callback,
    config,
    async (granted) => {
      connected.push(granted);
      return true;
    },
    (async (input: RequestInfo | URL, init?: RequestInit) => (sent.push(String(init?.body ?? "")), answer(input, init))) as typeof fetch,
  );
  return { location, res: res!, connected, stateSetCookie, sent };
}

const ada = { aud: "client-1", iss: "https://accounts.google.com", email: "ada@example.com", email_verified: true };

/** The session cookie a response sets, as a Cookie header would send it back. */
const sessionCookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("__Host-ci_session="))!.split(";")[0];

test("signing in sends you to Google and back with a session for an allowed address", async () => {
  const { location, res } = await signIn({ aud: "client-1", iss: "https://accounts.google.com", email: "Ada@Example.com", email_verified: true });
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("client_id"), "client-1");
  assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/auth/google/callback`);
  assert.equal(location.searchParams.get("scope"), "openid email profile");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/?note=Plan.md");
  assert.equal(await sessionEmail(new Request(ORIGIN, { headers: { Cookie: sessionCookieOf(res) } }), config), "ada@example.com");
});

test("an address that isn't allowed, or Google's answer for another app, gets no session", async () => {
  const stranger = await signIn({ aud: "client-1", iss: "accounts.google.com", email: "eve@example.com", email_verified: true });
  assert.equal(stranger.res.status, 403);
  assert.equal(stranger.res.headers.getSetCookie().some((c) => c.startsWith("__Host-ci_session=") && !c.startsWith("__Host-ci_session=;")), false);
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

test("after sign-in, next= leads only to a page on this site, however the browser would read it", async () => {
  const landings: Array<[string, string]> = [
    ["/?note=Plan.md", "/?note=Plan.md"],
    ["/Journal/2026-10-05.md#Log", "/Journal/2026-10-05.md#Log"],
    ["/\\evil.example", "/"],
    ["/\t/evil.example", "/"],
    ["/\n/evil.example/", "/"],
    ["//evil.example", "/"],
    ["/a/..//evil.example", "/"],
    ["https://evil.example/", "/"],
  ];
  for (const [next, landing] of landings) {
    const { res } = await signIn(ada, false, {}, next);
    assert.equal(res.headers.get("Location"), landing, JSON.stringify(next));
  }
});

test("a session ends as soon as its address leaves ALLOWED_EMAILS", async () => {
  const { res } = await signIn(ada);
  const req = new Request(ORIGIN, { headers: { Cookie: sessionCookieOf(res) } });
  assert.equal(await sessionEmail(req, config), "ada@example.com");
  assert.equal(await sessionEmail(req, { ...config, allowed: allowedEmails("sam@example.com") }), null);
  assert.equal(await sessionEmail(req, null), null);
});

test("sign-in proves to Google that it finishes the flow it started (PKCE, S256)", async () => {
  const { location, sent } = await signIn(ada);
  const verifier = new URLSearchParams(sent[0]).get("code_verifier") ?? "";
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
});

test("sign-in's cookies are __Host- cookies, so another subdomain such as v1's can't set or replace them", async () => {
  const { res, stateSetCookie } = await signIn(ada);
  assert.match(stateSetCookie, /^__Host-ci_google=[\w.%-]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-ci_session="));
  assert.match(session ?? "", /^__Host-ci_session=[\w.%-]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
});

test("signing out from the app ends the session and clears what the browser kept; another site, or a picture in a note, only gets the button", async () => {
  const url = new URL(`${ORIGIN}/auth/sign-out`);
  const signOut = (init: RequestInit) => signInRoute(new Request(url, init), url, config, async () => true).then((r) => r!);
  const cleared = ["__Host-ci_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax", "ci_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"];
  const fromApp: RequestInit[] = [
    { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" } },
    { headers: { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" } },
    { method: "POST", headers: { Origin: ORIGIN } },
  ];
  for (const init of fromApp) {
    const res = await signOut(init);
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers.getSetCookie(), cleared, JSON.stringify(init));
    assert.equal(res.headers.get("Clear-Site-Data"), '"cache", "storage"');
  }
  const fromElsewhere: RequestInit[] = [
    { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" } },
    { headers: { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate" } },
    // A note's ![](/auth/sign-out), drawn as a picture: same-origin, but not you going there.
    { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" } },
    {},
  ];
  for (const init of fromElsewhere) {
    const res = await signOut(init);
    assert.deepEqual(res.headers.getSetCookie(), [], JSON.stringify(init));
    assert.equal(res.headers.get("Clear-Site-Data"), null);
    assert.match(await res.text(), /<form method="post" action="\/auth\/sign-out">/);
  }
  const forged = await signOut({ method: "POST", headers: { Origin: "https://v1.commonink.app" } });
  assert.equal(forged.status, 403);
  assert.deepEqual(forged.headers.getSetCookie(), []);
});

test("a next= too long for the sign-in cookie still signs you in, landing on the app", async () => {
  const { res } = await signIn(ada, false, {}, `/?note=${"x".repeat(5000)}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "/");
});

test("declining at Google says so, with a way to try again", async () => {
  const startUrl = new URL(`${ORIGIN}/auth/google`);
  const start = await signInRoute(new Request(startUrl), startUrl, config, async () => true);
  const state = new URL(start!.headers.get("Location")!).searchParams.get("state");
  const url = new URL(`${ORIGIN}/auth/google/callback?error=access_denied&state=${state}`);
  const res = await signInRoute(new Request(url, { headers: { Cookie: start!.headers.get("Set-Cookie")!.split(";")[0] } }), url, config, async () => true);
  assert.equal(res!.status, 400);
  assert.match(await res!.text(), /<title>You didn't allow sign-in · Common Ink<\/title>.*<a href="\/auth\/google">Try again<\/a>/s);
});

test("signing out also expires the cookies v1 left on this address", async () => {
  const url = new URL(`${ORIGIN}/auth/sign-out`);
  const res = await signInRoute(new Request(url, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" } }), url, config, async () => true);
  assert.deepEqual(res!.headers.getSetCookie(), [
    "__Host-ci_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    "ci_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
  ]);
});

test("a cookie that isn't validly encoded is no cookie, not an error", async () => {
  const req = new Request(ORIGIN, { headers: { Cookie: "__Host-ci_session=%zz; constructor=1; __proto__=2" } });
  assert.equal(await sessionEmail(req, config), null);
  assert.equal(cookie(new Request(ORIGIN, { headers: { Cookie: "a=1; a=2; toString=3" } }), "toString"), "3");
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

test("with Google connected, contacts come from Google, and its formats stay out of the app", async () => {
  const seen: string[] = [];
  const fetcher = fakeGoogle(
    {
      "https://oauth2.googleapis.com/token": { access_token: "access-1" },
      "https://people.googleapis.com/v1/people/me/connections": {
        connections: [{ resourceName: "people/1", names: [{ displayName: "Sam" }], emailAddresses: [{ value: "sam@example.com" }] }, { resourceName: "people/2" }],
      },
    },
    seen,
  );
  const { sources } = memoryStore({ fixtures: false, google }, fetcher);
  await assert.rejects(sources.contacts("ada@example.com", ""), /isn't connected/);
  assert.equal(sources.status("ada@example.com").using, "none");
  assert.equal(sources.status("ada@example.com").sources[0].state, "not-connected");
  assert.equal(sources.connect({ email: "ada@example.com", refreshToken: "r", scopes: ["openid"] }), false, "without the data scopes it isn't connected");
  assert.equal(sources.connect({ email: "ada@example.com", refreshToken: "r", scopes: DATA_SCOPES }), true);
  assert.equal(sources.status("ada@example.com").using, "google");
  assert.deepEqual(await sources.contacts("ada@example.com", "sam"), [{ id: "people/1", name: "Sam", emails: ["sam@example.com"], phones: [], organization: undefined }]);
  assert.ok(seen.some((s) => s.startsWith("GET https://people.googleapis.com") && s.endsWith("Bearer access-1")));
  sources.disconnect("ada@example.com");
  assert.equal(sources.status("ada@example.com").using, "none");
});

test("the recorded contacts stand in for Google", () => {
  assert.deepEqual(
    fixtures.contacts("example.org").map((c) => c.name),
    ["Ada Lovelace"],
  );
  assert.equal(fixtures.contacts().length, 3, "a person without a name isn't listed");
});

test("contacts answer for the person, or the person an agent works for", async () => {
  const store = memoryStore();
  const mine = await runOperation("list_contacts", { query: "sam" }, store, { kind: "user", email: "ada@example.com" });
  assert.ok(mine.ok && (mine.value as unknown[]).length === 1);
  const agent = await runOperation("list_contacts", {}, store, { kind: "agent", name: "Claude", by: "ada@example.com" });
  assert.ok(agent.ok);
  const alone = await runOperation("list_contacts", {}, store, { kind: "agent", name: "Nightly" });
  assert.deepEqual(alone, { ok: false, error: "Data sources belong to a person, and this agent isn't working for one" });
});

test("Google's ID token is checked for this app and a confirmed email", async () => {
  const answer = (claims: Record<string, unknown>) => fakeGoogle({ "https://oauth2.googleapis.com/token": { id_token: idToken(claims) } });
  await assert.rejects(exchange(google, "c", "r", "v", answer({ aud: "client-1", iss: "https://evil.example", email: "a@b.c", email_verified: true })), /wasn't for this app/);
  assert.equal((await exchange(google, "c", "r", "v", answer({ aud: "client-1", iss: "accounts.google.com", email: "A@B.C", email_verified: true }))).email, "a@b.c");
});
