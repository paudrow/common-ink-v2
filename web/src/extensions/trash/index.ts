// Trash: the notes deleted lately, from history (worker/src/files.ts, `deleted`). Restoring one undoes
// its delete, so it comes back where it was with its whole history. Deleting one forever purges it: its
// text leaves history, which can't be undone, so it asks first. After trash.retentionDays the Worker
// purges it anyway. Links to a note in Trash say so.
import type { FilePath } from "../../../../worker/src/files.ts";
import type { ExtensionModule } from "../../extension-api.ts";
import { refreshTrashLinks, trashLinks } from "./links.ts";
import { TrashView, type Trashed } from "./view.ts";

async function call<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const res = await fetch(route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Error((answer as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return answer as T;
}

const extension: ExtensionModule = {
  async activate(ctx) {
    let items: Trashed[] = [];
    /** Paths of notes in Trash that no note has now: links to them say "In Trash". */
    let gone = new Map<string, Trashed>();
    const retentionDays = () => ctx.settings.get<number>("trash.retentionDays") ?? 30;

    const load = async () => {
      items = await call<Trashed[]>("GET", "/api/trash").catch(() => items);
      const here = new Set((await ctx.files.fetchList().catch(() => ctx.files.list())).map((f) => f.path));
      gone = new Map(items.filter((i) => !here.has(i.path as FilePath)).map((i) => [i.path, i]));
      view.show(items);
      refreshTrashLinks();
    };

    /** Bring a note back: the one its delete names, at its path, or beside a note that has the path now. */
    const restore = async (item: Pick<Trashed, "path" | "revision">) => {
      const name = ctx.util.label(item.path as FilePath);
      try {
        const done = await call<{ path: FilePath; revision: number }>("POST", "/api/restore", { path: item.path, deleted: item.revision });
        await load();
        await ctx.workbench.refreshFromServer([done.path]);
        const where = done.path === item.path ? `to ${done.path}, with its history` : `as ${done.path}: another note has ${item.path} now`;
        ctx.workbench.notice(`Restored "${name}" ${where}`, [
          { label: "Open", run: () => ctx.workbench.open(done.path) },
          { label: "Undo", run: () => call("POST", "/api/undo", { revisions: [done.revision] }).then(load) },
        ]);
      } catch (err) {
        ctx.workbench.notice(`Couldn't restore "${name}": ${(err as Error).message}`);
      }
    };

    /** Purge notes, once the person says so: nothing about this can be undone. */
    const purge = async (deleted: Trashed[], ask: { title: string; text: string; yes: string }) => {
      if (!deleted.length || !(await ctx.workbench.confirm(ask.title, ask.text, ask.yes, { danger: true }))) return;
      try {
        const done = await call<{ purged: Array<{ path: string }> }>("POST", "/api/purge", { deleted: deleted.map((d) => d.revision) });
        await load();
        ctx.workbench.notice(`Deleted ${done.purged.length === 1 ? `"${ctx.util.label(done.purged[0].path as FilePath)}"` : `${done.purged.length} notes`} forever`);
      } catch (err) {
        ctx.workbench.notice(`Couldn't delete forever: ${(err as Error).message}`);
      }
    };

    const view = new TrashView({
      me: ctx.me,
      retentionDays,
      restore: (item) => restore(item),
      deleteForever: (item) =>
        purge([item], { title: `Delete "${item.title}" forever?`, text: "Its text leaves history, and this can't be undone. History keeps a line saying you deleted it.", yes: "Delete forever" }),
      empty: () =>
        purge(items, {
          title: "Empty Trash?",
          text: `${items.length === 1 ? "The note in Trash is" : `All ${items.length} notes in Trash are`} deleted forever: their text leaves history, and this can't be undone.`,
          yes: "Empty Trash",
        }),
      lastVersion: async (item) => (await call<{ text: string } | null>("GET", `/api/version?${new URLSearchParams({ path: item.path, revision: String(item.before) })}`))?.text ?? "",
    });
    ctx.views.register("trash", {
      render: (root) => {
        view.render(root);
        void load();
      },
    });
    // Moving a note to Trash closes it where it's open, so nothing can be typed into a deleted note.
    // Undo restores it, as Trash's Restore does.
    ctx.commands.register("trash.note", async () => {
      const path = ctx.workbench.focusedPath();
      if (!path?.endsWith(".md")) return ctx.workbench.notice("Open a note to move it to Trash");
      const name = ctx.util.label(path);
      if (ctx.workbench.hasUnsavedChanges()) return ctx.workbench.notice(`"${name}" has changes that aren't saved yet: try again once it's saved`);
      try {
        const file = await ctx.files.read(path);
        const res = await fetch("/api/file", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, base: file.revision }) });
        const done = (await res.json()) as { status: string; file: { revision: number } | null };
        if (done.status === "conflict" || !done.file) throw new Error("it changed meanwhile; try again");
        const revision = done.file.revision;
        await ctx.layout.closeTabs((tab) => "file" in tab && tab.file === path);
        await load();
        ctx.workbench.notice(`Moved "${name}" to Trash`, [{ label: "Undo", run: () => restore({ path, revision }) }]);
      } catch (err) {
        ctx.workbench.notice(`Couldn't move "${name}" to Trash: ${(err as Error).message}`);
      }
    });
    ctx.commands.register("trash.show", () => {
      ctx.views.open("trash", { newTab: true });
      void load();
    });
    ctx.editor.extend(trashLinks({ inTrash: (target, from) => {
      const path = ctx.util.notePathFor(target, from ?? undefined);
      return path && gone.has(path) ? path : null;
    }, restore: (path) => {
      const item = gone.get(path);
      if (item) void restore(item);
    } }));

    // Trash changes only by a delete, an undo (a restore is one) or a purge: it listens for those
    // changes, not every save.
    let timer = 0;
    ctx.events.onChange((change) => {
      if (!change.deleted && !change.undoes && !change.purged) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 200);
    });
    await load();
  },
};

export default extension;
