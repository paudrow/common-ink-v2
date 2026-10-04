// Who is making a request. Deployed, that's whoever Cloudflare Access signed in, proven by the JWT it
// adds to every request. Under `wrangler dev` on this machine, and in a pull request's Preview, it's the
// dev user. Anything else is nobody, so a deploy without its Access settings refuses every request.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface Identity {
  email: string;
}

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
  if (config.devUser && devHost(new URL(req.url).hostname)) return { email: config.devUser };
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !config.teamDomain || !config.aud) return null;
  const issuer = `https://${config.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  try {
    const { payload } = await jwtVerify(token, keys(issuer), { issuer, audience: config.aud, algorithms: ["RS256"] });
    return typeof payload.email === "string" && payload.email ? { email: payload.email } : null;
  } catch {
    return null;
  }
}
