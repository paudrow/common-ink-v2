// Where a request belongs before anything else runs. www.commonink.app redirects to commonink.app,
// since Google sign-in returns only to addresses registered with it. Links people kept from Common
// Ink v1 (shared links, invites, meeting notes written into Google events, its docs) go on to
// v1.commonink.app, where v1 still runs.

export const V1_ORIGIN = "https://v1.commonink.app";

/** v1's addresses that v2 doesn't have: a path under one of these goes to v1. */
const V1_PATH = /^\/(s|invite|notes|docs|privacy|terms)(\/|\.html$|$)/;

/**
 * Where to send a request instead, or null to answer it here. The move to v1 is temporary (302), so
 * v2 can take one of those paths later without browsers holding on to the redirect.
 */
export function redirectFor(url: URL): { location: string; status: 301 | 302 } | null {
  if (url.hostname.startsWith("www.")) {
    const apex = new URL(url);
    apex.hostname = url.hostname.slice("www.".length);
    return { location: apex.toString(), status: 301 };
  }
  if (V1_PATH.test(url.pathname)) return { location: `${V1_ORIGIN}${url.pathname}${url.search}`, status: 302 };
  return null;
}
