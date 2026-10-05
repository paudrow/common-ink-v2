// The built-in extensions, in the order they start, each from its folder: extension.json, its code, and
// its source to show in the Extensions view (and copy, with Customize).
import { parseManifest, type ExtensionManifest } from "../../../worker/src/extensions.ts";
import type { ExtensionModule } from "../extension-api.ts";
import type { BuiltIn } from "../extension-host.ts";
import calendar from "./calendar/index.ts";
import commandList from "./command-list/index.js";
import contacts from "./contacts/index.ts";
import history from "./history/index.ts";
import quickOpen from "./quick-open/index.js";
import todos from "./todos/index.ts";
import uploads from "./uploads/index.ts";

const manifests = import.meta.glob<Record<string, unknown>>("./*/extension.json", { eager: true, import: "default" });
const sources = import.meta.glob<string>("./*/*.{js,ts,json}", { eager: true, query: "?raw", import: "default" });

function builtIn(id: string, module: ExtensionModule): BuiltIn {
  const manifest = parseManifest(manifests[`./${id}/extension.json`], id, { builtIn: true });
  if (typeof manifest === "string") throw new Error(`Built-in extension ${id}: ${manifest}`);
  const files = Object.entries(sources).flatMap(([path, text]) => (path.startsWith(`./${id}/`) ? [[path.slice(id.length + 3), text] as const] : []));
  return { manifest: manifest as ExtensionManifest, module, sources: Object.fromEntries(files), folder: `web/src/extensions/${id}` };
}

export const BUILT_IN: BuiltIn[] = [
  builtIn("quick-open", quickOpen),
  builtIn("command-list", commandList),
  builtIn("history", history),
  builtIn("todos", todos),
  builtIn("calendar", calendar),
  builtIn("contacts", contacts),
  builtIn("uploads", uploads),
];
