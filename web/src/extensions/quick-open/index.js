// ⌘K or ⌘P: search. Notes by their words, then other files and views by name, what extensions find
// (tasks, events), commands, and a new note by the name typed. A built-in extension; "Customize" in the
// Extensions view copies this file into the workspace as it is, where it runs in place of this one.
import { matchesWords, parse } from "common-ink/query";

const PER_SECTION = 8;

/** @type {import("../../extension-api.ts").ExtensionModule} */
export default {
  activate(ctx) {
    ctx.commandBar.provide({
      prefix: "",
      placeholder: "Search notes, tasks and events, or type > for commands",
      query: true,
      async items(query, update) {
        const parsed = parse(query, ctx.search.filterKeys());
        const plain = parsed.terms.every((t) => t.kind === "words");
        const files = ctx.files.list();
        // By name: files search doesn't index (settings, extensions' code), views extensions list for ⌘P
        // ("Open calendar" is "Calendar"), and names typed loosely ("lp" for Launch plan).
        const views = ctx.commands.menu("quickOpen").map((c) => ({ ...c, label: c.title.replace(/^Open /, "").replace(/^\w/, (ch) => ch.toUpperCase()) }));
        const commands = ctx.commands
          .all()
          .filter((c) => matchesWords(parsed, c.title))
          .slice(0, 5)
          .map((c) => ({ label: c.title, aside: ctx.commands.shortcut(c.id), section: "Commands", run: () => ctx.commands.run(c.id) }));
        const path = ctx.util.notePathFor(query);
        const create = path && !files.some((f) => f.path === path) ? [{ label: `New note: ${ctx.util.label(path)}`, section: "New", run: () => ctx.workbench.openPicked(path) }] : [];
        /**
         * The list, from the sections found so far: notes, then by name, then the rest, commands and New.
         * @param {import("../../search.ts").SearchSection[]} sections
         */
        const build = (sections) => {
          const items = sections.flatMap((s) => [
            ...(s.note ? [{ label: s.note, dim: true, section: s.title, run: () => {} }] : []),
            ...s.results.map((r) => ({ label: r.title, detail: r.detail, aside: r.aside, dim: r.dim, section: s.title, run: () => r.run() })),
          ]);
          if (!query || !plain) return items;
          const shown = new Set(sections.flatMap((s) => s.results.map((r) => r.path)));
          const byName = ctx.util
            .fuzzyFilter(query, files.filter((f) => !shown.has(f.path)), (f) => ctx.util.label(f.path))
            .slice(0, PER_SECTION)
            .map((f) => ({ label: ctx.util.label(f.path), section: "By name", run: () => ctx.workbench.openPicked(f.path) }));
          byName.push(...ctx.util.fuzzyFilter(query, views, (v) => v.label).map((v) => ({ label: v.label, section: "By name", run: () => ctx.commands.run(v.command) })));
          const first = items.filter((i) => i.section === "Notes" || i.section === "Recent");
          const others = items.filter((i) => i.section !== "Notes" && i.section !== "Recent");
          return [...first, ...byName, ...others, ...commands, ...create];
        };
        return build(await ctx.search.find(query, PER_SECTION, (some) => update?.(build(some))).catch(() => []));
      },
    });
  },
};
