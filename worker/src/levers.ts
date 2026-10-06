// Test levers (docs/TESTING.md): what makes the app hold still for people and agents testing it. The
// clock, permission prompts, the network extensions reach and being offline, each set from the page's
// address and kept in a cookie, so they last across reloads and the Worker sees them too. They're on
// only where everyone is a dev user anyway (`npm run dev`, the browser tests and Previews): production
// sets neither LEVERS nor DEV_USER, so there the cookie is ignored and the page never loads them, and
// even if it did, commonink.app isn't an address the dev user signs in at.
import { devHost } from "./hosts.ts";

export interface Levers {
  /** Where the page's clock starts, as local time ("2026-10-05T09:00"); it runs on from there. "real" is the real clock. */
  now?: string;
  /** How permission prompts answer: "allow" (once), "deny" (for this session), or "ask" (they show). */
  permissions?: "allow" | "deny" | "ask";
  /** "replay": brokered fetches and link cards answer from recordings and never reach the network. */
  net?: "live" | "replay";
  /** The page acts as if it can't reach the server. */
  offline?: boolean;
  /** The page stands in for a phone, a tablet or a laptop: framed to its size, with its touch, pointer and keyboard (web/src/device.ts). */
  device?: "phone" | "tablet" | "laptop";
}

export const LEVERS_COOKIE = "common-ink-levers";

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Each lever's value from text, or undefined if it isn't one. */
const PARSE: { [K in keyof Levers]-?: (v: string) => Levers[K] } = {
  now: (v) => (v === "real" || (LOCAL_TIME.test(v) && !Number.isNaN(Date.parse(v))) ? v : undefined),
  permissions: (v) => (v === "allow" || v === "deny" || v === "ask" ? v : undefined),
  net: (v) => (v === "live" || v === "replay" ? v : undefined),
  offline: (v) => (v === "1" || v === "true" ? true : v === "0" || v === "false" ? false : undefined),
  device: (v) => (v === "phone" || v === "tablet" || v === "laptop" ? v : undefined),
};

/** The address parameters that are levers. */
export const LEVER_NAMES = Object.keys(PARSE) as Array<keyof Levers>;

/** Levers named in `params`, over `base`: a lever given an empty value is cleared, and one that doesn't parse is left as it was. */
export function readLevers(params: URLSearchParams, base: Levers = {}): Levers {
  const out: Record<string, unknown> = { ...base };
  for (const name of LEVER_NAMES) {
    const raw = params.get(name);
    if (raw === null) continue;
    if (raw === "") delete out[name];
    else if (PARSE[name](raw) !== undefined) out[name] = PARSE[name](raw);
  }
  return out as Levers;
}

/** Levers as address parameters, in a fixed order. */
export function leverParams(levers: Levers): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of LEVER_NAMES) {
    const v = levers[name];
    if (v !== undefined) params.set(name, typeof v === "boolean" ? (v ? "1" : "0") : v);
  }
  return params;
}

/** The levers a Cookie header carries. */
export function leversFromCookie(header: string | null | undefined): Levers {
  const raw = (header ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${LEVERS_COOKIE}=`))
    ?.slice(LEVERS_COOKIE.length + 1);
  if (!raw) return {};
  try {
    return readLevers(new URLSearchParams(decodeURIComponent(raw)));
  } catch {
    return {};
  }
}

/** The cookie that keeps `levers`, for the page to set. */
export function leversCookie(levers: Levers): string {
  return `${LEVERS_COOKIE}=${encodeURIComponent(leverParams(levers).toString())}; Path=/; SameSite=Lax`;
}

/** Whether this request gets levers: only where LEVERS is on and everyone is the dev user, on an address the dev user signs in at. */
export function leversOn(env: { LEVERS?: string; DEV_USER?: string }, url: URL): boolean {
  return env.LEVERS === "1" && !!env.DEV_USER && devHost(url.hostname);
}

/** The instant a `now` lever names: a date alone is its local midnight. Null for the real clock. */
export function leverInstant(now: string | undefined): number | null {
  if (!now || now === "real") return null;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(now) ? `${now}T00:00` : now);
}

/** What the app's page is told when levers are on: the scenario its workspace was seeded from, and that scenario's clock. */
export interface LeversPage {
  scenario: string;
  /** The clock a scenario starts at, unless the levers say otherwise. */
  now?: string;
}

export const LEVERS_META = "common-ink-levers";

/** The close code an open page's live socket gets when its workspace is reset: the page loads again. */
export const RESET_CLOSE = 4000;
