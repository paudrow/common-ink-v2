// The Worker: checks who is asking, answers /api/ from the workspace's Durable Object, and serves the
// web app for everything else.
import { authorFor, identify, type Identity } from "./auth.ts";
import type { Seed } from "./files.ts";
import { mcp } from "./mcp.ts";
import { schema, SCHEMA_URL } from "./settings.ts";
import { runOperation, type OperationName, type Store } from "./operations.ts";
import type { Workspace } from "./workspace.ts";

export { Workspace } from "./workspace.ts";

interface Env {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<Workspace>;
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
    if (new URL(req.url).pathname === SCHEMA_URL) return secure(json(schema));
    const who = await identify(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, devUser: env.DEV_USER });
    if (!who) return secure(new Response("Sign in through Cloudflare Access to use Common Ink.\n", { status: 401 }));
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/mcp") return secure(await env.ASSETS.fetch(req));
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName("main"));
    const store = workspace as unknown as Store;
    // The live connection goes straight to the workspace: a WebSocket's response can't be rewrapped.
    if (url.pathname === "/api/live") return workspace.fetch(req);
    if (url.pathname === "/mcp") return secure(await mcp(req, store, authorFor(who, req.headers.get("X-Common-Ink-Agent") ?? url.searchParams.get("agent") ?? "MCP client")));
    await seedOnce(env, workspace);
    return secure(await api(req, url, who, store));
  },
} satisfies ExportedHandler<Env>;

/** The API routes, each running one workspace operation with its arguments from the query and the body. */
const ROUTES: Record<string, OperationName> = {
  "GET /api/files": "list_files",
  "GET /api/file": "read_file",
  "PUT /api/file": "write_file",
  "GET /api/history": "history",
  "POST /api/undo": "undo",
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
