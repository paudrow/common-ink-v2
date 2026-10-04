# Writing a plugin

Built-in features are plugins on the same API offered to everyone else (ADR 0004). The command bar's two providers and the history panel are built this way: see `web/src/plugins/`.

A plugin is an object with an `id`, a `description` and an `activate(ctx)` function. `ctx` is a `PluginContext` (`web/src/plugins.ts`):

- `ctx.commands.register({ id, title, run })` adds a command. It shows in ⌘⇧P, keybindings in settings can call it by id, and other plugins can `ctx.commands.run(id)` it.
- `ctx.commandBar.provide({ prefix, placeholder, items(query) })` adds a command bar provider. The bar picks the provider with the longest prefix the query starts with.
- `ctx.panels.register({ id, title, render(el) })` adds a side panel. `toggle`, `show` and `refresh` control it.
- `ctx.docs` lists, reads and writes docs. Writes are changes by the signed-in person.
- `ctx.workbench` opens docs and tells you what's focused, including the focused CodeMirror view.
- `ctx.events.onSaved` and `ctx.events.onFocus` say when a doc saved and when focus moved.
- `ctx.settings()` is the current settings.

Turn a plugin off with `"plugins.disabled": ["history"]` in user or workspace settings. It takes effect on the next reload.

```ts
import type { Plugin } from "./plugins.ts";

export const wordCount: Plugin = {
  id: "wordCount",
  description: "A command that counts the words in the focused note.",
  activate(ctx) {
    ctx.commands.register({
      id: "wordCount.show",
      title: "Count words",
      run: () => {
        const text = ctx.workbench.focusedView()?.state.doc.toString() ?? "";
        alert(`${text.split(/\s+/).filter(Boolean).length} words`);
      },
    });
  },
};
```
