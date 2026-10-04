// The Worker: checks who is asking, answers /api/ from the workspace's Durable Object, and serves the
// web app for everything else.
import { identify } from "./auth.ts";
import type { Seed } from "./notes.ts";
import type { Workspace } from "./workspace.ts";

export { Workspace } from "./workspace.ts";

interface Env {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Set by `npm run dev` only. */
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
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/me") return secure(json(who));
    if (route === "GET /api/notes") return secure(json(await workspace.list()));
    return secure(json({ error: `No route for ${route}` }, 404));
  },
} satisfies ExportedHandler<Env>;

let seeded = false;

/** In a Preview, fill the workspace from this deploy's seed.json, once per isolate. */
async function seedOnce(env: Env, workspace: DurableObjectStub<Workspace>) {
  if (seeded || env.SEED !== "1") return;
  const res = await env.ASSETS.fetch("https://assets.local/seed.json");
  // A missing file comes back as the web app's index.html, since the app handles its own routes.
  if (res.headers.get("Content-Type")?.startsWith("application/json")) await workspace.seed((await res.json()) as Seed);
  seeded = true;
}
