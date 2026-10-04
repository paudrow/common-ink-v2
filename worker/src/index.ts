// The Worker: checks who is asking, answers /api/ from the workspace's Durable Object, and serves the
// web app for everything else.
import { authorFor, identify, type Identity } from "./auth.ts";
import type { Seed } from "./files.ts";
import { mcp } from "./mcp.ts";
import { schema, SCHEMA_URL } from "./settings.ts";
import { runOperation, type OperationName, type Store } from "./operations.ts";
import { allowedEmails, page, sessionEmail, signInRoute, SESSION_COOKIE, type SignInConfig } from "./sign-in.ts";
import { cookie } from "./session.ts";
import type { Workspace, WorkspaceEnv } from "./workspace.ts";

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
}

const HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function secure(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  return out;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export default {
  async fetch(req, env) {
    // The settings schema is public, so editors outside the app can check settings files against it.
    const url = new URL(req.url);
    if (url.pathname === SCHEMA_URL) return secure(json(schema));
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName("main"));
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
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") return secure(await env.ASSETS.fetch(req));
    if (url.pathname === "/api/sources/disconnect" && req.method === "POST" && who.kind === "user") {
      await workspace.disconnectGoogle(who.email);
      return secure(json({ ok: true }));
    }
    const store = workspace as unknown as Store;
    if (url.pathname === "/mcp") return secure(await mcp(req, store, authorFor(who, req.headers.get("X-Common-Ink-Agent") ?? url.searchParams.get("agent") ?? "MCP client")));
    await seedOnce(env, workspace);
    return secure(await api(req, url, who, store));
  },
} satisfies ExportedHandler<Env>;

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
  "GET /api/history": "history",
  "POST /api/undo": "undo",
  "GET /api/sources": "data_sources",
  "GET /api/events": "list_events",
  "GET /api/contacts": "list_contacts",
};

async function api(req: Request, url: URL, who: Identity, store: Store): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/me") return json(who);
  const name = ROUTES[route];
  if (!name) return json({ error: `No route for ${route}` }, 404);
  const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
  const args = { ...Object.fromEntries(url.searchParams), ...(body && typeof body === "object" ? body : {}) };
  const result = await runOperation(name, args, store, authorFor(who, req.headers.get("X-Common-Ink-Agent")));
  if (!result.ok) return json({ error: result.error }, 400);
  if (result.value === null) return json({ error: `Nothing at ${args.path}` }, 404);
  return json(result.value, (result.value as { status?: string }).status === "conflict" ? 409 : 200);
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
