import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authorFor, identify, type AuthConfig } from "../worker/src/auth.ts";

const TEAM = "example.cloudflareaccess.com";
const AUD = "app-audience";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const keys = () => jwks;
const config: AuthConfig = { teamDomain: TEAM, aud: AUD };

function token(claims: { aud?: string; iss?: string; email?: string; exp?: string; common_name?: string } = {}) {
  const who = claims.common_name !== undefined ? { common_name: claims.common_name } : { email: claims.email ?? "ada@example.com" };
  return new SignJWT(who)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(privateKey);
}

function request(jwt?: string, url = "https://common-ink-v2.example.workers.dev/api/me") {
  return new Request(url, { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });
}

test("a valid Access JWT signs in its email", async () => {
  assert.deepEqual(await identify(request(await token()), config, keys), { kind: "user", email: "ada@example.com" });
});

test("the team domain may be written as a URL", async () => {
  assert.deepEqual(await identify(request(await token()), { ...config, teamDomain: `https://${TEAM}/` }, keys), { kind: "user", email: "ada@example.com" });
});

test("a JWT for another application, another team, or out of date is refused", async () => {
  assert.equal(await identify(request(await token({ aud: "other-app" })), config, keys), null);
  assert.equal(await identify(request(await token({ iss: "https://other.cloudflareaccess.com" })), config, keys), null);
  assert.equal(await identify(request(await token({ exp: "-1m" })), config, keys), null);
  assert.equal(await identify(request("not-a-jwt"), config, keys), null);
});

test("a service token's JWT signs in the token, and a JWT naming no one is refused", async () => {
  assert.deepEqual(await identify(request(await token({ common_name: "abc.access" })), config, keys), { kind: "service", id: "abc.access" });
  assert.equal(await identify(request(await token({ email: "" })), config, keys), null);
});

test("no JWT, or no Access settings, is refused", async () => {
  assert.equal(await identify(request(), config, keys), null);
  assert.equal(await identify(request(await token()), {}, keys), null);
  assert.equal(await identify(request(await token()), { teamDomain: TEAM }, keys), null);
});

test("the dev user works only on this machine and in a pull request's Preview", async () => {
  const dev = { devUser: "dev@localhost" };
  assert.deepEqual(await identify(request(undefined, "http://localhost:8787/api/me"), dev, keys), { kind: "user", email: "dev@localhost" });
  assert.deepEqual(await identify(request(undefined, "http://127.0.0.1:8787/"), dev, keys), { kind: "user", email: "dev@localhost" });
  assert.deepEqual(await identify(request(undefined, "https://pr-12-common-ink-v2.example.workers.dev/"), dev, keys), { kind: "user", email: "dev@localhost" });
  assert.equal(await identify(request(undefined, "https://common-ink-v2.example.workers.dev/"), dev, keys), null);
  assert.equal(await identify(request(undefined, "https://abc123-common-ink-v2.example.workers.dev/"), dev, keys), null);
  assert.equal(await identify(request(undefined, "https://pr-12-common-ink-v2.example.workers.dev.evil.com/"), dev, keys), null);
});

test("a person's request is theirs, unless it names the agent working for them", () => {
  const ada = { kind: "user" as const, email: "ada@example.com" };
  assert.deepEqual(authorFor(ada, null), { kind: "user", email: "ada@example.com" });
  assert.deepEqual(authorFor(ada, " Claude "), { kind: "agent", name: "Claude", by: "ada@example.com" });
  assert.deepEqual([authorFor(ada, ""), authorFor(ada, "   ")], [{ kind: "agent", name: "Unnamed agent", by: "ada@example.com" }, { kind: "agent", name: "Unnamed agent", by: "ada@example.com" }], "an empty agent header is never the person");
  assert.deepEqual(authorFor({ kind: "service", id: "abc.access" }, null), { kind: "agent", name: "abc.access" });
  assert.deepEqual(authorFor({ kind: "service", id: "abc.access" }, "Nightly"), { kind: "agent", name: "Nightly" });
});
