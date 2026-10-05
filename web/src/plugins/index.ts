// The built-in plugins, in the order they start, each with its source to show in the Plugins view.
// The self-contained ones (plain JavaScript on the plugin API alone) can be copied into the workspace
// and changed there.
import type { BuiltIn } from "../plugin-host.ts";
import commandsBar from "./command-bar-commands.js";
import commandsBarSource from "./command-bar-commands.js?raw";
import notesBar from "./command-bar-notes.js";
import notesBarSource from "./command-bar-notes.js?raw";
import { historyPlugin } from "./history.ts";
import historySource from "./history.ts?raw";

export const BUILT_IN: BuiltIn[] = [
  {
    id: "commandBar.notes",
    name: "Open by name",
    description: "⌘P: open a note or other file by name, or make a new note.",
    module: notesBar,
    source: notesBarSource,
    file: "web/src/plugins/command-bar-notes.js",
  },
  {
    id: "commandBar.commands",
    name: "Command list",
    description: "⌘⇧P, or > in the command bar: run any command, with its shortcut shown.",
    module: commandsBar,
    source: commandsBarSource,
    file: "web/src/plugins/command-bar-commands.js",
  },
  {
    id: "history",
    name: "History",
    description: "The history panel: changes with authors and diffs, revert, restore, labels, undo and redo.",
    module: historyPlugin,
    source: historySource,
    file: "web/src/plugins/history.ts",
  },
];
