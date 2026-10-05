// Todos drawn in the editor and the Todos view: a checkbox for "- [ ]", and chips for due dates and
// recurrences ("Tomorrow", "Overdue 2d", "↻ weekly"). In the editor they're a live preview: the line
// you're on shows its raw text.
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { livePreview, type Preview } from "common-ink/live-preview";
import { dueLabel, everyLabel, parseTodo, todoParts, toggleLine, type Every } from "./model.ts";

/** How long a recurring todo shows as checked before it moves to its next date. */
export const CHECKED_FOR_MS = 450;

/** A checkbox, as the editor and the Todos view draw it. Pressing it never takes focus. */
export function checkboxEl(checked: boolean, label: string): HTMLElement {
  const box = document.createElement("span");
  box.className = "todo-box";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", String(checked));
  box.setAttribute("aria-label", label);
  box.title = checked ? "Uncheck" : "Check off";
  box.textContent = checked ? "✓" : "";
  return box;
}

/** A due date's chip: its words, coloured by when it's due. */
export function dueChipEl(due: string, today: string, done = false): HTMLElement {
  const { text, when } = dueLabel(due, today);
  const chip = document.createElement("span");
  chip.className = `todo-chip todo-${done ? "someday" : when}`;
  chip.textContent = text;
  chip.title = `due:${due}`;
  return chip;
}

export function everyChipEl(every: Every): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "todo-chip todo-every";
  chip.textContent = everyLabel(every);
  return chip;
}

/** Check the todo on the line at `pos` off (or back on), as one edit. A recurring one shows checked for a moment first. */
export function toggleTodoAt(view: EditorView, pos: number, today: string, box?: HTMLElement): void {
  const apply = () => {
    const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
    const next = toggleLine(line.text, today);
    // Only the line's text changes; the cursor stays where it is, on this line or another.
    if (next !== null && next !== line.text) view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: "input.toggle" });
  };
  const todo = parseTodo(view.state.doc.lineAt(pos).text);
  if (box && todo && !todo.done && todo.every) {
    box.setAttribute("aria-checked", "true");
    box.textContent = "✓";
    box.classList.add("checking");
    window.setTimeout(apply, CHECKED_FOR_MS);
  } else apply();
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly title: string,
    readonly today: string,
    /** The line's whole text: a recurring todo's box must redraw when only its date moves on. */
    readonly line: string,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.line === this.line && other.today === this.today;
  }
  updateDOM(dom: HTMLElement) {
    // Pressing it may have drawn it checked for a moment; draw it as the todo is now.
    dom.classList.remove("checking");
    dom.setAttribute("aria-checked", String(this.checked));
    dom.setAttribute("aria-label", this.title || "Todo");
    dom.textContent = this.checked ? "✓" : "";
    return true;
  }
  toDOM(view: EditorView) {
    const box = checkboxEl(this.checked, this.title || "Todo");
    // On press, not click, and with the default stopped: the editor keeps (or doesn't take) focus, and
    // its cursor, Vim's included, stays where it was.
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      toggleTodoAt(view, view.posAtDOM(box), this.today, box);
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class ChipWidget extends WidgetType {
  constructor(
    readonly make: () => HTMLElement,
    readonly key: string,
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.key === this.key;
  }
  toDOM(view: EditorView) {
    const chip = this.make();
    // Pressing a chip puts the cursor on its raw text, which the line then shows.
    chip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(chip) }, scrollIntoView: true });
      view.focus();
    });
    return chip;
  }
  ignoreEvent() {
    return true;
  }
}

const doneLine = Decoration.line({ class: "cm-todo-done" });
const doneText = Decoration.mark({ class: "cm-todo-done-text" });

/** What a todo line draws: its checkbox, its chips, and done todos muted and struck through. */
export function todoPreviews(text: string, lineFrom: number, today: string, chips = true): Preview[] {
  const parts = todoParts(text);
  const todo = parts && parseTodo(text);
  if (!parts || !todo) return [];
  const at = (offset: number) => lineFrom + offset;
  const out: Preview[] = [{ from: at(parts.box.from), to: at(parts.box.to), decoration: Decoration.replace({ widget: new CheckboxWidget(todo.done, todo.title, today, text) }) }];
  if (todo.done) {
    out.push({ from: at(0), to: at(0), decoration: doneLine });
    if (parts.body.to > parts.body.from) out.push({ from: at(parts.body.from), to: at(parts.body.to), decoration: doneText });
  }
  if (parts.due && chips) {
    const { date } = parts.due;
    out.push({ from: at(parts.due.from), to: at(parts.due.to), decoration: Decoration.replace({ widget: new ChipWidget(() => dueChipEl(date, today, todo.done), `due:${date}:${todo.done}:${today}`) }) });
  }
  if (parts.every && chips) {
    const { every } = parts.every;
    out.push({ from: at(parts.every.from), to: at(parts.every.to), decoration: Decoration.replace({ widget: new ChipWidget(() => everyChipEl(every), `every:${every.count}${every.unit}`) }) });
  }
  return out;
}

/**
 * The todos live preview for note editors. `today` and `chips` (the "todos.chips" setting) are asked
 * for on each redraw, so the date turns over at midnight and a settings change shows at once.
 */
export function todosPreview(today: () => string, chips: () => boolean = () => true) {
  return [livePreview((line) => todoPreviews(line.text, line.from, today(), chips())), theme];
}

// The checkbox and chips are styled in style.css, for the Todos view too.
const theme = EditorView.theme({
  ".cm-todo-done": { color: "var(--muted)" },
  ".cm-todo-done-text": { textDecoration: "line-through" },
});
