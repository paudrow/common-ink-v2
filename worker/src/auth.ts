// Who is making a request. Deployed, that's whoever signed in with Google (a session cookie), or whoever
// Cloudflare Access signed in, proven by the JWT it adds to every request. Under `wrangler dev` on this machine, and in a pull request's Preview, it's the
// dev user. Anything else is nobody, so a deploy without its Access settings refuses every request.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { EXTENSION_ID } from "./extensions.ts";
import type { Author } from "./files.ts";
import { devHost } from "./hosts.ts";

/** A person, or an Access service token (how an agent signs in on its own). */
export type Identity = { kind: "user"; email: string } | { kind: "service"; id: string };

export interface AuthConfig {
  /** The Zero Trust team domain, such as "example.cloudflareaccess.com". */
  teamDomain?: string;
  /** The Access application's audience tag. */
  aud?: string;
  /** Set by `npm run dev` and in Previews. Honoured only on this machine or a Preview's address. */
  devUser?: string;
  /** Checks the session cookie from Google sign-in. */
  sessionEmail?: (req: Request) => Promise<string | null>;
}


const keySets = new Map<string, JWTVerifyGetKey>();
function accessKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (!keys) keySets.set(issuer, (keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))));
  return keys;
}

export async function identify(req: Request, config: AuthConfig, keys = accessKeys): Promise<Identity | null> {
  if (config.devUser && devHost(new URL(req.url).hostname)) return { kind: "user", email: config.devUser };
  const signedIn = await config.sessionEmail?.(req);
  if (signedIn) return { kind: "user", email: signedIn };
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
export function authorFor(who: Identity, agent: string | null, extension: string | null = null): Author {
  // An extension acting in the app, for the person using it. Its id is checked like any extension id.
  if (extension && who.kind !== "service" && EXTENSION_ID.test(extension)) return { kind: "extension", id: extension, by: who.email };
  const name = agent?.trim().slice(0, 60) || null;
  if (who.kind === "service") return { kind: "agent", name: name ?? who.id };
  return name ? { kind: "agent", name, by: who.email } : { kind: "user", email: who.email };
}
