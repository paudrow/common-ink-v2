// Who is making a request. Deployed, that's whoever Cloudflare Access signed in, proven by the JWT it
// adds to every request. Under `wrangler dev` on this machine, and in a pull request's Preview, it's the
// dev user. Anything else is nobody, so a deploy without its Access settings refuses every request.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Author } from "./files.ts";

/** A person, or an Access service token (how an agent signs in on its own). */
export type Identity = { kind: "user"; email: string } | { kind: "service"; id: string };

export interface AuthConfig {
  /** The Zero Trust team domain, such as "example.cloudflareaccess.com". */
  teamDomain?: string;
  /** The Access application's audience tag. */
  aud?: string;
  /** Set by `npm run dev` and in Previews. Honoured only on this machine or a Preview's address. */
  devUser?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// A pull request's Preview: pr-<n>-common-ink-v2.<subdomain>.workers.dev. Its notes are its own samples,
// so it opens signed in. Production's address never matches, even if DEV_USER leaked into it.
const PREVIEW_HOST = /^pr-\d+-common-ink-v2\.[a-z0-9-]+\.workers\.dev$/;

function devHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || PREVIEW_HOST.test(hostname);
}

const keySets = new Map<string, JWTVerifyGetKey>();
function accessKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (!keys) keySets.set(issuer, (keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))));
  return keys;
}

export async function identify(req: Request, config: AuthConfig, keys = accessKeys): Promise<Identity | null> {
  if (config.devUser && devHost(new URL(req.url).hostname)) return { kind: "user", email: config.devUser };
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !config.teamDomain || !config.aud) return null;
  const issuer = `https://${config.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  try {
    const { payload } = await jwtVerify(token, keys(issuer), { issuer, audience: config.aud, algorithms: ["RS256"] });
    if (typeof payload.email === "string" && payload.email) return { kind: "user", email: payload.email };
    // A service token's JWT names the token instead of a person.
    if (typeof payload.common_name === "string" && payload.common_name) return { kind: "service", id: payload.common_name };
    return null;
  } catch {
    return null;
  }
}

/**
 * Who a change is by. A person is the author, unless their request names the agent working for them
 * (the X-Common-Ink-Agent header, which the CLI and MCP send). A service token is always an agent.
 */
export function authorFor(who: Identity, agent: string | null): Author {
  const name = agent?.trim().slice(0, 60) || null;
  if (who.kind === "service") return { kind: "agent", name: name ?? who.id };
  return name ? { kind: "agent", name, by: who.email } : { kind: "user", email: who.email };
}
