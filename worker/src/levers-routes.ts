// The Worker's part in test levers (docs/TESTING.md), served only where leversOn says so: what the page
// is told about them, resetting the workspace to a scenario, and the recorded network.
import type { Seed } from "./files.ts";
import { LEVERS_META, leversFromCookie, type LeversPage } from "./levers.ts";
import { replay, type Recordings } from "./net-replay.ts";
import type { SafeFetchOptions } from "./safe-fetch.ts";
import type { SeededScenario } from "./workspace.ts";

interface Assets {
  fetch(req: Request | string): Promise<Response>;
}

export interface LeversWorkspace {
  scenario(): Promise<SeededScenario | null> | SeededScenario | null;
  reset(seed: Seed, pinned: boolean): Promise<void> | void;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** A file the build wrote for levers (scripts/write-seed.ts), or null if it didn't. A missing one comes back as the app's page. */
async function built<T>(assets: Assets, path: string): Promise<T | null> {
  const res = await assets.fetch(`https://assets.local/${path}`);
  return res.ok && res.headers.get("Content-Type")?.startsWith("application/json") ? ((await res.json()) as T) : null;
}

/** The levers' API: GET /api/levers says what's set, POST /api/levers/reset empties the workspace and seeds it again. */
export async function leversApi(req: Request, url: URL, assets: Assets, workspace: LeversWorkspace): Promise<Response | null> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/levers") {
    return json({ scenario: await workspace.scenario(), levers: leversFromCookie(req.headers.get("Cookie")), scenarios: (await built(assets, "levers/scenarios.json")) ?? [] });
  }
  if (route === "POST /api/levers/reset") {
    const { scenario } = ((await req.json().catch(() => ({}))) ?? {}) as { scenario?: unknown };
    if (scenario !== undefined && (typeof scenario !== "string" || !/^[a-z][a-z0-9-]*$/.test(scenario))) return json({ error: "A scenario is a name like lists" }, 400);
    const seed = await built<Seed>(assets, scenario ? `levers/scenarios/${scenario}.json` : "seed.json");
    if (!seed) return json({ error: scenario ? `No scenario ${scenario}` : "This build has no seed" }, 404);
    // Reset to a scenario by name, and it stays; reset to the deploy's own seed, and later deploys refresh it.
    await workspace.reset(seed, !!scenario);
    return json({ scenario: await workspace.scenario() });
  }
  return null;
}

/** The app's page, telling the app that levers are on, and which scenario its workspace holds. */
export function withLeversMeta(page: Response, info: LeversPage): Response {
  const content = JSON.stringify(info).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return new HTMLRewriter().on("head", { element: (el) => void el.append(`<meta name="${LEVERS_META}" content="${content}">`, { html: true }) }).transform(page);
}

let recordings: Recordings | null = null;

/** How a brokered fetch reaches the network for this request: as it is, or replayed when its levers say so. */
export async function netFor(req: Request, assets: Assets): Promise<Pick<SafeFetchOptions, "fetcher" | "resolve">> {
  if (leversFromCookie(req.headers.get("Cookie")).net !== "replay") return {};
  recordings ??= (await built<Recordings>(assets, "levers/net.json")) ?? {};
  return replay(recordings);
}
