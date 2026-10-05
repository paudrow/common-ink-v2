// A sample workspace plugin: a Word count panel for the note on show. It's a file in this workspace,
// so edit it like a note (its history keeps every version), then reload to run the new version.

export default {
  activate(ctx) {
    const count = () => (ctx.workbench.focusedView()?.state.doc.toString() ?? "").split(/\s+/).filter(Boolean).length;
    ctx.panels.register({
      id: "wordCount",
      title: "Word count",
      render(el) {
        const path = ctx.workbench.focusedPath();
        el.textContent = path ? `${count()} words in ${ctx.workbench.label(path)}` : "No note on show.";
      },
    });
    ctx.commands.register({ id: "wordCount.show", title: "Show word count", run: () => ctx.panels.toggle("wordCount") });
    ctx.events.onFocus(() => ctx.panels.refresh("wordCount"));
    ctx.events.onSaved(() => ctx.panels.refresh("wordCount"));
  },
};
