// Todos, a built-in plugin: todos drawn as checkboxes with due-date and recurrence chips, checked off
// with a click, ⌘Enter or gx (recurring ones move to their next due date), and every open todo in the
// Todos view.
import { isNote, type Change, type FilePath, type Revision } from "../../../../worker/src/files.ts";
import type { PluginContext, PluginModule } from "../../plugins.ts";
import { describeTodoEdit, localToday, parseTodo, todosIn, toggleLine, when, type Todo, type When } from "./model.ts";
import { checkboxEl, CHECKED_FOR_MS, dueChipEl, everyChipEl, todosPreview, toggleTodoAt } from "./widgets.ts";

export const todosPlugin: PluginModule = {
  activate(ctx) {
    const panel = new TodosPanel(ctx);
    ctx.commands.register(
      { id: "todos.toggle", title: "Check off todo (or uncheck it)", run: () => toggle(ctx) },
      { id: "todos.show", title: "Show todos", run: () => ctx.panels.toggle("todos") },
    );
    ctx.keybindings.add({ key: "Mod-Enter", command: "todos.toggle" });
    ctx.keybindings.vim("gx", "todos.toggle");
    ctx.panels.register({ id: "todos", title: "Todos", render: (root) => panel.render(root) });
    ctx.events.onSaved((path) => isNote(path) && ctx.panels.refresh("todos"));
    ctx.editor.extend(todosPreview(localToday));
    ctx.changes.describe(describeChange);
  },
};

/** Check off the todo under the cursor, in place. */
function toggle(ctx: PluginContext) {
  const view = ctx.workbench.focusedView();
  if (!view || view.state.readOnly) return;
  toggleTodoAt(view, view.state.selection.main.head, localToday());
}

/** What a change did to todos, for history: each line that changed by itself, if it was a todo checked off or reopened. */
export function describeChange(change: Pick<Change, "diff">): string | null {
  const said = change.diff.flatMap(({ buffer1, buffer2 }) =>
    buffer1.chunk.length === buffer2.chunk.length ? buffer1.chunk.flatMap((before, i) => describeTodoEdit(before, buffer2.chunk[i]) ?? []) : [],
  );
  return said.length ? said.join("; ") : null;
}

const GROUPS: Array<[When, string]> = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["upcoming", "Upcoming"],
  ["someday", "No date"],
];

/** Every open todo in every note, by when it's due. Notes are read again only when their revision changes. */
class TodosPanel {
  private cache = new Map<FilePath, { revision: Revision; todos: Todo[] }>();

  constructor(private ctx: PluginContext) {}

  async render(root: HTMLElement) {
    const notes = (await this.ctx.files.fetchList()).filter((d) => isNote(d.path));
    await Promise.all(
      notes.map(async (n) => {
        if (this.cache.get(n.path)?.revision === n.revision) return;
        const file = await this.ctx.files.read(n.path);
        this.cache.set(n.path, { revision: file.revision, todos: todosIn(file.text) });
      }),
    );
    const today = localToday();
    const open = notes.flatMap((n) => (this.cache.get(n.path)?.todos ?? []).filter((t) => !t.done).map((t) => ({ ...t, path: n.path })));
    const sections = GROUPS.map(([w, title]) => {
      const items = open.filter((t) => when(t, today) === w).sort((a, b) => (a.due ?? "").localeCompare(b.due ?? "") || a.path.localeCompare(b.path) || a.line - b.line);
      if (!items.length) return null;
      const list = document.createElement("ul");
      list.append(...items.map((t) => this.item(t, today)));
      const h = document.createElement("h3");
      h.textContent = `${title} (${items.length})`;
      h.dataset.when = w;
      const section = document.createElement("section");
      section.append(h, list);
      return section;
    }).filter((s) => s !== null);
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No open todos. A todo is a checkbox line: - [ ] Call the plumber due:2026-11-01";
    root.replaceChildren(...(sections.length ? sections : [empty]));
  }

  /** One open todo: its checkbox, its title (which opens it), its chips and its note. */
  private item(t: Todo & { path: FilePath }, today: string): HTMLElement {
    const box = checkboxEl(false, `Check off ${t.title || "todo"}`);
    box.tabIndex = 0;
    const check = () => void this.toggle(t, box);
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      check();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      check();
    });
    const open = document.createElement("button");
    open.className = "todo";
    open.title = "Open its note at this line";
    const title = document.createElement("span");
    title.textContent = t.title || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "meta";
    if (t.due) meta.append(dueChipEl(t.due, today));
    if (t.every) meta.append(everyChipEl(t.every));
    meta.append(this.ctx.workbench.label(t.path));
    open.append(title, meta);
    open.addEventListener("click", () => void this.ctx.workbench.open(t.path, { line: t.line }));
    const li = document.createElement("li");
    li.className = "todo-item";
    li.append(box, open);
    return li;
  }

  /** Check a todo off from the view: the same edit ⌘Enter makes, written to its note as one change by you. */
  private async toggle(t: Todo & { path: FilePath }, box: HTMLElement) {
    box.setAttribute("aria-checked", "true");
    box.textContent = "✓";
    box.classList.add("checking");
    await new Promise((r) => setTimeout(r, CHECKED_FOR_MS));
    const file = await this.ctx.files.read(t.path);
    const lines = file.text.split("\n");
    const now = parseTodo(lines[t.line] ?? "");
    // The note changed under the view: redraw it rather than check off the wrong line.
    if (now && now.title === t.title && !now.done) {
      lines[t.line] = toggleLine(lines[t.line], localToday())!;
      await this.ctx.files.write(t.path, lines.join("\n"), file.revision);
      await this.ctx.workbench.refreshFromServer([t.path]);
    }
    this.ctx.panels.refresh("todos");
  }
}
