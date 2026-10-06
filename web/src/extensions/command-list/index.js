// ⌘⇧P, or > in the command bar: run any command, with its shortcut. A built-in extension; "Customize" in
// the Extensions view copies this file into the workspace as it is, where it runs in place of this one.

/** @type {import("../../extension-api.ts").ExtensionModule} */
export default {
  activate(ctx) {
    ctx.commandBar.provide({
      prefix: ">",
      placeholder: "Run a command",
      items: (query) =>
        ctx.util.fuzzyFilter(query, ctx.commands.all(), (c) => c.title).map((c) => ({
          label: c.title,
          // One that's off on this device is listed greyed, with why: choosing it says so again.
          detail: c.off ?? ctx.commands.shortcut(c.id),
          ...(c.off ? { off: true } : {}),
          run: () => ctx.commands.run(c.id),
        })),
    });
  },
};
