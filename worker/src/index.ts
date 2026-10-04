// The Worker: checks who is asking, answers /api/ from the workspace's Durable Object, and serves the
// web app for everything else.
import { identify, type Identity } from "./auth.ts";
import { parseDocPath, type Seed } from "./docs.ts";
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
    const who = await identify(req, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD, devUser: env.DEV_USER });
    if (!who) return secure(new Response("Sign in through Cloudflare Access to use Common Ink.\n", { status: 401 }));
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return secure(await env.ASSETS.fetch(req));
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName("main"));
    await seedOnce(env, workspace);
    return secure(await api(req, url, who, workspace));
  },
} satisfies ExportedHandler<Env>;

/** Docs are larger than this only by mistake, and a Durable Object's SQLite rows top out at 2 MB. */
const MAX_DOC_BYTES = 1_000_000;

async function api(req: Request, url: URL, who: Identity, workspace: DurableObjectStub<Workspace>): Promise<Response> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/me") return json(who);
  if (route === "GET /api/docs") return json(await workspace.list());
  if (route === "GET /api/doc") {
    const path = parseDocPath(url.searchParams.get("path"));
    if (!path) return json({ error: "?path= must be a path ending in .md or .json" }, 400);
    const doc = await workspace.read(path);
    return doc ? json(doc) : json({ error: `Nothing at ${path}` }, 404);
  }
  if (route === "PUT /api/doc") {
    const body = (await req.json().catch(() => null)) as { path?: unknown; text?: unknown; base?: unknown } | null;
    const path = parseDocPath(body?.path);
    const { text, base } = body ?? {};
    if (!path) return json({ error: '"path" must be a path ending in .md or .json' }, 400);
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_DOC_BYTES) return json({ error: '"text" must be a string under 1 MB' }, 400);
    if (!Number.isSafeInteger(base) || (base as number) < 0) return json({ error: '"base" must be the revision you started from, or 0 for a new doc' }, 400);
    const result = await workspace.write({ path, text, base: base as number, author: { kind: "user", email: who.email } });
    return json(result, result.status === "conflict" ? 409 : 200);
  }
  return json({ error: `No route for ${route}` }, 404);
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
