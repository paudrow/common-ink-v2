// Google's refresh tokens at rest: sealed with a key from a secret, opened only to ask Google for an
// access token, put right if kept before sealing, and revoked at Google when you disconnect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openWorkspace } from "../worker/src/data-sources.ts";
import { DATA_SCOPES } from "../worker/src/google.ts";
import { memoryDb } from "./sqlite.ts";

const google = { clientId: "client-1", clientSecret: "shh" };
const ada = { email: "ada@example.com", refreshToken: "1//refresh-ada", scopes: DATA_SCOPES };

/** Google's token, revoke and People endpoints, keeping each form Google was sent. */
function fakeGoogle() {
  const sent: Array<[string, Record<string, string>]> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).split("?")[0];
    sent.push([url, Object.fromEntries(new URLSearchParams(String(init?.body ?? "")))]);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-1", expires_in: 3600 });
    if (url === "https://oauth2.googleapis.com/revoke") return new Response(null, { status: 200 });
    return Response.json({ connections: [] });
  }) as typeof fetch;
  return { sent, fetcher };
}

const stored = (db: ReturnType<typeof memoryDb>) => db.all<{ refresh_token: string }>("SELECT refresh_token FROM connections").map((r) => r.refresh_token);

test("a refresh token is kept sealed under a key from a secret, and Google still gets it as it gave it", async () => {
  const db = memoryDb();
  const { sent, fetcher } = fakeGoogle();
  const { sources } = openWorkspace(db, { fixtures: false, google, tokenKey: "session-secret-1" }, undefined, fetcher);
  assert.equal(await sources.connect(ada), true);
  const [kept] = stored(db);
  assert.match(kept, /^sealed:v1:[\w-]+\.[\w-]+$/);
  assert.ok(!kept.includes("refresh-ada"), "the database never holds the token itself");
  await sources.contacts("ada@example.com", "");
  assert.deepEqual(sent[0], ["https://oauth2.googleapis.com/token", { client_id: "client-1", client_secret: "shh", refresh_token: "1//refresh-ada", grant_type: "refresh_token" }]);
});

test("a token kept before sealing still works and is sealed when tokens are put right; under another key, it's as if nobody connected", async () => {
  const db = memoryDb();
  const { sent, fetcher } = fakeGoogle();
  openWorkspace(db, { fixtures: false, google }, undefined, fetcher).sources.connect(ada);
  assert.deepEqual(stored(db), ["1//refresh-ada"]);
  const { sources } = openWorkspace(db, { fixtures: false, google, tokenKey: "session-secret-1" }, undefined, fetcher);
  await sources.sealTokens();
  assert.match(stored(db)[0], /^sealed:v1:/);
  await sources.contacts("ada@example.com", "");
  assert.equal(sent.at(-2)?.[1].refresh_token, "1//refresh-ada");
  const rotated = openWorkspace(db, { fixtures: false, google, tokenKey: "session-secret-2" }, undefined, fetcher).sources;
  await assert.rejects(rotated.contacts("ada@example.com", ""), /isn't connected/);
});

test("disconnecting revokes the token at Google, then forgets it", async () => {
  const db = memoryDb();
  const { sent, fetcher } = fakeGoogle();
  const { sources } = openWorkspace(db, { fixtures: false, google, tokenKey: "session-secret-1" }, undefined, fetcher);
  await sources.connect(ada);
  await sources.disconnect("ada@example.com");
  assert.deepEqual(sent, [["https://oauth2.googleapis.com/revoke", { token: "1//refresh-ada" }]]);
  assert.deepEqual(stored(db), []);
  assert.equal(sources.status("ada@example.com").using, "none");
});

test("a sealed token of a version this code doesn't know is as if nobody connected, and isn't sealed again", async () => {
  const db = memoryDb();
  const { fetcher } = fakeGoogle();
  const { sources } = openWorkspace(db, { fixtures: false, google, tokenKey: "session-secret-1" }, undefined, fetcher);
  await sources.connect(ada);
  db.run("UPDATE connections SET refresh_token = ?", "sealed:v9:abc.def");
  await assert.rejects(sources.contacts("ada@example.com", ""), /isn't connected/);
  await sources.sealTokens();
  assert.deepEqual(stored(db), ["sealed:v9:abc.def"]);
});

test("a revoke Google never answers doesn't hold up disconnecting", async () => {
  const db = memoryDb();
  const hang = ((_url: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const { sources } = openWorkspace(db, { fixtures: false, google, tokenKey: "session-secret-1" }, undefined, hang);
  await sources.connect(ada);
  const keepAlive = setTimeout(() => {}, 10_000);
  const started = Date.now();
  await sources.disconnect("ada@example.com");
  clearTimeout(keepAlive);
  assert.ok(Date.now() - started < 6000, "it gave up on Google");
  assert.deepEqual(stored(db), []);
});
