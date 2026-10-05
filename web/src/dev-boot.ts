// Whether this page has test levers (docs/TESTING.md): the Worker says so in a <meta> it adds only where
// levers are on, never in production. With it, the levers' code (./dev/) loads before the app starts;
// without it, that code is never fetched.
import { LEVERS_META, type LeversPage } from "../../worker/src/levers.ts";

/** What the Worker told this page about its levers, or null where there are none. */
export function leversPage(): LeversPage | null {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${LEVERS_META}"]`);
  if (!meta) return null;
  try {
    return JSON.parse(meta.content) as LeversPage;
  } catch {
    return null;
  }
}

/** Start the levers, if this page has them: the clock, the network and the checks go in before the app runs. */
export async function bootLevers() {
  const page = leversPage();
  return page ? (await import("./dev/index.ts")).boot(page) : null;
}
