// A sample workspace extension: a Word count view for the note on show. It's files in this workspace,
// so edit them like a note (history keeps every version), then reload to run the new version.

export default {
  activate(ctx) {
    ctx.views.register("wordCount", {
      async render(el) {
        const path = ctx.workbench.focusedPath();
        if (!path) return void (el.textContent = "No note on show.");
        const { text } = await ctx.files.read(path);
        el.textContent = `${text.split(/\s+/).filter(Boolean).length} words in ${ctx.util.label(path)}`;
      },
    });
    ctx.commands.register("wordCount.show", () => ctx.views.toggle("wordCount"));
    ctx.events.onFocus(() => ctx.views.refresh("wordCount"));
    ctx.events.onSaved(() => ctx.views.refresh("wordCount"));
  },
};
