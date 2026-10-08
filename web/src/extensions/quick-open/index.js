// ⌘P: open a note or other file by name, a view extensions list there (Calendar), or make a new note. A built-in extension; "Customize" in
// the Extensions view copies this file into the workspace as it is, where it runs in place of this one.

/** @type {import("../../extension-api.ts").ExtensionModule} */
export default {
  activate(ctx) {
    ctx.commandBar.provide({
      prefix: "",
      placeholder: "Open a note by name, or type > for commands",
      items(query) {
        const files = ctx.files.list();
        const matches = ctx.util.fuzzyFilter(query, files, (f) => ctx.util.label(f.path)).map((f) => ({
          label: ctx.util.label(f.path),
          run: () => ctx.workbench.openPicked(f.path),
        }));
        // Views extensions list for ⌘P ("Open calendar" is listed as "Calendar"), after the files.
        const views = ctx.commands.menu("quickOpen").map((c) => ({ ...c, label: c.title.replace(/^Open /, "").replace(/^\w/, (ch) => ch.toUpperCase()) }));
        matches.push(...ctx.util.fuzzyFilter(query, views, (v) => v.label).map((v) => ({ label: v.label, run: () => ctx.commands.run(v.command, v.by) })));
        const path = ctx.util.notePathFor(query);
        if (path && !files.some((f) => f.path === path)) matches.push({ label: `New note: ${ctx.util.label(path)}`, run: () => ctx.workbench.openPicked(path) });
        return matches;
      },
    });
  },
};
