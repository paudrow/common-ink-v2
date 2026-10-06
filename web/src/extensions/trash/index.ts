// Trash: the notes deleted lately, from history (worker/src/files.ts, `deleted`). Restoring one undoes
// its delete, so it comes back where it was with its whole history. After trash.retentionDays it's
// purged. Links to a note in Trash say so.
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
    let byPath = new Map<string, Trashed>();
    const retentionDays = () => ctx.settings.get<number>("trash.retentionDays") ?? 30;

    const load = async () => {
      items = await call<Trashed[]>("GET", "/api/trash").catch(() => items);
      byPath = new Map(items.map((i) => [i.path, i]));
      view.show(items);
      refreshTrashLinks();
    };

    const restore = async (path: string) => {
      const name = ctx.util.label(path as FilePath);
      try {
        const done = await call<{ file: { path: FilePath; revision: number } }>("POST", "/api/restore", { path });
        await load();
        await ctx.workbench.refreshFromServer([done.file.path]);
        ctx.workbench.notice(`Restored "${name}" to ${done.file.path}, with its history`, [
          { label: "Open", run: () => ctx.workbench.open(done.file.path) },
          { label: "Undo", run: () => call("POST", "/api/undo", { revisions: [done.file.revision] }).then(load) },
        ]);
      } catch (err) {
        ctx.workbench.notice(`Couldn't restore "${name}": ${(err as Error).message}`);
      }
    };

    const view = new TrashView({
      me: ctx.me,
      retentionDays,
      restore: (item) => restore(item.path),
      lastVersion: async (item) => (await call<{ text: string } | null>("GET", `/api/version?${new URLSearchParams({ path: item.path, revision: String(item.before) })}`))?.text ?? "",
    });
    ctx.views.register("trash", { render: (root) => view.render(root) });
    ctx.commands.register("trash.show", () => {
      ctx.views.open("trash", { newTab: true });
      void load();
    });
    ctx.editor.extend(trashLinks({ inTrash: (target) => (byPath.has(ctx.util.notePathFor(target) ?? "") ? ctx.util.notePathFor(target) : null), restore: (path) => void restore(path) }));

    // Deletes, restores and purges are changes like any other: Trash hears of them as they're saved.
    let timer = 0;
    ctx.events.onSaved((path) => {
      if (!path.endsWith(".md")) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 300);
    });
    await load();
  },
};

export default extension;
