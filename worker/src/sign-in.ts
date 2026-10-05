// Sign in with Google: /auth/google sends you to Google, /auth/google/callback brings you back with a
// session cookie, and /auth/sign-out ends it. Only addresses in ALLOWED_EMAILS get in, and a session
// lasts only while its address is still there. Adding ?data=1 also asks for your calendar and
// contacts, and keeps Google's refresh token for them.
import { authorizeUrl, exchange, type GoogleConfig, type Granted } from "./google.ts";
import { b64url, cookie, setCookie, sign, verify } from "./session.ts";

// __Host- cookies are Secure, for this host only and the whole site, so no other subdomain of
// commonink.app (v1's included) can set or replace them.
export const SESSION_COOKIE = "__Host-ci_session";
const STATE_COOKIE = "__Host-ci_google";
const SESSION_SECONDS = 30 * 86_400;
const STATE_SECONDS = 600;

export interface SignInConfig {
  google: GoogleConfig;
  sessionSecret: string;
  allowed: Set<string>;
}

/** ALLOWED_EMAILS: addresses separated by commas or spaces. */
export function allowedEmails(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/** The person a session cookie names, if it's genuine, current, and still allowed in. */
export async function sessionEmail(req: Request, config: SignInConfig | null): Promise<string | null> {
  if (!config) return null;
  const data = await verify<{ email?: string }>(cookie(req, SESSION_COOKIE), config.sessionSecret);
  return typeof data?.email === "string" && config.allowed.has(data.email) ? data.email : null;
}

/** A page of our own, for the few moments the app isn't on screen. */
export function page(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Common Ink</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:28rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5}a{color:#2f5fd0}</style></head>
<body><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Only paths on this site, so a sign-in link can't send you somewhere else afterwards. It's read the
 * way a browser reads a Location, which turns "\" into "/" and drops tabs and newlines (so "/\evil"
 * and "/<tab>/evil" are "//evil"), and what goes back out is that reading.
 */
function safeNext(next: string | null): string {
  const base = "https://next.invalid";
  if (!next?.startsWith("/")) return "/";
  try {
    const u = new URL(next, base);
    const path = `${u.pathname}${u.search}${u.hash}`;
    return u.origin === base && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}

/** A PKCE verifier and its S256 challenge. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) };
}

/** Whether a sign-out came from the app (or was typed), not from another site: signing out also clears what this browser kept. */
function fromHere(req: Request, url: URL): boolean {
  if (req.method === "POST") return req.headers.get("Origin") === url.origin;
  const site = req.headers.get("Sec-Fetch-Site");
  return site === "same-origin" || site === "none";
}

/**
 * Answer an /auth/ route. `connect` keeps a data connection once Google has granted it. Null if the
 * path isn't a sign-in route.
 */
export async function signInRoute(req: Request, url: URL, config: SignInConfig | null, connect: (granted: Granted) => Promise<boolean>, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const redirectUri = `${url.origin}/auth/google/callback`;
  if (url.pathname === "/auth/sign-out") {
    // Another site linking here gets a button, not a sign-out: clearing storage would lose unsent edits.
    if (!fromHere(req, url)) {
      if (req.method === "POST") return page("Not from here", "<p>That request came from another site.</p>", 403);
      return page("Sign out", `<form method="post" action="/auth/sign-out"><button>Sign out of Common Ink</button></form>`);
    }
    // The browser's copy of the workspace (offline cache, unsent edits, the app's code) goes too.
    return page("Signed out", `<p><a href="/auth/google">Sign in again</a></p>`, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0), "Clear-Site-Data": '"cache", "storage"' });
  }
  if (url.pathname === "/auth/google") {
    if (!config) return page("Google sign-in isn't set up", "<p>Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET for this Worker.</p>", 503);
    const data = url.searchParams.get("data") === "1";
    const nonce = crypto.randomUUID();
    const { verifier, challenge } = await pkce();
    const state = await sign({ nonce, verifier, next: safeNext(url.searchParams.get("next")), data }, config.sessionSecret, STATE_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { Location: authorizeUrl(config.google, redirectUri, nonce, data, challenge), "Set-Cookie": setCookie(STATE_COOKIE, state, STATE_SECONDS) },
    });
  }
  if (url.pathname === "/auth/google/callback") {
    if (!config) return page("Google sign-in isn't set up", "", 503);
    const state = await verify<{ nonce: string; verifier: string; next: string; data: boolean }>(cookie(req, STATE_COOKIE), config.sessionSecret);
    const code = url.searchParams.get("code");
    if (!state || !code || typeof state.verifier !== "string" || url.searchParams.get("state") !== state.nonce) {
      return page("Sign-in didn't finish", `<p>It took too long or came from somewhere else. <a href="/auth/google">Try again</a>.</p>`, 400);
    }
    let granted: Granted;
    try {
      granted = await exchange(config.google, code, redirectUri, state.verifier, fetcher);
    } catch (err) {
      return page("Sign-in didn't finish", `<p>${escape((err as Error).message)}. <a href="/auth/google">Try again</a>.</p>`, 400);
    }
    if (!config.allowed.has(granted.email)) {
      return page("Not on the list", `<p>${escape(granted.email)} can't use this Common Ink. Ask its owner to add you to ALLOWED_EMAILS, or <a href="/auth/google">use another account</a>.</p>`, 403);
    }
    if (state.data && !(await connect(granted))) {
      return page("Calendar and contacts weren't connected", `<p>Google didn't grant everything they need. <a href="/auth/google?data=1">Try again</a> and tick every box.</p>`, 400);
    }
    const session = await sign({ email: granted.email }, config.sessionSecret, SESSION_SECONDS);
    const headers = new Headers({ Location: safeNext(state.next) });
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, session, SESSION_SECONDS));
    headers.append("Set-Cookie", setCookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }
  return null;
}
