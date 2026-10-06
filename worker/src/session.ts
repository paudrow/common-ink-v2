// Signed cookies: a session after Google sign-in, and the short-lived state that carries a sign-in
// through Google and back. Each is JSON with an expiry, signed with HMAC-SHA-256 under SESSION_SECRET.

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) keys.set(secret, (k = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])));
  return k;
}

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** `data`, signed, valid for `seconds`. */
export async function sign(data: Record<string, unknown>, secret: string, seconds: number, now = Date.now()): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify({ ...data, exp: Math.floor(now / 1000) + seconds })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** The data in a signed value, or null if it's forged, malformed or expired. */
export async function verify<T extends Record<string, unknown>>(value: string | null | undefined, secret: string, now = Date.now()): Promise<T | null> {
  const [body, sig] = (value ?? "").split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), encoder.encode(body));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T & { exp?: number };
    return typeof data.exp === "number" && data.exp * 1000 > now ? data : null;
  } catch {
    return null;
  }
}

export function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) === name) {
      try {
        return decodeURIComponent(part.slice(at + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setCookie(name: string, value: string, seconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
