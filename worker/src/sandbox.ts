// The sandbox route: where sandboxed extensions run (ADR 0006). An extension host is a hidden iframe
// with sandbox="allow-scripts", and a webview is a visible one; both load their shell from here, with a
// Content Security Policy that lets scripts come only from this route and lets nothing connect out.
// Requests made from inside a sandboxed frame carry no cookies, so nothing here may depend on them:
// the shells and their scripts are public, and a workspace extension's code is served only against a
// short-lived token the app asks for (signed in) and hands to the host.

export const SANDBOX_PREFIX = "/sandbox/";

/**
 * The app's Content Security Policy. Its own scripts only; connections only to itself (the API and the
 * live socket); images and media from itself, data: and blob:; and frames only from the sandbox route,
 * which also stops a sandboxed frame from navigating itself anywhere else (ADR 0006), and from the
 * hosts of link embeds that are on (a video from youtube-nocookie.com, say). Even code running in the
 * page can't quietly reach a third party.
 */
export function appCsp(origin: string, frameHosts: readonly string[] = []): string {
  const ws = origin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${ws}`,
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `frame-src ${[`${origin}${SANDBOX_PREFIX}`, ...frameHosts.filter((h) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h)).map((h) => `https://${h}`)].join(" ")}`,
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

/** The policy for a sandbox page. Sources are named by full origin and path, narrower than 'self'. */
export function sandboxCsp(origin: string, kind: "host" | "webview"): string {
  const here = `${origin}${SANDBOX_PREFIX}`;
  const common = `default-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'`;
  if (kind === "host") return `${common}; script-src ${here}; img-src 'none'; media-src 'none'`;
  // A webview runs whatever HTML its extension gives it, inline scripts included: it's untrusted as a
  // whole, so what matters is that nothing in it can reach out.
  return `${common}; script-src 'unsafe-inline' ${here}; style-src 'unsafe-inline' ${here}; img-src data: blob: ${here}; media-src data: blob: ${here}; font-src data: ${here}`;
}

/** A sandbox shell page: one script from this route, nothing else. */
export function shellPage(origin: string, kind: "host" | "webview"): Response {
  // A webview is transparent from the first byte, in the app's color schemes: it never paints white while it boots.
  const look = kind === "webview" ? `<meta name="color-scheme" content="light dark"><style>html, body { background: transparent; }</style>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8">${look}<title>${kind === "host" ? "Extension host" : "Webview"}</title></head><body><script src="${SANDBOX_PREFIX}${kind}.js"></script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": sandboxCsp(origin, kind),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

const encoder = new TextEncoder();

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", k, encoder.encode(data)));
}

/** How long a code token lasts: long enough for an extension host to load its modules, and to reload them. */
export const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** A token for one extension's code, good until `expires`. */
export async function signCodeToken(key: string, extension: string, expires: number): Promise<string> {
  const body = `${extension}.${expires}`;
  return `${body}.${await hmac(key, body)}`;
}

/** The extension a code token is for, if it's genuine and current. */
export async function verifyCodeToken(key: string, token: string, now: number): Promise<string | null> {
  const m = /^([a-zA-Z0-9][\w.-]{0,63})\.(\d+)\.([\w-]+)$/.exec(token);
  if (!m || Number(m[2]) < now) return null;
  const expected = await hmac(key, `${m[1]}.${m[2]}`);
  if (expected.length !== m[3].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff === 0 ? m[1] : null;
}

/** Headers for code and libraries served to sandboxed frames: module scripts from an opaque origin are CORS requests. */
export const sandboxScriptHeaders = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};
