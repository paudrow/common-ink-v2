// Archive: notes you're done with but keep. A note's path goes in .common-ink/archive.json through the
// workspace's archive and unarchive operations (the same ones MCP and the CLI use), so each is a change
// that undo takes back. This draws what you see of it: the command and its keys, the banner on an
// archived note, and the Archive view.
import type { FilePath } from "../../../../worker/src/files.ts";
import { icon } from "common-ink/icons";
import type { ExtensionContext, ExtensionModule } from "../../extension-api.ts";
import { archiveBanner, refreshBanners, type BannerEnv } from "./banner.ts";

const ARCHIVE = ".common-ink/archive.json" as FilePath;

/** The archived paths in the archive file's text (worker/src/archive.ts writes it). */
function archivedIn(text: string): string[] {
  try {
    const list = (JSON.parse(text || "{}") as { archived?: unknown }).archived;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

async function post<T>(route: string, body: unknown): Promise<T> {
  // Archiving is the workspace's to record, so it waits for the server: say so plainly when it can't be reached.
  const res = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
    throw new Error(navigator.onLine ? "the server can't be reached; try again" : "you're offline; try again once you're back");
  });
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Error((answer as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return answer as T;
}

const extension: ExtensionModule = {
  async activate(ctx) {
    let archived = new Set<string>();
    const banner: BannerEnv = { archived: (path) => archived.has(path), unarchive: (path) => void set([path], false) };
    const load = async () => {
      archived = new Set(archivedIn((await ctx.files.read(ARCHIVE).catch(() => null))?.text ?? ""));
      refreshBanners(banner);
      ctx.views.refresh("archive");
    };
    ctx.events.onSaved((path) => path === ARCHIVE && void load());

    /** Archive or unarchive notes, saying so with Undo. */
    const set = async (paths: string[], archive: boolean) => {
      const name = paths.length === 1 ? `"${ctx.util.label(paths[0] as FilePath)}"` : `${paths.length} notes`;
      try {
        const done = await post<{ revision: number | null; archived: string[] }>(archive ? "/api/archive" : "/api/unarchive", { paths });
        archived = new Set(done.archived);
        refreshBanners(banner);
        ctx.views.refresh("archive");
        if (done.revision === null) return;
        const revision = done.revision;
        ctx.workbench.notice(`${archive ? "Archived" : "Unarchived"} ${name}`, [{ label: "Undo", run: () => undo(revision, name, archive) }]);
      } catch (err) {
        ctx.workbench.notice(`Couldn't ${archive ? "archive" : "unarchive"} ${name}: ${(err as Error).message}`);
      }
    };
    /** Take back an archive or unarchive, saying so if it couldn't be. */
    const undo = async (revision: number, name: string, archive: boolean) => {
      try {
        const [result] = await post<Array<{ status: string }>>("/api/undo", { revisions: [revision] });
        await load();
        if (result?.status !== "undone" && result?.status !== "unchanged") throw new Error(result?.status === "missing" ? "that change isn't in history any more" : "the archive changed in a way it can't be taken back from");
      } catch (err) {
        ctx.workbench.notice(`Couldn't undo ${archive ? "archiving" : "unarchiving"} ${name}: ${(err as Error).message}`);
      }
    };
    const onFocused = (archive: boolean | "toggle") => {
      const path = ctx.workbench.focusedPath();
      if (!path?.endsWith(".md")) return ctx.workbench.notice("Open a note to archive it");
      return set([path], archive === "toggle" ? !archived.has(path) : archive);
    };
    ctx.commands.register("archive.toggle", () => onFocused("toggle"));
    ctx.commands.register("archive.archive", () => onFocused(true));
    ctx.commands.register("archive.unarchive", () => onFocused(false));
    ctx.commands.register("archive.show", () => ctx.views.open("archive", { newTab: true }));
    ctx.editor.extend(archiveBanner(banner));
    ctx.views.register("archive", { render: (root) => drawArchive(ctx, root, [...archived].sort(), (path) => void set([path], false)) });
    await load();
  },
};

/** The Archive view: every archived note, to open or unarchive. */
function drawArchive(ctx: ExtensionContext, root: HTMLElement, paths: string[], unarchive: (path: string) => void) {
  const list = document.createElement("ul");
  list.className = "archive-list";
  for (const path of paths) {
    const row = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "archive-open";
    open.textContent = ctx.util.label(path as FilePath);
    open.title = path;
    open.addEventListener("click", () => void ctx.workbench.open(path as FilePath));
    const back = document.createElement("button");
    back.type = "button";
    back.className = "archive-unarchive";
    back.title = `Unarchive ${ctx.util.label(path as FilePath)}`;
    back.setAttribute("aria-label", back.title);
    back.append(icon("archive-restore"));
    back.addEventListener("click", () => unarchive(path));
    row.append(open, back);
    list.append(row);
  }
  const empty = document.createElement("p");
  empty.className = "archive-empty";
  const key = ctx.commands.shortcut("archive.toggle");
  empty.textContent = `Nothing archived. Archive a note with ${key ? `${key}, ` : ""}:archive, or its tab's menu: it stays where it is, out of the Feed.`;
  root.replaceChildren(paths.length ? list : empty);
}

export default extension;
