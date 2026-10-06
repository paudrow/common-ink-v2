// Fetching a URL someone else chose, safely: what the Worker does for an extension's brokered fetch
// and for link cards. Only http(s), only public hosts (checked by name, by address literal, and by
// what the name resolves to), redirects followed by hand and each one checked again, no credentials
// or referrer, and limits on time and size.

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Largest response body, in bytes. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Keep the body's bytes too (`bytes`), for a picture. */
  binary?: boolean;
  /** Whether a host may be reached: the first address's, and each redirect's to another origin (an extension's declared hosts, say). */
  allowHost?: (host: string) => boolean;
  /** For tests: the fetch and DNS lookup to use. */
  fetcher?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  /** The body as text (UTF-8), cut off at maxBytes. */
  body: string;
  /** The body's bytes, when asked for (`binary`). */
  bytes?: Uint8Array;
  truncated: boolean;
}

export class FetchRefused extends Error {}

const DEFAULTS = { maxBytes: 1_000_000, timeoutMs: 8_000, maxRedirects: 3 };

/** Whether an IPv4 address is one the public internet doesn't route: loopback, private, link-local, shared, multicast or reserved. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** An IPv6 address's eight 16-bit groups, a trailing dotted IPv4 part included, or null if it isn't one. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const gap = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (gap < 0 || (halves.length === 2 && gap === 0)) return null;
  const groups = [...head, ...Array<string>(gap).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Whether an IPv6 address is one the public internet doesn't route, or carries an IPv4 address that
 * is: loopback, unspecified, private (fc00::/7), link-local, site-local, multicast, discard,
 * documentation and Teredo, and IPv4 inside it (mapped, compatible, NAT64, 6to4). Anything that
 * doesn't parse counts as private.
 */
export function isPrivateIPv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const inside = (hi: number, lo: number) => isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return inside(g[6], g[7]);
  if (zero(0, 5) && g[5] === 0xffff) return inside(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return inside(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return !zero(2, 6) || inside(g[6], g[7]);
  if (g[0] === 0x2002) return inside(g[1], g[2]);
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
  // Benchmarking (2001:2::/48) and ORCHID (2001:10::/28); 2001:20::/28 beside it is reachable.
  if (g[0] === 0x2001 && ((g[1] === 2 && g[2] === 0) || (g[1] & 0xfff0) === 0x10)) return true;
  // Documentation (3fff::/20) and SRv6 SIDs (5f00::/16).
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true;
  if (g[0] === 0x5f00) return true;
  // Discard (100::/64) and dummy prefixes (100:0:0:1::/64).
  if (g[0] === 0x100 && zero(1, 3) && (g[3] === 0 || g[3] === 1)) return true;
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Why a URL can't be fetched, or null if it can (as far as its text shows). */
export function refuseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That isn't a URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https addresses can be fetched";
  if (url.username || url.password) return "Addresses with a user name or password can't be fetched";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (IPV4.test(host)) return isPrivateIPv4(host) ? "Private and local addresses can't be fetched" : null;
  if (host.startsWith("[")) return isPrivateIPv6(host) ? "Private and local addresses can't be fetched" : null;
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|intranet|home|lan|corp)$/.test(host)) return "Local names can't be fetched";
  return null;
}

/** A host's addresses, from Cloudflare's DNS over HTTPS. */
async function resolveWithDoh(host: string, fetcher: typeof fetch): Promise<string[]> {
  const ask = async (type: string) => {
    const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: "application/dns-json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (data.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  };
  const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
  return [...a, ...aaaa];
}

async function checkResolved(host: string, resolve: (host: string) => Promise<string[]>) {
  if (IPV4.test(host) || host.startsWith("[")) return;
  const addresses = await resolve(host);
  if (!addresses.length) throw new FetchRefused(`${host} doesn't resolve`);
  if (addresses.some((ip) => (ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip)))) throw new FetchRefused(`${host} resolves to a private address`);
}

/** Read at most `max` bytes of a body as text. */
async function readCapped(res: Response, max: number): Promise<{ body: string; bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { body: "", bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.slice(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { body: new TextDecoder().decode(all), bytes: all, truncated };
}

/** Headers a browser would send to any site: the only ones of the caller's that follow a redirect to another origin. */
const SAFE_HEADERS = /^(accept|accept-language|content-language|content-type|user-agent)$/i;

/** Fetch a URL with every check. Throws FetchRefused for a URL it won't fetch, and on time running out. */
export async function safeFetch(raw: string, o: SafeFetchOptions = {}): Promise<SafeResponse> {
  const fetcher = o.fetcher ?? fetch;
  const resolve = o.resolve ?? ((host: string) => resolveWithDoh(host, fetcher));
  const maxRedirects = o.maxRedirects ?? DEFAULTS.maxRedirects;
  const signal = AbortSignal.timeout(o.timeoutMs ?? DEFAULTS.timeoutMs);
  let url = raw;
  let method = (o.method ?? "GET").toUpperCase();
  let body = o.body;
  // No cookies, no credentials, no referrer: the request carries only what the caller sent.
  let headers = Object.fromEntries(Object.entries(o.headers ?? {}).filter(([k]) => !/^(cookie|authorization|proxy-|host$|referer$)/i.test(k)));
  for (let hop = 0; ; hop++) {
    const refused = refuseUrl(url);
    if (refused) throw new FetchRefused(refused);
    if (hop === 0 && o.allowHost && !o.allowHost(new URL(url).hostname)) throw new FetchRefused(`${new URL(url).hostname} isn't a host it may reach`);
    await checkResolved(new URL(url).hostname.toLowerCase(), resolve);
    let res: Response;
    try {
      res = await fetcher(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, redirect: "manual", signal });
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || signal.aborted) throw new FetchRefused("It took too long");
      throw new FetchRefused(`Couldn't reach ${new URL(url).host}: ${(err as Error).message}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= maxRedirects) throw new FetchRefused("Too many redirects");
      const next = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) [method, body] = ["GET", undefined];
      const notWeb = refuseUrl(next.toString());
      if (notWeb) throw new FetchRefused(notWeb);
      if (next.origin !== new URL(url).origin) {
        if (o.allowHost && !o.allowHost(next.hostname)) throw new FetchRefused(`It was sent on to ${next.hostname}, which it may not reach`);
        // A body and a key meant for one site aren't handed to the next.
        if (body !== undefined && method !== "GET" && method !== "HEAD") throw new FetchRefused(`It was sent on to ${next.hostname} with its body, which only a request to the same site may be`);
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => SAFE_HEADERS.test(k)));
      }
      url = next.toString();
      continue;
    }
    let read: Awaited<ReturnType<typeof readCapped>>;
    try {
      read = await readCapped(res, o.maxBytes ?? DEFAULTS.maxBytes);
    } catch (err) {
      if ((err as Error).name === "TimeoutError" || signal.aborted) throw new FetchRefused("It took too long");
      throw new FetchRefused(`${new URL(url).host} stopped answering: ${(err as Error).message}`);
    }
    const { body: text, bytes, truncated } = read;
    return { url, status: res.status, headers: Object.fromEntries(res.headers), body: text, truncated, ...(o.binary ? { bytes } : {}) };
  }
}
