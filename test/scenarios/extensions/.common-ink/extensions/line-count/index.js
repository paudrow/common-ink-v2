// Line count, the tests' sandboxed workspace extension: how many lines the note on show has, in the
// status bar, and in its view. Reading a note asks you first, as every sandboxed extension's does.

const plural = (n) => `${n} ${n === 1 ? "line" : "lines"}`;

export default {
  activate(ctx) {
    const views = [];
    /** What it knows about the note on show: its lines, why it couldn't read it, or nothing (no note). */
    let now = null;
    const details = () => (!now ? "No note on show." : now.problem ?? `${now.label}: ${plural(now.lines)}`);
    const update = async () => {
      const path = await ctx.workbench.focusedPath();
      if (!path || !path.endsWith(".md")) now = null;
      else {
        try {
          now = { label: ctx.util.label(path), lines: (await ctx.files.read(path)).text.split("\n").length };
        } catch (err) {
          now = { problem: err.message };
        }
      }
      ctx.statusBar.set("lineCount.status", now && !now.problem ? plural(now.lines) : "", now && !now.problem ? details() : undefined);
      for (const view of views) view.post({ text: details() });
    };
    ctx.views.register("lineCount", {
      resolve(webview) {
        views.push(webview);
        webview.html = `<p id="count">${details()}</p>
<script>commonInk.onMessage((m) => { document.getElementById("count").textContent = m.text; });</script>`;
      },
    });
    ctx.commands.register("lineCount.show", () => ctx.views.toggle("lineCount"));
    ctx.events.onFocus(() => void update());
    ctx.events.onSaved(() => void update());
    void update();
  },
};
