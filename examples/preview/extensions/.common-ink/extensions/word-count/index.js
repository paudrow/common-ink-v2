// A sample workspace extension: a Word count view for the note on show. It runs sandboxed, as every
// extension that isn't built in does until you trust it: its view is a webview, and reading your note
// asks you first. Edit it like a note (history keeps every version), then reload to run the new version.

export default {
  activate(ctx) {
    const views = [];
    const count = async () => {
      const path = await ctx.workbench.focusedPath();
      if (!path) return "No note on show.";
      try {
        const { text } = await ctx.files.read(path);
        return `${text.split(/\s+/).filter(Boolean).length} words in ${ctx.util.label(path)}`;
      } catch (err) {
        return err.message;
      }
    };
    const update = async () => {
      const text = await count();
      for (const view of views) view.post({ text });
    };
    ctx.views.register("wordCount", {
      resolve(webview) {
        views.push(webview);
        webview.html = `<p id="count">Counting…</p>
<script>commonInk.onMessage((m) => { document.getElementById("count").textContent = m.text; });</script>`;
        void update();
      },
    });
    ctx.commands.register("wordCount.show", () => ctx.views.toggle("wordCount"));
    ctx.events.onFocus(() => void update());
    ctx.events.onSaved(() => void update());
  },
};
