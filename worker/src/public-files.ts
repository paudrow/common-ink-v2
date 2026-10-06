// Files anyone may fetch without signing in: the site's icons, its manifest and its link-preview image.
// Tabs, home screens and link-preview crawlers ask for them without a session, and browsers fetch the
// manifest without cookies even when you're signed in. Exact paths only, each with its type.
const PUBLIC_FILES: Record<string, string> = {
  "/favicon.ico": "image/x-icon",
  "/favicon.svg": "image/svg+xml",
  "/apple-touch-icon.png": "image/png",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png",
  "/site.webmanifest": "application/manifest+json",
  "/social.png": "image/png",
};

/** One of the public files from the web app's build, or null if the request isn't for one. */
export async function publicFile(req: Request, url: URL, assets: Fetcher): Promise<Response | null> {
  if (!Object.hasOwn(PUBLIC_FILES, url.pathname) || (req.method !== "GET" && req.method !== "HEAD")) return null;
  const file = await assets.fetch(req);
  // A file missing from the build comes back as the app's page: never hand that out as an icon.
  if (file.headers.get("Content-Type")?.startsWith("text/html")) return new Response("Not found\n", { status: 404 });
  const out = new Response(file.body, file);
  out.headers.set("Content-Type", PUBLIC_FILES[url.pathname]);
  // Not named by their contents, so a day: a new icon reaches everyone by tomorrow.
  out.headers.set("Cache-Control", "public, max-age=86400");
  return out;
}
