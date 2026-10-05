// Tasks, a built-in extension: tasks are checkbox lines with todo.txt-style tokens (due:, start:, rec:,
// until:, times:, !high, @person, #tag). In notes, the box ticks and each token is a chip that opens
// its own editor; ⌘. opens the line's field menu, and tokens complete as you type them. The Tasks view
// and the ::tasks embed list tasks from across the notes, in the same rows. Ticking a repeating task
// moves it on to its next date, on the same line. ⌘⇧. opens the quick-add bar anywhere: a task typed
// the way you'd say it ("Pay rent every month on the 1st"), added to the inbox.
import { getCM } from "@replit/codemirror-vim";
import { editorFile } from "common-ink/editor-file";
import { isNote } from "common-ink/files";
import { formatKeys } from "common-ink/keys";
import type { Change, FilePath } from "../../../../worker/src/files.ts";
import type { Embed, ExtensionContext, ExtensionModule } from "../../extension-api.ts";
import { openQuickAdd, type Inbox, type QuickAddOptions } from "./bar.ts";
import { today } from "./chips.ts";
import { taskCompletions } from "./complete.ts";
import { mountTaskList, type ListArgs } from "./list.ts";
import type { RowEnv } from "./rows.ts";
import type { DailyNotes } from "../daily/daily.ts";
import { TaskStore, type LogSettings } from "./store.ts";
import { taskInputPrefs } from "./input.ts";
import { describeTaskEdit, parseLogLine } from "./tasks.ts";
import { TasksView } from "./view.ts";
import { openMenuAt, tasksPreview, toggleTaskAt, type TaskEnv } from "./widgets.ts";

const extension: ExtensionModule = {
  async activate(ctx) {
    // Where daily notes are, from the Daily notes extension (undefined while it's off).
    let daily: DailyNotes | undefined;
    const dailyReady = ctx.extensions.api<DailyNotes>("daily").then((d) => (daily = d));
    const logging = (): LogSettings => {
      const mode = ctx.settings.get<string>("tasks.completionLog");
      return { mode: mode === "inline" || mode === "none" ? mode : "daily", logPlain: ctx.settings.get<boolean>("tasks.logPlainTasks") === true };
    };
    const store = new TaskStore(ctx, () => daily, logging);
    const rowEnv: Omit<RowEnv, "reload" | "openTag" | "openPerson"> = {
      store,
      open: (path, line, side) => void open(ctx, path as FilePath, line, side),
      notice: (message, actions) => ctx.workbench.notice(message, actions),
    };
    taskInputPrefs.sources = { tags: () => store.tags(), people: () => store.people(), notes: async () => store.noteList().map((n) => n.title) };
    /** Where quick-add puts a task: the "tasks.inbox" note, or today's daily note (an Inbox note while Daily notes is off). */
    const inbox = (): Inbox => {
      const name = ctx.settings.get<string>("tasks.inbox")?.trim();
      const path = name ? ctx.util.notePathFor(name) : null;
      if (name && path) return { label: ctx.util.label(path), path };
      if (!daily) return { label: "Inbox", path: "Inbox.md" };
      const today = daily.pathFor(daily.today());
      return { label: today.replace(/\.md$/, ""), path: today, daily: true };
    };
    const shortcut = () => {
      const key = ctx.commands.shortcut("tasks.quickAdd");
      return key ?? formatKeys("Mod-Shift-.");
    };
    const quickAdd: Omit<QuickAddOptions, "added" | "escape"> = {
      add: (text, ignore, to) => store.add(text, ignore, to),
      open: (path, line) => void open(ctx, path as FilePath, line),
      inbox,
    };
    const view = new TasksView({ ...rowEnv, tasks: () => store.all(), notePathFor: (name) => ctx.util.notePathFor(name), quickAdd: () => ({ ...quickAdd, shortcut: shortcut() }) });
    const showPerson = (name: string) => {
      view.showPerson(name);
      ctx.views.show("tasks");
    };
    const env: TaskEnv = {
      today,
      chips: () => ctx.settings.get<boolean>("tasks.chips") !== false,
      people: () => store.people(),
      tags: () => store.tags(),
      showPerson,
      say: (message) => ctx.workbench.notice(message),
      path: (view) => view.state.facet(editorFile) ?? ctx.workbench.focusedPath() ?? "",
      how: (view) => {
        const path = view.state.facet(editorFile) ?? ctx.workbench.focusedPath() ?? "";
        return { ...store.logSettings(), path, note: path ? ctx.util.label(path as FilePath) : "" };
      },
      log: (c) => void store.log(c.line, c).catch((e) => ctx.workbench.notice(`Couldn't log it in today's note: ${e instanceof Error ? e.message : e}`)),
      unlog: (c) => void store.unlog(c.line).catch(() => {}),
      putBack: (line) => store.putBack(line),
    };

    ctx.commands.register("tasks.toggle", () => {
      const view = ctx.editor.focused();
      return !!view && toggleTaskAt(view, view.state.selection.main.head, env);
    });
    ctx.commands.register("tasks.menu", () => {
      const view = ctx.editor.focused();
      return !!view && openMenuAt(view, env);
    });
    ctx.commands.register("tasks.show", () => ctx.views.toggle("tasks"));
    ctx.commands.register("tasks.quickAdd", () => {
      const editor = ctx.editor.focused();
      // A task typed here types with the editor's keys: Vim's, if the note's editor has Vim.
      taskInputPrefs.vim = !!(editor && getCM(editor));
      const from = ctx.workbench.focusedPath();
      openQuickAdd({
        ...quickAdd,
        shortcut: shortcut(),
        note: from && isNote(from) ? from : undefined,
        added: (r) => ctx.workbench.notice(`Added to ${ctx.util.label(r.path as FilePath)}`, [{ label: "Open", run: () => open(ctx, r.path as FilePath, r.line) }]),
      });
    });
    ctx.views.register("tasks", { render: (root) => view.render(root) });
    ctx.editor.extend([tasksPreview(env), taskCompletions(env)]);
    ctx.changes.describe(describeChange);
    await dailyReady;

    // ::tasks{folder=Projects tag=work due<=today}: a list of tasks in a note, redrawn as notes change.
    const lists = new Map<HTMLElement, { load(): Promise<void>; set(args: ListArgs): void }>();
    ctx.embeds.register("tasks", {
      render(el: HTMLElement, embed: Embed) {
        const host = document.createElement("div");
        host.className = "qw-tasks is-embed";
        el.replaceChildren(host);
        // A tag or person chip in an embed narrows the Tasks view, which has room for it.
        lists.set(el, mountTaskList(host, embed.args, { ...rowEnv, tasks: () => store.all(), openTag: () => ctx.views.show("tasks"), openPerson: showPerson }));
      },
      update(el: HTMLElement, embed: Embed) {
        lists.get(el)?.set(embed.args);
      },
    });

    // Every list redraws when a note changes, a moment after (a tick writes one note, then reads them).
    let timer = 0;
    ctx.events.onSaved((path) => {
      if (!isNote(path)) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        ctx.views.refresh("tasks");
        for (const [el, list] of lists) el.isConnected ? void list.load() : lists.delete(el);
      }, 150);
    });
  },
};

export default extension;

/** Open a task's note at its line (1-based): here, or in a new window to the right. */
async function open(ctx: ExtensionContext, path: FilePath, line: number, side?: boolean) {
  if (side) await ctx.workbench.split("right", path);
  await ctx.workbench.open(path, { line: Math.max(0, line - 1) });
}

/**
 * What a change did to tasks, for history: each line that changed by itself, if it was a task ticked,
 * reopened or moved on to its next date; and each completion added to a daily note's log.
 */
export function describeChange(change: Pick<Change, "diff">): string | null {
  const said = change.diff.flatMap(({ buffer1, buffer2 }) => {
    if (buffer1.chunk.length === buffer2.chunk.length) return buffer1.chunk.flatMap((before, i) => describeTaskEdit(before, buffer2.chunk[i]) ?? []);
    if (buffer1.chunk.length) return [];
    return buffer2.chunk.flatMap((line) => {
      const logged = parseLogLine(line);
      return logged ? [`Logged '${logged.task.summary}' as done (${logged.note})`] : [];
    });
  });
  return said.length ? said.join("; ") : null;
}
