// The Worker: checks who is asking, answers /api/ from the workspace's Durable Object, and serves the
// web app for everything else.
import { authorFor, identify, type Identity } from "./auth.ts";
import { isExtensionScript, parseFilePath, type Seed } from "./files.ts";
import { mcp } from "./mcp.ts";
import { schema, SCHEMA_URL } from "./settings.ts";
import { runOperation, type OperationName, type Store } from "./operations.ts";
import { allowedEmails, page, sessionEmail, signInRoute, type SignInConfig } from "./sign-in.ts";
import type { Workspace, WorkspaceEnv } from "./workspace.ts";
import { blobKey, findUpload, MAX_UPLOAD_BYTES, showsInline, typeFor, UPLOADS_PATH } from "./uploads.ts";
import { extensionApi, pointAtLibraries, sandboxRoute, type SandboxStore } from "./extension-routes.ts";
import { appCsp, SANDBOX_PREFIX } from "./sandbox.ts";
import { embedFrameHosts, idsIn } from "./embed-list.ts";
import { EXTENSION_ID, extensionFileOf, statePath } from "./extensions.ts";
import { decidesTrust } from "./permissions.ts";
import { leversOn } from "./levers.ts";
import { leversApi, netFor, withLeversMeta } from "./levers-routes.ts";
import { redirectFor } from "./hosts.ts";
import { seedOnce, type SeedRun } from "./seed-once.ts";
import { bytesUpTo } from "./body.ts";
import { publicFile } from "./public-files.ts";

export { Workspace } from "./workspace.ts";

interface Env extends WorkspaceEnv {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  /** Signs session cookies (a secret). With GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, turns on Google sign-in. */
  SESSION_SECRET?: string;
  /** Who may sign in with Google: addresses separated by commas or spaces. */
  ALLOWED_EMAILS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Set by `npm run dev` and in Previews: who you are signed in as there. */
  DEV_USER?: string;
  /** Set by `npm run dev`: which run started this Worker (scripts/dev.ts). */
  DEV_RUN?: string;
  /** "1" in Previews and local development: the workspace is filled from the build's seed.json. */
  SEED?: string;
  /** "1" in Previews, local development and the browser tests, with DEV_USER: test levers (docs/TESTING.md). */
  LEVERS?: string;
}

const HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Browsers ignore it over plain HTTP (npm run dev), so it's the same everywhere.
  "Strict-Transport-Security": "max-age=31536000",
};

/** Hosts a page may frame, handed from `handle` to `fetch`, and never sent. */
const FRAME_HOSTS = "X-Common-Ink-Frame-Hosts";

/** The app's headers on a response. Its policy goes on in `fetch`, which knows the origin; a page names the hosts its link embeds may frame. */
function secure(res: Response, frameHosts: readonly string[] = []): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  out.headers.set("Content-Security-Policy", "{app}");
  if (frameHosts.length) out.headers.set(FRAME_HOSTS, frameHosts.join(" "));
  return out;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Where a page sends its last save with navigator.sendBeacon. */
const BEACON = "/api/file/beacon";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const elsewhere = redirectFor(url);
    if (elsewhere) return new Response(null, { status: elsewhere.status, headers: { Location: elsewhere.location, "Strict-Transport-Security": HEADERS["Strict-Transport-Security"] } });
    const res = await handle(req, env, url);
    // A WebSocket's answer can't be rewrapped; everything else asks for HTTPS, the sandbox route's included.
    if (res.status === 101) return res;
    if (res.headers.get("Content-Security-Policy") !== "{app}") {
      if (res.headers.has("Strict-Transport-Security")) return res;
      const out = new Response(res.body, res);
      out.headers.set("Strict-Transport-Security", HEADERS["Strict-Transport-Security"]);
      return out;
    }
    const out = new Response(res.body, res);
    // Whatever answers under /uploads/ (a refusal, a sign-in, a 405) is under the uploads' policy, never the app's.
    out.headers.set("Content-Security-Policy", url.pathname.startsWith("/uploads/") ? UPLOAD_CSP : appCsp(url.origin, (res.headers.get(FRAME_HOSTS) ?? "").split(" ").filter(Boolean)));
    out.headers.delete(FRAME_HOSTS);
    return out;
  },
} satisfies ExportedHandler<Env>;

async function handle(req: Request, env: Env, url: URL): Promise<Response> {
  {
    // The settings schema is public, so editors outside the app can check settings files against it.
    if (url.pathname === SCHEMA_URL) return secure(json(schema));
    const file = await publicFile(req, url, env.ASSETS);
    if (file) return secure(file);
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName("main"));
    // Sandboxed frames send no cookies: the sandbox route answers them without sign-in (sandbox.ts says what's safe there).
    if (url.pathname.startsWith(SANDBOX_PREFIX)) return sandboxRoute(req, url, env.ASSETS, workspace as unknown as SandboxStore);
    const signIn = signInConfig(env);
    if (url.pathname.startsWith("/auth/")) {
      const answer = await signInRoute(req, url, signIn, (granted) => workspace.connectGoogle(granted));
      if (answer) return secure(answer);
    }
    const who = await identify(req, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      devUser: env.DEV_USER,
      sessionEmail: (r) => sessionEmail(r, signIn),
    });
    if (!who) {
      // A person opening the app goes to sign in; anything else is told no.
      if (signIn && req.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/mcp") {
        return secure(Response.redirect(`${url.origin}/auth/google?next=${encodeURIComponent(url.pathname + url.search)}`, 302));
      }
      return secure(new Response("Sign in to use Common Ink.\n", { status: 401 }));
    }
    // A browser sends what signs you in (a cookie, or on this machine the address itself) with requests
    // other sites make, and says where they came from when one changes something or opens a socket.
    // Only this site may. The CLI and agents send no Origin.
    const origin = req.headers.get("Origin");
    const changes = (req.method !== "GET" && req.method !== "HEAD") || req.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (changes && origin && origin !== url.origin) {
      return secure(page("Not from here", "<p>That request came from another site.</p>", 403));
    }
    // A save sent with sendBeacon is a simple request, with no preflight, so it has to show it's from
    // this site rather than only not say otherwise. Browsers always say where a beacon came from.
    if (url.pathname === BEACON && origin !== url.origin && req.headers.get("Sec-Fetch-Site") !== "same-origin") {
      return secure(page("Not from here", "<p>That request didn't say it came from this site.</p>", 403));
    }
    // A trusted workspace extension's code, from its files, so the page can import it under
    // `script-src 'self'`. Only a trusted one's: anyone else's code is never a script this site serves.
    const code = url.pathname.startsWith("/extensions/") && req.method === "GET" ? parseFilePath(`.common-ink${decodedPath(url)}`) : null;
    if (code && isExtensionScript(code)) {
      const trusted = await idsIn(workspace as unknown as Store, "extensions.trusted", who.kind === "user" ? who.email : null);
      const file = trusted.has(extensionFileOf(code)?.id ?? "") ? await (workspace as unknown as Store).read(code) : null;
      if (!file) return secure(new Response("No such file\n", { status: 404 }));
      return secure(new Response(pointAtLibraries(file.text), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } }));
    }
    // An uploaded file, by name, from R2.
    if (url.pathname.startsWith("/uploads/") && (req.method === "GET" || req.method === "HEAD")) return serveUpload(req, url, env, workspace as unknown as Store);
    const levers = leversOn(env, url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") {
      const asset = await env.ASSETS.fetch(req);
      // The app's page may frame the hosts of the link embeds that are on for this person.
      const isPage = asset.headers.get("Content-Type")?.startsWith("text/html");
      const out = secure(asset, isPage ? await embedFrameHosts(workspace as unknown as Store, who.kind === "user" ? who.email : null) : []);
      if (!levers || !isPage) return out;
      await seedPreview(env, workspace);
      const seeded = await workspace.scenario();
      return withLeversMeta(out, { scenario: seeded?.name ?? "", ...(seeded?.now ? { now: seeded.now } : {}) });
    }
    // An upload's bytes come as the request body, not JSON: PUT /api/upload?name=photo.png.
    if (url.pathname === "/api/upload" && req.method === "PUT") {
      const tooBig = secure(json({ error: `Uploads can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }, 413));
      if (Number(req.headers.get("Content-Length") ?? "0") > MAX_UPLOAD_BYTES) return tooBig;
      const data = await bytesUpTo(req.body, MAX_UPLOAD_BYTES).catch(() => undefined);
      if (data === undefined) return secure(json({ error: "The upload didn't arrive whole. Try again." }, 400));
      if (data === null) return tooBig;
      const result = await workspace.upload(url.searchParams.get("name") ?? "", data, authorFor(who, req.headers.get("X-Common-Ink-Agent")));
      return secure(result.status === "refused" ? json({ error: result.error }, 400) : json(result));
    }
    if (url.pathname === "/api/sources/disconnect" && req.method === "POST" && who.kind === "user") {
      await workspace.disconnectGoogle(who.email);
      return secure(json({ ok: true }));
    }
    const store = workspace as unknown as SandboxStore;
    // The live connection goes straight to the workspace: a WebSocket's response can't be rewrapped.
    if (url.pathname === "/api/live") return workspace.fetch(req);
    if (who.kind === "user") {
      const extensionAnswer = await extensionApi(req, url, who.email, authorFor(who, null), store, levers ? await netFor(req, env.ASSETS) : {});
      if (extensionAnswer) return secure(extensionAnswer);
    }
    if (levers && url.pathname.startsWith("/api/levers")) {
      await seedPreview(env, workspace);
      const answer = await leversApi(req, url, env.ASSETS, workspace, env.DEV_RUN);
      if (answer) return secure(answer);
    }
    if (url.pathname === "/mcp") return secure(await mcp(req, store, authorFor(who, req.headers.get("X-Common-Ink-Agent") ?? url.searchParams.get("agent") ?? "MCP client")));
    await seedPreview(env, workspace);
    return secure(await api(req, url, who, store));
  }
}

/** Google sign-in, if this Worker has what it needs for it. */
function signInConfig(env: Env): SignInConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) return null;
  return { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }, sessionSecret: env.SESSION_SECRET, allowed: allowedEmails(env.ALLOWED_EMAILS) };
}

/** The API routes, each running one workspace operation with its arguments from the query and the body. */
const ROUTES: Record<string, OperationName> = {
  "GET /api/files": "list_files",
  "GET /api/search": "search",
  "GET /api/file": "read_file",
  "PUT /api/file": "write_file",
  // A page's last save as it goes away (navigator.sendBeacon): the same write, its JSON sent as text/plain.
  "POST /api/file/beacon": "write_file",
  "DELETE /api/file": "delete_file",
  "GET /api/history": "history",
  "POST /api/undo": "undo",
  "GET /api/sources": "data_sources",
  "GET /api/calendars": "list_calendars",
  "POST /api/sync": "sync_calendar",
  "GET /api/events": "list_events",
  "GET /api/event": "read_event",
  "POST /api/events": "create_event",
  "PATCH /api/event": "update_event",
  "DELETE /api/event": "delete_event",
  "POST /api/event/link": "link_event",
  "GET /api/contacts": "list_contacts",
  "POST /api/diff": "diff",
  "GET /api/version": "read_version",
  "GET /api/edit": "edit_applied",
  "POST /api/restore": "restore",
  "GET /api/labels": "labels",
  "POST /api/labels": "add_label",
};

/** Operations that change a file named by `path`. */
const CHANGES = new Set<OperationName>(["write_file", "delete_file", "restore"]);

async function api(req: Request, url: URL, who: Identity, store: Store): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/me") return json(who);
  const name = ROUTES[route];
  if (!name) return json({ error: `No route for ${route}` }, 404);
  const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
  const args = { ...Object.fromEntries(url.searchParams), ...(body && typeof body === "object" ? body : {}) };
  // A second gate behind the app's: a change in an extension's name to the files that decide trust,
  // other than its own state, only from an extension you trust (a sandboxed one can't reach here at all).
  // Undo is by revision, so it could take back any file's change: none for an untrusted extension.
  const extension = req.headers.get("X-Common-Ink-Extension");
  if (extension !== null && !EXTENSION_ID.test(extension)) return json({ error: "X-Common-Ink-Extension must be an extension's id" }, 400);
  const path = parseFilePath(args.path);
  const touchesTrust = name === "undo" || (path && CHANGES.has(name) && decidesTrust(path) && path !== statePath(extension ?? ""));
  if (extension && touchesTrust) {
    const trusted = await idsIn(store, "extensions.trusted", who.kind === "user" ? who.email : null);
    if (!trusted.has(extension)) return json({ error: `${extension} isn't trusted, so it can't ${name === "undo" ? "undo changes" : `change ${path}`}` }, 403);
  }
  const result = await runOperation(name, args, store, authorFor(who, req.headers.get("X-Common-Ink-Agent"), req.headers.get("X-Common-Ink-Extension")));
  if (!result.ok) return json({ error: result.error }, result.internal ? 500 : 400);
  // An event that isn't there is an answer (a note's link can outlive its event), not a missing route.
  if (result.value === null && name === "read_event") return json(null);
  if (result.value === null) return json({ error: `Nothing at ${args.path}` }, 404);
  return json(result.value, (result.value as { status?: string }).status === "conflict" ? 409 : 200);
}

/**
 * An upload's bytes, under the type its name gives (not the type in the uploads file, which anyone who
 * can write files can change). Every one is served sandboxed, so an SVG or a PDF
 * opened by itself can't run script as this site; anything that isn't an image, audio, video, PDF or
 * plain text downloads instead of opening.
 */
async function serveUpload(req: Request, url: URL, env: Env, store: Store): Promise<Response> {
  // Every answer under /uploads/ carries the upload's policy, a 404 or 503 too: what the browser shows at
  // an upload's address is never a page of this site.
  const underPolicy = (res: Response) => {
    const out = secure(res);
    out.headers.set("Content-Security-Policy", UPLOAD_CSP);
    return out;
  };
  const notFound = () => underPolicy(new Response("Not found\n", { status: 404 }));
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice("/uploads/".length));
  } catch {
    return notFound();
  }
  const upload = findUpload((await store.read(UPLOADS_PATH))?.text ?? "", name);
  if (!upload) return notFound();
  // The same policy on every answer, a 304 too: a browser keeps the headers of the answer that
  // revalidated its copy, so a 304 with the app's policy would let a cached SVG run this site's scripts.
  const sandboxed = (res: Response) => {
    const out = underPolicy(res);
    out.headers.set("ETag", `"${upload.hash}"`);
    // A name can come to mean other bytes after an undo, so it's checked again each time, cheaply, by ETag.
    out.headers.set("Cache-Control", "private, no-cache");
    return out;
  };
  if (req.headers.get("If-None-Match") === `"${upload.hash}"`) return sandboxed(new Response(null, { status: 304 }));
  // A HEAD asks only whether the bytes are there; it doesn't read them.
  const key = blobKey(upload.hash);
  const read: Promise<R2Object | R2ObjectBody | null> = req.method === "HEAD" ? env.UPLOADS.head(key) : env.UPLOADS.get(key);
  const blob = await read.catch((err) => {
    console.error("Reading an upload's bytes failed:", err);
    return undefined;
  });
  if (blob === undefined) return sandboxed(new Response("Uploads can't be read right now. Try again in a minute.\n", { status: 503, headers: { "Retry-After": "60" } }));
  if (!blob) return notFound();
  const type = typeFor(upload.name);
  return sandboxed(
    new Response("body" in blob ? blob.body : null, {
      headers: {
        "Content-Type": type,
        "Content-Length": String(upload.size),
        "Content-Disposition": `${showsInline(type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
      },
    }),
  );
}

/** An upload's policy: sandboxed, so an SVG or a PDF opened by itself runs nothing as this site. */
const UPLOAD_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/** A URL's path, decoded, or "" if it can't be. */
function decodedPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
}

const seedRun: SeedRun = { done: false, running: null };

/** In a Preview, fill the workspace from this deploy's seed.json, once per isolate (seed-once.ts). */
async function seedPreview(env: Env, workspace: DurableObjectStub<Workspace>) {
  if (env.SEED !== "1") return;
  const load = async () => {
    const res = await env.ASSETS.fetch("https://assets.local/seed.json");
    // A missing file comes back as the web app's index.html, since the app handles its own routes.
    return res.headers.get("Content-Type")?.startsWith("application/json") ? ((await res.json()) as Seed) : null;
  };
  await seedOnce(seedRun, load, (seed) => workspace.seed(seed));
}
