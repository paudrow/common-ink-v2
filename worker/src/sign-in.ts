// Sign in with Google: /auth/google sends you to Google, /auth/google/callback brings you back with a
// session cookie, and /auth/sign-out ends it. Only addresses in ALLOWED_EMAILS get in. Adding
// ?data=1 also asks for your calendar and contacts, and keeps Google's refresh token for them.
import { authorizeUrl, exchange, type GoogleConfig, type Granted } from "./google.ts";
import { cookie, setCookie, sign, verify } from "./session.ts";

export const SESSION_COOKIE = "ci_session";
const STATE_COOKIE = "ci_google";
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

/** The person a session cookie names, if it's genuine and current. */
export async function sessionEmail(req: Request, secret: string | undefined): Promise<string | null> {
  if (!secret) return null;
  const data = await verify<{ email?: string }>(cookie(req, SESSION_COOKIE), secret);
  return typeof data?.email === "string" ? data.email : null;
}

/** A page of our own, for the few moments the app isn't on screen. */
export function page(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Common Ink</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:28rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5}a{color:#2f5fd0}</style></head>
<body><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Only paths on this site, so a sign-in link can't send you somewhere else afterwards. */
const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/");

/**
 * Answer an /auth/ route. `connect` keeps a data connection once Google has granted it. Null if the
 * path isn't a sign-in route.
 */
export async function signInRoute(req: Request, url: URL, config: SignInConfig | null, connect: (granted: Granted) => Promise<boolean>, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const redirectUri = `${url.origin}/auth/google/callback`;
  if (url.pathname === "/auth/sign-out") {
    return page("Signed out", `<p><a href="/auth/google">Sign in again</a></p>`, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  }
  if (url.pathname === "/auth/google") {
    if (!config) return page("Google sign-in isn't set up", "<p>Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET for this Worker.</p>", 503);
    const data = url.searchParams.get("data") === "1";
    const nonce = crypto.randomUUID();
    const state = await sign({ nonce, next: safeNext(url.searchParams.get("next")), data }, config.sessionSecret, STATE_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { Location: authorizeUrl(config.google, redirectUri, nonce, data), "Set-Cookie": setCookie(STATE_COOKIE, state, STATE_SECONDS) },
    });
  }
  if (url.pathname === "/auth/google/callback") {
    if (!config) return page("Google sign-in isn't set up", "", 503);
    const state = await verify<{ nonce: string; next: string; data: boolean }>(cookie(req, STATE_COOKIE), config.sessionSecret);
    const code = url.searchParams.get("code");
    if (!state || !code || url.searchParams.get("state") !== state.nonce) {
      return page("Sign-in didn't finish", `<p>It took too long or came from somewhere else. <a href="/auth/google">Try again</a>.</p>`, 400);
    }
    let granted: Granted;
    try {
      granted = await exchange(config.google, code, redirectUri, fetcher);
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
    const headers = new Headers({ Location: state.next });
    headers.append("Set-Cookie", setCookie(SESSION_COOKIE, session, SESSION_SECONDS));
    headers.append("Set-Cookie", setCookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }
  return null;
}
