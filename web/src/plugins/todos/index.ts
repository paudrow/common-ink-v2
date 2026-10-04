// Todos, a built-in plugin: check todos off with ⌘Enter (recurring ones come back with their next due
// date), see due dates at a glance in the editor, and every open todo in the Todos panel.
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isNote, type FilePath, type Revision } from "../../../../worker/src/files.ts";
import type { PluginContext, PluginModule } from "../../plugins.ts";
import { localToday, parseTodo, todosIn, toggleLine, when, type Todo, type When } from "./model.ts";

export const todosPlugin: PluginModule = {
  activate(ctx) {
    const panel = new TodosPanel(ctx);
    ctx.commands.register(
      { id: "todos.toggle", title: "Check off todo (or uncheck it)", run: () => toggle(ctx) },
      { id: "todos.show", title: "Show todos", run: () => ctx.panels.toggle("todos") },
    );
    ctx.keybindings.add({ key: "Mod-Enter", command: "todos.toggle" });
    ctx.panels.register({ id: "todos", title: "Todos", render: (root) => panel.render(root) });
    ctx.events.onSaved((path) => isNote(path) && ctx.panels.refresh("todos"));
    ctx.editor.extend(dueDates);
  },
};

/** Check off the todo under the cursor, in place. */
function toggle(ctx: PluginContext) {
  const view = ctx.workbench.focusedView();
  if (!view || view.state.readOnly) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const lines = toggleLine(line.text, localToday());
  if (!lines) return;
  const column = view.state.selection.main.head - line.from;
  const insert = lines.join("\n");
  // The cursor stays on the todo it was on: the new one, when a recurring todo adds one above.
  view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + Math.min(column, lines[0].length) } });
}

const dueMark = (w: When) => Decoration.mark({ class: `cm-todo-due cm-todo-${w}` });
const doneLine = Decoration.line({ class: "cm-todo-done" });

/** Due dates coloured by when they're due, and done todos faded. */
const dueDates = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const today = localToday();
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = view.state.doc.lineAt(pos);
            const todo = parseTodo(line.text);
            if (todo?.done) builder.add(line.from, line.from, doneLine);
            const due = /(?:^|\s)(due:\d{4}-\d{2}-\d{2})/.exec(line.text);
            if (todo && due) {
              const at = line.from + due.index + due[0].indexOf("due:");
              builder.add(at, at + due[1].length, dueMark(todo.done ? "someday" : when(todo, today)));
            }
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.theme({
    ".cm-todo-due": { fontFamily: "var(--mono)", fontSize: "0.85em" },
    ".cm-todo-overdue": { color: "#c2410c" },
    ".cm-todo-today": { color: "var(--accent)" },
    ".cm-todo-upcoming, .cm-todo-someday": { color: "var(--muted)" },
    ".cm-todo-done": { opacity: "0.55" },
  }),
];

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
      list.append(
        ...items.map((t) => {
          const button = document.createElement("button");
          button.className = "todo";
          const title = document.createElement("span");
          title.textContent = t.title || "(untitled)";
          const meta = document.createElement("span");
          meta.className = "meta";
          meta.textContent = [t.due, t.every && `every ${t.every.count > 1 ? `${t.every.count} ` : ""}${t.every.unit}${t.every.count > 1 ? "s" : ""}`, this.ctx.workbench.label(t.path)].filter(Boolean).join(" · ");
          button.append(title, meta);
          button.addEventListener("click", () => void this.ctx.workbench.open(t.path, { line: t.line }));
          const li = document.createElement("li");
          li.append(button);
          return li;
        }),
      );
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
}
