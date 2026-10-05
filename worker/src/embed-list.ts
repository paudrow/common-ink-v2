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

/** A fenced block for an embed, with its arguments' defaults. */
export function exampleOf(e: EmbedContribution): string {
  const args = Object.entries(e.arguments)
    .filter(([, a]) => a.default !== undefined)
    .map(([name, a]) => `${name}=${/\s/.test(a.default!) ? `"${a.default}"` : a.default}`);
  return `\`\`\`${[e.language, ...args].join(" ")}\n${e.body ? `${e.body}\n` : ""}\`\`\``;
}

async function disabledIn(store: Store, person: string | null): Promise<Set<string>> {
  const off = new Set<string>();
  for (const path of [WORKSPACE_SETTINGS, person ? userSettingsPath(person) : null]) {
    if (!path) continue;
    try {
      const value = JSON.parse((await store.read(path))?.text || "{}")["extensions.disabled"];
      if (Array.isArray(value)) for (const id of value) if (typeof id === "string") off.add(id);
    } catch {
      // A settings file that doesn't parse turns nothing off.
    }
  }
  return off;
}

export async function listEmbeds(store: Store, person: string | null): Promise<EmbedType[]> {
  const manifests = new Map<string, ExtensionManifest>(BUILT_IN_MANIFESTS.map((m) => [m.id, m]));
  // A workspace extension with a built-in's id runs in its place.
  for (const f of await store.list()) {
    const at = extensionFileOf(f.path);
    if (!at || f.path !== manifestPath(at.id)) continue;
    const parsed = parseManifest((await store.read(f.path))?.text ?? "", at.id);
    if (typeof parsed !== "string") manifests.set(at.id, parsed);
  }
  const off = await disabledIn(store, person);
  return [...manifests.values()].flatMap((m) => m.contributes.embeds.map((e) => ({ ...e, extension: m.id, on: !off.has(m.id), example: exampleOf(e) })));
}
