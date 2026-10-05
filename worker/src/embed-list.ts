// What embeds a workspace's notes can hold, for agents (the list_embeds tool): every embed the
// built-in extensions and the workspace's own extensions declare, with its arguments, an example to
// copy, and whether its extension is on here.
import { BUILT_IN_MANIFESTS } from "./builtin-extensions.ts";
import { manifestPath, parseManifest, type EmbedContribution, type ExtensionManifest } from "./extensions.ts";
import { extensionFileOf } from "./extensions.ts";
import type { Store } from "./operations.ts";
import { userSettingsPath, WORKSPACE_SETTINGS } from "./settings.ts";

export interface EmbedType extends EmbedContribution {
  extension: string;
  /** Whether its extension is on, by the workspace's settings and, for an agent working for a person, theirs. */
  on: boolean;
  /** A block to copy into a note. */
  example: string;
}

/** An embed written the way its syntax says, with its arguments' defaults: a leaf's line, a container, or a fenced block. */
export function exampleOf(e: EmbedContribution): string {
  const args = Object.entries(e.arguments)
    .filter(([, a]) => a.default !== undefined && !a.hidden)
    .map(([name, a]) => `${name}=${/^[\w.:/+@#-]+$/.test(a.default!) ? a.default : `"${a.default}"`}`);
  if (e.syntax === "leaf") return `::${e.language}${args.length ? `{${args.join(" ")}}` : ""}`;
  if (e.syntax === "container") return `:::${e.language}${args.length ? `{${args.join(" ")}}` : ""}\n${e.body ? `${e.body}\n` : ""}:::`;
  return `\`\`\`${[e.language, ...args].join(" ")}\n${e.body ? `${e.body}\n` : ""}\`\`\``;
}

/** The ids a list setting names (extensions.disabled, extensions.trusted), in workspace settings and, for a person, theirs. */
export async function idsIn(store: Store, key: string, person: string | null): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const path of [WORKSPACE_SETTINGS, person ? userSettingsPath(person) : null]) {
    if (!path) continue;
    try {
      const value = JSON.parse((await store.read(path))?.text || "{}")[key];
      if (Array.isArray(value)) for (const id of value) if (typeof id === "string") ids.add(id);
    } catch {
      // A settings file that doesn't parse names nothing.
    }
  }
  return ids;
}

/** The workspace's extensions' manifests, by id. */
export async function workspaceManifests(store: Store): Promise<Map<string, ExtensionManifest>> {
  const out = new Map<string, ExtensionManifest>();
  for (const f of await store.list()) {
    const at = extensionFileOf(f.path);
    if (!at || f.path !== manifestPath(at.id)) continue;
    const parsed = parseManifest((await store.read(f.path))?.text ?? "", at.id);
    if (typeof parsed !== "string") out.set(at.id, parsed);
  }
  return out;
}

/**
 * The hosts the app's page may frame for link embeds: those of the extensions that are on and draw in
 * the page (built-ins, and workspace extensions you trust). Nothing else can put a frame in the page.
 */
export async function embedFrameHosts(store: Store, person: string | null): Promise<string[]> {
  const off = await idsIn(store, "extensions.disabled", person);
  const trusted = await idsIn(store, "extensions.trusted", person);
  const manifests = new Map<string, ExtensionManifest>(BUILT_IN_MANIFESTS.map((m) => [m.id, m]));
  // A copy in the workspace runs in a built-in's place: trusted, in the page; or else sandboxed, framing nothing.
  for (const [id, m] of await workspaceManifests(store)) {
    if (trusted.has(id)) manifests.set(id, m);
    else manifests.delete(id);
  }
  return [...new Set([...manifests.values()].filter((m) => !off.has(m.id)).flatMap((m) => m.contributes.urlEmbeds.flatMap((e) => e.frameHosts)))].sort();
}

export async function listEmbeds(store: Store, person: string | null): Promise<EmbedType[]> {
  // A workspace extension with a built-in's id runs in its place.
  const manifests = new Map<string, ExtensionManifest>([...BUILT_IN_MANIFESTS.map((m) => [m.id, m] as const), ...(await workspaceManifests(store))]);
  const off = await idsIn(store, "extensions.disabled", person);
  return [...manifests.values()].flatMap((m) => m.contributes.embeds.map((e) => ({ ...e, extension: m.id, on: !off.has(m.id), example: exampleOf(e) })));
}
