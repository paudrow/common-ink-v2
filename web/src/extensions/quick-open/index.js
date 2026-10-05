// ⌘P: open a note or other file by name, or make a new note. A built-in extension; "Customize" in
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
        const path = ctx.util.notePathFor(query);
        if (path && !files.some((f) => f.path === path)) matches.push({ label: `New note: ${ctx.util.label(path)}`, run: () => ctx.workbench.openPicked(path) });
        return matches;
      },
    });
  },
};
