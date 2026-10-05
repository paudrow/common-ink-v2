// Word count, from the app's catalog: how many words the note on show has, in the status bar next to
// Vim's mode; click it for more. Installed, it's a workspace extension, so it runs sandboxed, as every
// extension that isn't built in does until you trust it, and reading your note asks you first. Edit it
// like a note (history keeps every version), then reload to run the new version.

const number = new Intl.NumberFormat();

/** How long a note is: its words, characters, and minutes to read at 230 words a minute. */
function measure(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return { words, characters: text.length, minutes: Math.max(1, Math.round(words / 230)) };
}

const plural = (n, one, many) => `${number.format(n)} ${n === 1 ? one : many}`;

export default {
  activate(ctx) {
    const views = [];
    /** What it knows about the note on show: its measure, why it couldn't read it, or nothing (no note). */
    let now = null;
    const details = () => {
      if (!now) return "No note on show.";
      if (now.problem) return now.problem;
      return `${now.label}: ${plural(now.words, "word", "words")} · ${plural(now.characters, "character", "characters")} · about ${plural(now.minutes, "minute", "minutes")} to read`;
    };
    const update = async () => {
      const path = await ctx.workbench.focusedPath();
      // It counts notes, and only asks to read notes: settings and other files aren't its business.
      if (!path || !path.endsWith(".md")) now = null;
      else {
        try {
          now = { label: ctx.util.label(path), ...measure((await ctx.files.read(path)).text) };
        } catch (err) {
          now = { problem: err.message };
        }
      }
      ctx.statusBar.set("wordCount.status", now && !now.problem ? plural(now.words, "word", "words") : "", now && !now.problem ? `${details()}. Click for the Word count view.` : undefined);
      for (const view of views) view.post({ text: details() });
    };
    ctx.views.register("wordCount", {
      resolve(webview) {
        views.push(webview);
        webview.html = `<p id="count">${details()}</p>
<script>commonInk.onMessage((m) => { document.getElementById("count").textContent = m.text; });</script>`;
      },
    });
    ctx.commands.register("wordCount.show", () => ctx.views.toggle("wordCount"));
    ctx.events.onFocus(() => void update());
    ctx.events.onSaved(() => void update());
    void update();
  },
};
