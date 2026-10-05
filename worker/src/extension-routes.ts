// The Worker's part in extensions: the sandbox route that sandboxed extensions run from, the fetch it
// makes for them (only to hosts their manifest declares and you've allowed), and installing an
// extension's files from a URL.
import { BUILT_IN_MANIFESTS } from "./builtin-extensions.ts";
import { parseCatalog } from "./catalog.ts";
import { extensionFilePath, manifestPath, parseManifest, type ExtensionManifest } from "./extensions.ts";
import { isExtensionScript, parseFilePath, type Author } from "./files.ts";
import type { Store } from "./operations.ts";
import { decide, parseGrants } from "./permissions.ts";
import { linkCard } from "./link-card.ts";
import { FetchRefused, safeFetch, type SafeFetchOptions } from "./safe-fetch.ts";
import { SANDBOX_PREFIX, sandboxScriptHeaders, shellPage, signCodeToken, TOKEN_LIFETIME_MS, verifyCodeToken } from "./sandbox.ts";
import { userSettingsPath } from "./settings.ts";
import { LIBRARY_NAMES, libraryUrl } from "../../web/src/library-names.ts";

/**
 * A workspace extension's module, with its imports of libraries (`@codemirror/view`,
 * `common-ink/live-preview`, …) pointed at the app's /lib/ modules, which hand over the app's own copy.
 */
export function pointAtLibraries(source: string): string {
  return source.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g, (whole, lead: string, quote: string, name: string) =>
    LIBRARY_NAMES.includes(name) ? `${lead}${quote}${libraryUrl(name)}${quote}` : whole,
  );
}

export interface SandboxStore extends Store {
  sandboxKey(): Promise<string> | string;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/**
 * The sandbox route, answered without sign-in: sandboxed frames send no cookies. Shells and their
 * scripts are public; a workspace extension's code needs a token from /api/sandbox/token.
 */
export async function sandboxRoute(req: Request, url: URL, assets: { fetch(req: Request): Promise<Response> }, store: SandboxStore): Promise<Response> {
  const path = url.pathname.slice(SANDBOX_PREFIX.length);
  if (req.method !== "GET") return new Response("Not allowed\n", { status: 405 });
  if (path === "host" || path === "webview") return shellPage(url.origin, path);
  if (path === "host.js" || path === "webview.js") {
    const res = await assets.fetch(new Request(`${url.origin}${SANDBOX_PREFIX}${path}`));
    return new Response(res.body, { status: res.status, headers: sandboxScriptHeaders });
  }
  // Libraries webviews may load (three.js, uPlot), public like the shells. A missing one would be
  // answered with the app's page, so a page here means there isn't one.
  if (/^vendor\/[\w.-]+(\/[\w.-]+)*$/.test(path) && !path.includes("..")) {
    const res = await assets.fetch(new Request(`${url.origin}${SANDBOX_PREFIX}${path}`));
    const type = res.headers.get("Content-Type") ?? "";
    if (!res.ok || type.startsWith("text/html")) return new Response("Not found\n", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    return new Response(res.body, { headers: { "Content-Type": type, "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=86400" } });
  }
  const code = /^code\/([^/]+)\/(.+)$/.exec(path);
  if (code) {
    const id = await verifyCodeToken(await store.sandboxKey(), code[1], Date.now());
    const file = id ? parseFilePath(extensionFilePath(id, code[2])) : null;
    if (!id || !file || !isExtensionScript(file)) return new Response("Not found\n", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    const found = await store.read(file);
    if (!found) return new Response("Not found\n", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    return new Response(found.text, { headers: sandboxScriptHeaders });
  }
  return new Response("Not found\n", { status: 404 });
}

/** An extension's manifest in effect: the workspace's copy if there is one, else the built-in's. */
async function manifestOf(store: Store, id: string): Promise<{ manifest: ExtensionManifest; builtIn: boolean } | null> {
  const file = await store.read(manifestPath(id));
  if (file) {
    const m = parseManifest(file.text, id);
    return typeof m === "string" ? null : { manifest: m, builtIn: false };
  }
  const builtIn = BUILT_IN_MANIFESTS.find((m) => m.id === id);
  return builtIn ? { manifest: builtIn, builtIn: true } : null;
}

/** Your answers to permission prompts, from your settings. */
async function grantsOf(store: Store, email: string) {
  const path = userSettingsPath(email);
  const file = path ? await store.read(path) : null;
  try {
    return parseGrants(JSON.parse(file?.text || "{}")["extensions.permissions"]);
  } catch {
    return {};
  }
}

/** The signed-in parts: a code token, a brokered fetch, and installing from a URL. Null if the route isn't one of them. */
export async function extensionApi(req: Request, url: URL, email: string, author: Author, store: SandboxStore, net: Pick<SafeFetchOptions, "fetcher" | "resolve"> = {}): Promise<Response | null> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/sandbox/token") {
    const id = url.searchParams.get("extension") ?? "";
    if (!(await manifestOf(store, id))) return json({ error: `No extension ${id}` }, 404);
    return json({ token: await signCodeToken(await store.sandboxKey(), id, Date.now() + TOKEN_LIFETIME_MS) });
  }
  if (route === "POST /api/extensions/fetch") {
    const body = (await req.json().catch(() => ({}))) as { extension?: string; url?: string; method?: string; headers?: Record<string, string>; body?: string; once?: boolean; card?: boolean };
    const found = await manifestOf(store, body.extension ?? "");
    if (!found || typeof body.url !== "string") return json({ error: "Say which extension and which URL" }, 400);
    let host: string;
    try {
      host = new URL(body.url).hostname;
    } catch {
      return json({ error: "That isn't a URL" }, 400);
    }
    // The app asked you already; this checks again against what's kept, so a page that skips asking gets nothing.
    const once = body.once ? new Set([`${found.manifest.id} network:${host}`, ...(found.manifest.permissions.network?.hosts ?? []).map((h) => `${found.manifest.id} network:${h}`)]) : undefined;
    const decision = decide(found.manifest, { kind: "network", target: host }, await grantsOf(store, email), { builtIn: found.builtIn, once });
    if (decision.outcome === "undeclared") return json({ error: `${found.manifest.name} doesn't declare ${host} in its extension.json, so it can't reach it` }, 403);
    if (decision.outcome !== "allow") return json({ error: `${found.manifest.name} isn't allowed to reach ${host}` }, 403);
    try {
      // A link's card (title, description, picture) rather than its page.
      if (body.card) return json(await linkCard(body.url, net));
      const res = await safeFetch(body.url, { ...net, method: body.method, headers: body.headers, body: body.body });
      return json(res);
    } catch (err) {
      if (err instanceof FetchRefused) return json({ error: err.message }, 400);
      throw err;
    }
  }
  if (route === "GET /api/extensions/catalog") {
    // Another catalog's index, for the Extensions view: fetched safely, like an install, and checked.
    const target = url.searchParams.get("url") ?? "";
    try {
      const res = await safeFetch(target, { ...net, maxBytes: 256_000 });
      if (res.status !== 200 || res.truncated) return json({ error: `${target} answered ${res.truncated ? "with too much" : res.status}` }, 400);
      return json({ entries: parseCatalog(JSON.parse(res.body), res.url, false) });
    } catch (err) {
      if (err instanceof FetchRefused) return json({ error: err.message }, 400);
      if (err instanceof SyntaxError) return json({ error: `${target} isn't a catalog: its index isn't JSON` }, 400);
      throw err;
    }
  }
  if (route === "POST /api/extensions/install") {
    const body = (await req.json().catch(() => ({}))) as { url?: string; catalog?: unknown };
    if (typeof body.url !== "string") return json({ error: "Give the URL of an extension's folder or its extension.json" }, 400);
    try {
      return json(await install(store, body.url, author, typeof body.catalog === "string" ? body.catalog : undefined, net));
    } catch (err) {
      if (err instanceof FetchRefused || err instanceof InstallError) return json({ error: err.message }, 400);
      throw err;
    }
  }
  return null;
}

class InstallError extends Error {}

/** Copy an extension's files from where it's published into the workspace, as changes by `author`. */
async function install(store: Store, raw: string, author: Author, catalog: string | undefined, net: Pick<SafeFetchOptions, "fetcher" | "resolve">): Promise<{ id: string; name: string; files: string[] }> {
  const manifestUrl = raw.endsWith("extension.json") ? raw : `${raw.replace(/\/?$/, "/")}extension.json`;
  const res = await safeFetch(manifestUrl, { ...net, maxBytes: 64_000 });
  if (res.status !== 200) throw new InstallError(`${manifestUrl} answered ${res.status}`);
  let data: { id?: unknown };
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new InstallError("Its extension.json isn't valid JSON");
  }
  const id = typeof data.id === "string" ? data.id : "";
  const manifest = parseManifest(data, id);
  if (typeof manifest === "string") throw new InstallError(manifest);
  if (BUILT_IN_MANIFESTS.some((m) => m.id === id)) throw new InstallError(`"${id}" is a built-in's id. To change a built-in, Customize it.`);
  const files: Array<[string, string]> = [["extension.json", res.body]];
  for (const file of manifest.files) {
    const got = await safeFetch(new URL(file, res.url).toString(), { ...net, maxBytes: 1_000_000 });
    if (got.status !== 200 || got.truncated) throw new InstallError(`${file} couldn't be fetched (${got.truncated ? "too big" : got.status})`);
    files.push([file, got.body]);
  }
  // Where it came from, so the app can say so ("From URL") and you can tell its code isn't your own.
  files.push(["installed.json", `${JSON.stringify({ from: res.url, ...(catalog ? { catalog } : {}) })}\n`]);
  for (const [file, text] of files) {
    const path = extensionFilePath(id, file);
    const current = await store.read(path);
    await store.write({ path, text, base: current?.revision ?? 0, author });
  }
  return { id, name: manifest.name, files: files.map(([f]) => f) };
}
