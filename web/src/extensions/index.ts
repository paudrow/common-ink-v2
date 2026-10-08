// The built-in extensions, in the order they're listed, each from its folder: extension.json, its code
// (loaded only when one of its activation events happens, so it isn't in the app's first download), its
// source to show, and the JavaScript Customize copies into the workspace (both loaded when asked for).
import { parseManifest } from "../../../worker/src/extensions.ts";
import type { ExtensionModule } from "../extension-api.ts";
import type { BuiltIn } from "../extension-host.ts";

const manifests = import.meta.glob<Record<string, unknown>>("./*/extension.json", { eager: true, import: "default" });
const sources = import.meta.glob<string>("./*/*.{js,ts,json}", { query: "?raw", import: "default" });
const code = import.meta.glob<{ default: ExtensionModule }>("./*/index.{js,ts}");

/** The order they're listed in the Extensions view, and start in when several start together. */
const ORDER = ["workbench", "quick-open", "command-list", "vim", "live-preview", "gfm", "code-blocks", "latex", "lists", "history", "archive", "trash", "daily", "tasks", "timers", "media", "link-embeds", "calendar", "contacts", "data-sources", "uploads", "words"];

function builtIn(id: string): BuiltIn {
  const manifest = parseManifest(manifests[`./${id}/extension.json`], id, { builtIn: true });
  if (typeof manifest === "string") throw new Error(`Built-in extension ${id}: ${manifest}`);
  const load = code[`./${id}/${manifest.main}`];
  if (!load) throw new Error(`Built-in extension ${id}: no ${manifest.main}`);
  const files = Object.keys(sources).flatMap((path) => (path.startsWith(`./${id}/`) ? [path.slice(id.length + 3)] : []));
  return {
    manifest,
    load: async () => (await load()).default,
    files,
    source: (file) => sources[`./${id}/${file}`]?.() ?? Promise.resolve(""),
    copy: async () => (await import("virtual:builtin-copies")).default[id] ?? {},
    folder: `web/src/extensions/${id}`,
  };
}

export const BUILT_IN: BuiltIn[] = ORDER.filter((id) => manifests[`./${id}/extension.json`]).map(builtIn);
