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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// A pull request's Preview: pr-<n>-common-ink-v2.<subdomain>.workers.dev. Its notes are its own samples,
// so it opens signed in. Production's address never matches, even if DEV_USER leaked into it.
const PREVIEW_HOST = /^pr-\d+-common-ink-v2\.[a-z0-9-]+\.workers\.dev$/;

/** This machine, or a pull request's Preview: where the dev user is signed in, and test levers work. */
export function devHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || PREVIEW_HOST.test(hostname);
}
