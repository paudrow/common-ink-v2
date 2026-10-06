// Google's refresh tokens at rest: sealed with AES-GCM under a key derived (HKDF) from a secret the
// Worker has (SESSION_SECRET), so someone who can read the workspace's database (a backup, the
// dashboard's data browser) can't use them without the secret too. Rotating the secret leaves them
// unreadable: the calendar says to reconnect Google, and what waited to go out is kept until you do.

const SEALED = "sealed:";
const PREFIX = "sealed:v1:";
const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((base) =>
        crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("common-ink"), info: encoder.encode("refresh tokens") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
      );
    keys.set(secret, k);
  }
  return k;
}

/** Whether a stored value is sealed, in this version or any other. */
export const isSealed = (stored: string) => stored.startsWith(SEALED);

/** A token, sealed under `secret`. */
export async function seal(secret: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), encoder.encode(token)));
  return `${PREFIX}${b64url(iv)}.${b64url(sealed)}`;
}

/** The token a stored value holds: one kept before sealing as it is, a sealed one opened, or null if `secret` can't open it or it's sealed some other way. */
export async function unseal(secret: string | undefined, stored: string): Promise<string | null> {
  if (!isSealed(stored)) return stored;
  if (!stored.startsWith(PREFIX)) return null;
  const [iv, sealed] = stored.slice(PREFIX.length).split(".");
  if (!secret || !iv || !sealed) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await key(secret), fromB64url(sealed)));
  } catch {
    return null;
  }
}
