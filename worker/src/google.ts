// Google: sign-in (OpenID Connect) and, once you connect them, your calendar and contacts. The Worker
// talks to Google directly; refresh tokens stay in the workspace's Durable Object and never reach a page.
import { toContact, type Contact, type GooglePerson } from "./sources.ts";

export const SIGN_IN_SCOPES = ["openid", "email", "profile"];
/**
 * The least that calendar and contacts need. calendar.events reads and writes events on every calendar
 * you can see; calendar.calendarlist.readonly lists those calendars with their colours. Contacts stay
 * read-only.
 */
export const DATA_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
];

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Where to send the browser to sign in, and to connect calendar and contacts when `data` is set.
 * `challenge` is the PKCE challenge (S256) for the verifier that `exchange` sends back.
 */
export function authorizeUrl(config: GoogleConfig, redirectUri: string, state: string, data: boolean, challenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...SIGN_IN_SCOPES, ...(data ? DATA_SCOPES : [])].join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Only connecting data needs a refresh token, and Google gives one only with consent.
    ...(data ? { access_type: "offline", prompt: "consent", include_granted_scopes: "true" } : { prompt: "select_account" }),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface Granted {
  email: string;
  refreshToken?: string;
  scopes: string[];
}

/** How long one call to Google may take before it's given up. */
export const GOOGLE_TIMEOUT = 30_000;

/** Statuses whose answers have no body. */
const BODILESS = new Set([101, 204, 205, 304]);

/**
 * A fetch to Google that fails, saying so, if Google doesn't answer in `timeout` ms. The body is read
 * here too, so one that stops partway fails the same way, not as a bare abort where it's read.
 */
export async function sendToGoogle(fetcher: typeof fetch, url: string, init: RequestInit, timeout = GOOGLE_TIMEOUT): Promise<Response> {
  try {
    const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) });
    const body = BODILESS.has(res.status) ? null : await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") throw new Error(`Google didn't answer within ${timeout / 1000} seconds`);
    throw err;
  }
}

/**
 * Trade the code from Google's redirect for who signed in. The ID token comes straight from Google
 * over TLS in answer to our client secret, so OpenID Connect lets us read it without checking its
 * signature; its audience, issuer and email are still checked.
 */
export async function exchange(config: GoogleConfig, code: string, redirectUri: string, verifier: string, fetcher: typeof fetch = fetch, timeout = GOOGLE_TIMEOUT): Promise<Granted> {
  const res = await sendToGoogle(fetcher, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
  }, timeout);
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status})`);
  const token = (await res.json()) as { id_token?: string; refresh_token?: string; scope?: string };
  const claims = JSON.parse(atob((token.id_token ?? "").split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "") || "{}") as {
    aud?: string;
    iss?: string;
    email?: string;
    email_verified?: boolean;
  };
  if (claims.aud !== config.clientId || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "")) throw new Error("Google's answer wasn't for this app");
  if (!claims.email || claims.email_verified !== true) throw new Error("Google didn't confirm an email address");
  return { email: claims.email.toLowerCase(), refreshToken: token.refresh_token, scopes: (token.scope ?? "").split(" ").filter(Boolean) };
}

/** A fresh access token from a refresh token. */
export async function accessToken(config: GoogleConfig, refreshToken: string, fetcher: typeof fetch = fetch, timeout = GOOGLE_TIMEOUT): Promise<string> {
  const res = await sendToGoogle(fetcher, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  }, timeout);
  if (!res.ok) throw new Error(`Google refused the connection (${res.status}); connect Google again`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Your contacts, all pages of them. */
export async function contacts(token: string, fetcher: typeof fetch = fetch, timeout = GOOGLE_TIMEOUT): Promise<Contact[]> {
  const out: Contact[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ personFields: "names,emailAddresses,phoneNumbers,organizations", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const res = await sendToGoogle(fetcher, `https://people.googleapis.com/v1/people/me/connections?${params}`, { headers: { Authorization: `Bearer ${token}` } }, timeout);
    if (!res.ok) throw new Error(`Google Contacts answered ${res.status}`);
    const body = (await res.json()) as { connections?: GooglePerson[]; nextPageToken?: string };
    out.push(...(body.connections ?? []).map(toContact).filter((c): c is Contact => c !== null));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
