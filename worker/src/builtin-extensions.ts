// The built-in extensions' manifests, as the Worker needs them: to check what an extension declares
// before fetching for it, and to tell agents what embeds there are. The app has the same files.
import calendar from "../../web/src/extensions/calendar/extension.json";
import commandList from "../../web/src/extensions/command-list/extension.json";
import contacts from "../../web/src/extensions/contacts/extension.json";
import history from "../../web/src/extensions/history/extension.json";
import quickOpen from "../../web/src/extensions/quick-open/extension.json";
import todos from "../../web/src/extensions/todos/extension.json";
import uploads from "../../web/src/extensions/uploads/extension.json";
import { parseManifest, type ExtensionManifest } from "./extensions.ts";

const RAW: unknown[] = [quickOpen, commandList, history, todos, calendar, contacts, uploads];

export const BUILT_IN_MANIFESTS: ExtensionManifest[] = RAW.map((m) => {
  const id = (m as { id: string }).id;
  const parsed = parseManifest(m, id, { builtIn: true });
  if (typeof parsed === "string") throw new Error(`Built-in extension ${id}: ${parsed}`);
  return parsed;
});
