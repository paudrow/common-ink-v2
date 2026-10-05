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

/** Where to send the browser to sign in, and to connect calendar and contacts when `data` is set. */
export function authorizeUrl(config: GoogleConfig, redirectUri: string, state: string, data: boolean): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...SIGN_IN_SCOPES, ...(data ? DATA_SCOPES : [])].join(" "),
    state,
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

/**
 * Trade the code from Google's redirect for who signed in. The ID token comes straight from Google
 * over TLS in answer to our client secret, so OpenID Connect lets us read it without checking its
 * signature; its audience, issuer and email are still checked.
 */
export async function exchange(config: GoogleConfig, code: string, redirectUri: string, fetcher: typeof fetch = fetch): Promise<Granted> {
  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
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
export async function accessToken(config: GoogleConfig, refreshToken: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Google refused the connection (${res.status}); connect Google again`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Your contacts, all pages of them. */
export async function contacts(token: string, fetcher: typeof fetch = fetch): Promise<Contact[]> {
  const out: Contact[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ personFields: "names,emailAddresses,phoneNumbers,organizations", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
    const res = await fetcher(`https://people.googleapis.com/v1/people/me/connections?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google Contacts answered ${res.status}`);
    const body = (await res.json()) as { connections?: GooglePerson[]; nextPageToken?: string };
    out.push(...(body.connections ?? []).map(toContact).filter((c): c is Contact => c !== null));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
