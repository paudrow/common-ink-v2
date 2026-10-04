// The command bar's providers, as built-in plugins: notes by name (no prefix) and commands (">").
import { fuzzyFilter } from "../fuzzy.ts";
import { keyFor } from "../commands.ts";
import { formatKeys } from "../keys.ts";
import { notePathFor } from "../links.ts";
import type { Plugin } from "../plugins.ts";

export const notesProviderPlugin: Plugin = {
  id: "commandBar.notes",
  description: "⌘P: open a note or other file by name, or make a new note.",
  activate(ctx) {
    ctx.commandBar.provide({
      prefix: "",
      placeholder: "Open a note by name, or type > for commands",
      items(query) {
        const files = ctx.files.list();
        const matches = fuzzyFilter(query, files, (d) => ctx.workbench.label(d.path)).map((d) => ({
          label: ctx.workbench.label(d.path),
          run: () => ctx.workbench.openPicked(d.path),
        }));
        const path = notePathFor(query);
        if (path && !files.some((d) => d.path === path)) matches.push({ label: `New note: ${ctx.workbench.label(path)}`, run: () => ctx.workbench.openPicked(path) });
        return matches;
      },
    });
  },
};

export const commandsProviderPlugin: Plugin = {
  id: "commandBar.commands",
  description: "⌘⇧P, or > in the command bar: run any command, with its shortcut shown.",
  activate(ctx) {
    ctx.commandBar.provide({
      prefix: ">",
      placeholder: "Run a command",
      items: (query) =>
        fuzzyFilter(query, ctx.commands.all(), (c) => c.title).map((c) => {
          const key = keyFor(c.id, ctx.settings().keybindings);
          return { label: c.title, detail: key && formatKeys(key), run: () => ctx.commands.run(c.id) };
        }),
    });
  },
};
