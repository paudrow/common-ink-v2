// The built-in extensions' manifests, as the Worker needs them: to check what an extension declares
// before fetching for it, and to tell agents what embeds there are. The app has the same files.
import calendar from "../../web/src/extensions/calendar/extension.json";
import codeBlocks from "../../web/src/extensions/code-blocks/extension.json";
import commandList from "../../web/src/extensions/command-list/extension.json";
import contacts from "../../web/src/extensions/contacts/extension.json";
import gfm from "../../web/src/extensions/gfm/extension.json";
import history from "../../web/src/extensions/history/extension.json";
import daily from "../../web/src/extensions/daily/extension.json";
import latex from "../../web/src/extensions/latex/extension.json";
import lists from "../../web/src/extensions/lists/extension.json";
import linkEmbeds from "../../web/src/extensions/link-embeds/extension.json";
import livePreview from "../../web/src/extensions/live-preview/extension.json";
import media from "../../web/src/extensions/media/extension.json";
import quickOpen from "../../web/src/extensions/quick-open/extension.json";
import timers from "../../web/src/extensions/timers/extension.json";
import tasks from "../../web/src/extensions/tasks/extension.json";
import uploads from "../../web/src/extensions/uploads/extension.json";
import vim from "../../web/src/extensions/vim/extension.json";
import workbench from "../../web/src/extensions/workbench/extension.json";
import { parseManifest, type ExtensionManifest } from "./extensions.ts";

const RAW: unknown[] = [workbench, quickOpen, commandList, vim, livePreview, gfm, codeBlocks, latex, lists, history, daily, tasks, timers, media, linkEmbeds, calendar, contacts, uploads];

export const BUILT_IN_MANIFESTS: ExtensionManifest[] = RAW.map((m) => {
  const id = (m as { id: string }).id;
  const parsed = parseManifest(m, id, { builtIn: true });
  if (typeof parsed === "string") throw new Error(`Built-in extension ${id}: ${parsed}`);
  return parsed;
});
