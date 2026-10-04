// Keeps the app itself (its page, scripts and styles) so it opens without a connection. Files are not
// kept here: the app caches those itself, and holds edits it couldn't send (web/src/offline.ts).
const CACHE = "common-ink-app-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // Built scripts and styles never change under their hashed names: the kept copy is always right.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (kept) =>
          kept ??
          fetch(event.request).then((res) => {
            if (res.ok) void caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }
  // The page: the server's when it answers, the last one kept when it doesn't.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && res.headers.get("Content-Type")?.startsWith("text/html")) void caches.open(CACHE).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/").then((kept) => kept ?? Response.error())),
    );
  }
});
