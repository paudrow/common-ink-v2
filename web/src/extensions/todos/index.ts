// Todos, a built-in extension: tasks are checkbox lines with todo.txt-style tokens (due:, start:, rec:,
// until:, times:, !high, @person, #tag). In notes, the box ticks and each token is a chip that opens
// its own editor; ⌘. opens the line's field menu, and tokens complete as you type them. The Todos view
// and the ::tasks embed list tasks from across the notes, in the same rows. Ticking a repeating task
// moves it on to its next date, on the same line.
import { isNote } from "common-ink/files";
import type { Change, FilePath } from "../../../../worker/src/files.ts";
import type { Embed, ExtensionContext, ExtensionModule } from "../../extension-api.ts";
import { today } from "./chips.ts";
import { taskCompletions } from "./complete.ts";
import { mountTaskList, type ListArgs } from "./list.ts";
import type { RowEnv } from "./rows.ts";
import { TaskStore } from "./store.ts";
import { describeTaskEdit } from "./tasks.ts";
import { TodosView } from "./view.ts";
import { openMenuAt, tasksPreview, toggleTaskAt, type TaskEnv } from "./widgets.ts";

const todos: ExtensionModule = {
  activate(ctx) {
    const store = new TaskStore(ctx);
    const rowEnv: Omit<RowEnv, "reload" | "openTag" | "openPerson"> = {
      store,
      open: (path, line, side) => void open(ctx, path as FilePath, line, side),
      notice: (message, actions) => ctx.workbench.notice(message, actions),
    };
    const view = new TodosView({ ...rowEnv, tasks: () => store.all() });
    const showPerson = (name: string) => {
      view.showPerson(name);
      ctx.views.show("todos");
    };
    const env: TaskEnv = {
      today,
      chips: () => ctx.settings.get<boolean>("todos.chips") !== false,
      people: () => store.people(),
      tags: () => store.tags(),
      showPerson,
      say: (message) => ctx.workbench.notice(message),
      path: () => ctx.workbench.focusedPath() ?? "",
    };

    ctx.commands.register("todos.toggle", () => {
      const view = ctx.editor.focused();
      return !!view && toggleTaskAt(view, view.state.selection.main.head, env);
    });
    ctx.commands.register("todos.menu", () => {
      const view = ctx.editor.focused();
      return !!view && openMenuAt(view, env);
    });
    ctx.commands.register("todos.show", () => ctx.views.toggle("todos"));
    ctx.views.register("todos", { render: (root) => view.render(root) });
    ctx.editor.extend([tasksPreview(env), taskCompletions(env)]);
    ctx.changes.describe(describeChange);

    // ::tasks{folder=Projects tag=work due<=today}: a list of tasks in a note, redrawn as notes change.
    const lists = new Map<HTMLElement, { load(): Promise<void>; set(args: ListArgs): void }>();
    ctx.embeds.register("tasks", {
      render(el: HTMLElement, embed: Embed) {
        const host = document.createElement("div");
        host.className = "qw-tasks is-embed";
        el.replaceChildren(host);
        // A tag or person chip in an embed narrows the Todos view, which has room for it.
        lists.set(el, mountTaskList(host, embed.args, { ...rowEnv, tasks: () => store.all(), openTag: () => ctx.views.show("todos"), openPerson: showPerson }));
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
        ctx.views.refresh("todos");
        for (const [el, list] of lists) el.isConnected ? void list.load() : lists.delete(el);
      }, 150);
    });
  },
};

export default todos;

/** Open a task's note at its line (1-based): here, or in a new window to the right. */
async function open(ctx: ExtensionContext, path: FilePath, line: number, side?: boolean) {
  if (side) await ctx.workbench.split("right", path);
  await ctx.workbench.open(path, { line: Math.max(0, line - 1) });
}

/** What a change did to tasks, for history: each line that changed by itself, if it was a task ticked, reopened or moved on to its next date. */
export function describeChange(change: Pick<Change, "diff">): string | null {
  const said = change.diff.flatMap(({ buffer1, buffer2 }) =>
    buffer1.chunk.length === buffer2.chunk.length ? buffer1.chunk.flatMap((before, i) => describeTaskEdit(before, buffer2.chunk[i]) ?? []) : [],
  );
  return said.length ? said.join("; ") : null;
}
