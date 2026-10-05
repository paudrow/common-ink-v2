// The Worker: checks who is asking, answers /api/ from the workspace's Durable Object, and serves the
// web app for everything else.
import { authorFor, identify, type Identity } from "./auth.ts";
import { isExtensionScript, parseFilePath, type Seed } from "./files.ts";
import { mcp } from "./mcp.ts";
import { schema, SCHEMA_URL } from "./settings.ts";
import { runOperation, type OperationName, type Store } from "./operations.ts";
import { allowedEmails, page, sessionEmail, signInRoute, SESSION_COOKIE, type SignInConfig } from "./sign-in.ts";
import { cookie } from "./session.ts";
import type { Workspace, WorkspaceEnv } from "./workspace.ts";
import { blobKey, findUpload, MAX_UPLOAD_BYTES, showsInline, UPLOADS_PATH } from "./uploads.ts";
import { extensionApi, pointAtLibraries, sandboxRoute, type SandboxStore } from "./extension-routes.ts";
import { appCsp, SANDBOX_PREFIX } from "./sandbox.ts";
import { embedFrameHosts } from "./embed-list.ts";
import { leversOn } from "./levers.ts";
import { leversApi, netFor, withLeversMeta } from "./levers-routes.ts";

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
  /** "1" in Previews and local development: the workspace is filled from the build's seed.json. */
  SEED?: string;
  /** "1" in Previews, local development and the browser tests, with DEV_USER: test levers (docs/TESTING.md). */
  LEVERS?: string;
}

const HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const res = await handle(req, env, url);
    if (res.headers.get("Content-Security-Policy") !== "{app}") return res;
    const out = new Response(res.body, res);
    out.headers.set("Content-Security-Policy", appCsp(url.origin, (res.headers.get(FRAME_HOSTS) ?? "").split(" ").filter(Boolean)));
    out.headers.delete(FRAME_HOSTS);
    return out;
  },
} satisfies ExportedHandler<Env>;

async function handle(req: Request, env: Env, url: URL): Promise<Response> {
  {
    // The settings schema is public, so editors outside the app can check settings files against it.
    if (url.pathname === SCHEMA_URL) return secure(json(schema));
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
      sessionEmail: (r) => sessionEmail(r, env.SESSION_SECRET),
    });
    if (!who) {
      // A person opening the app goes to sign in; anything else is told no.
      if (signIn && req.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/mcp") {
        return secure(Response.redirect(`${url.origin}/auth/google?next=${encodeURIComponent(url.pathname + url.search)}`, 302));
      }
      return secure(new Response("Sign in to use Common Ink.\n", { status: 401 }));
    }
    // A signed-in browser's cookie goes with requests other sites make; only this site may change things.
    const origin = req.headers.get("Origin");
    if (req.method !== "GET" && origin && origin !== url.origin && cookie(req, SESSION_COOKIE)) {
      return secure(page("Not from here", "<p>That request came from another site.</p>", 403));
    }
    // A workspace extension's code, from its files, so the page can import it under `script-src 'self'`.
    const code = url.pathname.startsWith("/extensions/") && req.method === "GET" ? parseFilePath(`.common-ink${decodedPath(url)}`) : null;
    if (code && isExtensionScript(code)) {
      const file = await (workspace as unknown as Store).read(code);
      if (!file) return secure(new Response("No such file\n", { status: 404 }));
      return secure(new Response(pointAtLibraries(file.text), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } }));
    }
    // An uploaded file, by name, from R2.
    if (url.pathname.startsWith("/uploads/") && req.method === "GET") return serveUpload(req, url, env, workspace as unknown as Store);
    const levers = leversOn(env);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") {
      const asset = await env.ASSETS.fetch(req);
      // The app's page may frame the hosts of the link embeds that are on for this person.
      const isPage = asset.headers.get("Content-Type")?.startsWith("text/html");
      const out = secure(asset, isPage ? await embedFrameHosts(workspace as unknown as Store, who.kind === "user" ? who.email : null) : []);
      if (!levers || !isPage) return out;
      await seedOnce(env, workspace);
      const seeded = await workspace.scenario();
      return withLeversMeta(out, { scenario: seeded?.name ?? "", ...(seeded?.now ? { now: seeded.now } : {}) });
    }
    // An upload's bytes come as the request body, not JSON: PUT /api/upload?name=photo.png.
    if (url.pathname === "/api/upload" && req.method === "PUT") {
      const size = Number(req.headers.get("Content-Length") ?? "0");
      if (size > MAX_UPLOAD_BYTES) return secure(json({ error: `Uploads can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }, 413));
      const result = await workspace.upload(url.searchParams.get("name") ?? "", await req.arrayBuffer(), authorFor(who, req.headers.get("X-Common-Ink-Agent")));
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
      await seedOnce(env, workspace);
      const answer = await leversApi(req, url, env.ASSETS, workspace);
      if (answer) return secure(answer);
    }
    if (url.pathname === "/mcp") return secure(await mcp(req, store, authorFor(who, req.headers.get("X-Common-Ink-Agent") ?? url.searchParams.get("agent") ?? "MCP client")));
    await seedOnce(env, workspace);
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
  "GET /api/file": "read_file",
  "PUT /api/file": "write_file",
  "DELETE /api/file": "delete_file",
  "GET /api/history": "history",
  "POST /api/undo": "undo",
  "GET /api/sources": "data_sources",
  "GET /api/events": "list_events",
  "GET /api/contacts": "list_contacts",
  "POST /api/diff": "diff",
  "GET /api/version": "read_version",
  "POST /api/restore": "restore",
  "GET /api/labels": "labels",
  "POST /api/labels": "add_label",
};

async function api(req: Request, url: URL, who: Identity, store: Store): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/me") return json(who);
  const name = ROUTES[route];
  if (!name) return json({ error: `No route for ${route}` }, 404);
  const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
  const args = { ...Object.fromEntries(url.searchParams), ...(body && typeof body === "object" ? body : {}) };
  const result = await runOperation(name, args, store, authorFor(who, req.headers.get("X-Common-Ink-Agent"), req.headers.get("X-Common-Ink-Extension")));
  if (!result.ok) return json({ error: result.error }, 400);
  if (result.value === null) return json({ error: `Nothing at ${args.path}` }, 404);
  return json(result.value, (result.value as { status?: string }).status === "conflict" ? 409 : 200);
}

/**
 * An upload's bytes, under the type its name gives. Every one is served sandboxed, so an SVG or a PDF
 * opened by itself can't run script as this site; anything that isn't an image, audio, video, PDF or
 * plain text downloads instead of opening.
 */
async function serveUpload(req: Request, url: URL, env: Env, store: Store): Promise<Response> {
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice("/uploads/".length));
  } catch {
    return secure(new Response("Not found\n", { status: 404 }));
  }
  const upload = findUpload((await store.read(UPLOADS_PATH))?.text ?? "", name);
  if (!upload) return secure(new Response("Not found\n", { status: 404 }));
  if (req.headers.get("If-None-Match") === `"${upload.hash}"`) return secure(new Response(null, { status: 304 }));
  const blob = await env.UPLOADS.get(blobKey(upload.hash));
  if (!blob) return secure(new Response("Not found\n", { status: 404 }));
  const out = secure(
    new Response(blob.body, {
      headers: {
        "Content-Type": upload.type,
        "Content-Length": String(upload.size),
        "Content-Disposition": `${showsInline(upload.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
        ETag: `"${upload.hash}"`,
        // A name can come to mean other bytes after an undo, so it's checked again each time, cheaply, by ETag.
        "Cache-Control": "private, no-cache",
      },
    }),
  );
  out.headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  return out;
}

/** A URL's path, decoded, or "" if it can't be. */
function decodedPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
}

let seeded = false;

/** In a Preview, fill the workspace from this deploy's seed.json, once per isolate. */
async function seedOnce(env: Env, workspace: DurableObjectStub<Workspace>) {
  if (seeded || env.SEED !== "1") return;
  const res = await env.ASSETS.fetch("https://assets.local/seed.json");
  // A missing file comes back as the web app's index.html, since the app handles its own routes.
  if (res.headers.get("Content-Type")?.startsWith("application/json")) await workspace.seed((await res.json()) as Seed);
  seeded = true;
}
