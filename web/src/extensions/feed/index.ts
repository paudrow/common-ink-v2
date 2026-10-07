// The Feed (study, sections 5.2 and 6.2): every note that isn't archived, pinned ones first, then newest
// change first, as cards. It reads them with search (`-is:archived sort:edited`, a page at a time, and
// `is:pinned` in the order .common-ink/pins.json has them), archives and pins through the workspace's
// operations and trashes by deleting, as Archive and Trash do, so Undo on the notice, or u, takes any of
// it back. On a phone it's the bottom bar's Feed, and what the app opens on.
import { ago, describeAuthor } from "common-ink/describe";
import type { FilePath } from "common-ink/files";
import type { ExtensionModule } from "../../extension-api.ts";
import { FeedView, type Card, type SwipeChoice } from "./view.ts";

export const FEED_QUERY = "-is:archived sort:edited";
const PINS = ".common-ink/pins.json" as FilePath;

async function call<T>(method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<T> {
  // Archiving and trashing are the workspace's to record, so they wait for the server: say so plainly when it can't be reached.
  const res = await fetch(route, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => {
    throw new Error(navigator.onLine ? "the server can't be reached; try again" : "you're offline; try again once you're back");
  });
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Error((answer as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return answer as T;
}

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The pinned paths in the pins file's text, in order (worker/src/pins.ts writes it). */
function parsePinned(text: string): string[] {
  try {
    const list = (JSON.parse(text || "{}") as { pinned?: unknown }).pinned;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

const extension: ExtensionModule = {
  activate(ctx) {
    const name = (paths: FilePath[]) => (paths.length === 1 ? `"${ctx.util.label(paths[0])}"` : `${paths.length} notes`);
    const swipe = (side: "right" | "left"): SwipeChoice => {
      const value = ctx.settings.get<string>(`feed.swipe.${side}`);
      return value === "archive" || value === "trash" || value === "pin" || value === "none" ? value : side === "right" ? "archive" : "trash";
    };
    /** What u (or ⌘Z's cousin, Undo on the notice) takes back: the last archive, trash or pin. */
    let last: (() => Promise<void>) | null = null;
    const search = async (query: string, offset: number, limit: number) => {
      const found = await call<{ total: number; results: Card[] }>("GET", `/api/search?${new URLSearchParams({ query, limit: String(limit), offset: String(offset), zone: ZONE })}`);
      return { cards: found.results.map(({ path, title, edited, author }) => ({ path, title, edited, author })), total: found.total };
    };

    const view = new FeedView({
      page: (offset, limit) => search(`${FEED_QUERY} -is:pinned`, offset, limit),
      pinned: async () => {
        const order = parsePinned((await ctx.files.read(PINS).catch(() => null))?.text ?? "");
        const { cards } = await search("is:pinned -is:archived", 0, 100);
        return cards.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
      },
      undo: () => {
        const undoing = last;
        last = null;
        if (undoing) void undoing();
        else ctx.workbench.notice("Nothing to undo in the Feed");
      },
      pin: async (paths, pinned) => {
        try {
          const done = await call<{ revision: number | null }>("POST", pinned ? "/api/pin" : "/api/unpin", { paths });
          const revision = done.revision;
          const what = `${pinned ? "pinning" : "unpinning"} ${name(paths)}`;
          last = revision === null ? null : () => undo([revision], what);
          ctx.workbench.notice(`${pinned ? "Pinned" : "Unpinned"} ${name(paths)}`, revision === null ? [] : [{ label: "Undo", run: () => undo([revision], what) }]);
          return true;
        } catch (err) {
          ctx.workbench.notice(`Couldn't ${pinned ? "pin" : "unpin"} ${name(paths)}: ${(err as Error).message}`);
          return false;
        }
      },
      text: async (path) => (await ctx.files.read(path)).text,
      open: (path) => void ctx.workbench.open(path),
      swipe,
      who: (author) => ({ name: describeAuthor(author, ctx.me), agent: author.kind === "agent" }),
      when: (time) => ago(time),
      label: (path) => ctx.util.label(path),

      // One change to the archive file, which Undo takes back.
      archive: async (paths) => {
        try {
          const done = await call<{ revision: number | null }>("POST", "/api/archive", { paths });
          const revision = done.revision;
          last = revision === null ? null : () => undo([revision], `archiving ${name(paths)}`);
          ctx.workbench.notice(`Archived ${name(paths)}`, revision === null ? [] : [{ label: "Undo", run: () => undo([revision], `archiving ${name(paths)}`) }]);
          return true;
        } catch (err) {
          ctx.workbench.notice(`Couldn't archive ${name(paths)}: ${(err as Error).message}`);
          return false;
        }
      },

      // Each note deleted, as Trash's "Move to Trash" does: closed where it's open, and Undo restores them all.
      trash: async (paths) => {
        const gone: Array<{ path: FilePath; revision: number }> = [];
        let failed = "";
        for (const path of paths) {
          try {
            const file = await ctx.files.read(path);
            const done = await call<{ status: string; file: { revision: number } | null }>("DELETE", "/api/file", { path, base: file.revision });
            if (done.status === "conflict" || !done.file) throw new Error("it changed meanwhile; try again");
            gone.push({ path, revision: done.file.revision });
          } catch (err) {
            failed = `Couldn't move "${ctx.util.label(path)}" to Trash: ${(err as Error).message}`;
          }
        }
        if (gone.length) {
          const moved = new Set<string>(gone.map((g) => g.path));
          await ctx.layout.closeTabs((tab) => "file" in tab && moved.has(tab.file));
          const what = name(gone.map((g) => g.path));
          last = () => restore(gone, what);
          ctx.workbench.notice(`Moved ${what} to Trash${failed ? `. ${failed}` : ""}`, [{ label: "Undo", run: () => restore(gone, what) }]);
        } else if (failed) ctx.workbench.notice(failed);
        return gone.length > 0;
      },
    });

    const undo = async (revisions: number[], what: string) => {
      try {
        const results = await call<Array<{ status: string }>>("POST", "/api/undo", { revisions });
        if (results.some((r) => r.status !== "undone" && r.status !== "unchanged")) throw new Error("it changed since in a way that can't be taken back");
      } catch (err) {
        ctx.workbench.notice(`Couldn't undo ${what}: ${(err as Error).message}`);
      }
      await view.reload();
    };
    const restore = async (gone: Array<{ path: FilePath; revision: number }>, what: string) => {
      view.ownChanges(gone.map((g) => g.path));
      try {
        for (const g of gone) await call("POST", "/api/restore", { path: g.path, deleted: g.revision });
      } catch (err) {
        ctx.workbench.notice(`Couldn't restore ${what}: ${(err as Error).message}`);
      }
      await view.reload();
    };

    ctx.views.register("feed", { render: (box) => view.render(box) });
    ctx.commands.register("feed.show", () => ctx.views.open("feed", { newTab: true }));
    ctx.events.onChange((change) => {
      if (change.path.endsWith(".md") || change.path === ".common-ink/archive.json" || change.path === PINS) view.changed(change.path);
    });
  },
};

export default extension;
