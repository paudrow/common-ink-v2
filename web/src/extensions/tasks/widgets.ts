// Tasks drawn in note editors, on the live-preview mechanism: a checkbox for "- [ ]", each token as a
// chip where it's written (its raw text while the cursor touches it), and a done task muted and struck
// through. The cursor's task line also gets its tools at the end: a ⚙
// that opens the task's field menu, and a faint hint of the fields it doesn't have yet
// (`due · repeat · @ · # · !`), each word opening that field's editor. Phrases quick-add would read
// ("tomorrow", "every week") are underlined there; Tab right after one, or a click on one, makes them
// tokens. Every change is one transaction, so one undo takes it back.
import { completionStatus } from "@codemirror/autocomplete";
import { Prec } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import { livePreview, type Preview } from "common-ink/live-preview";
import { tokenChip, type ChipField } from "./chips.ts";
import { el, icon } from "./dom.ts";
import { convertPhrases, HINTS, isTaskLine, logged, logUndo, phrasesAt, phraseTab, taskLineEdit, taskPhrases, taskTools, taskToolsAt, unlogged, type Completion, type HintField, type TickHow } from "./edit.ts";
import { choose, openChipEditor, openFieldEditor, openTaskMenu, type ChipContext } from "./editors.ts";
import { tagsInLine } from "./tags.ts";
import { doneLines, lineTokens, parseLogLine, parseTask, TASK_LINE } from "./tasks.ts";

/** How long a repeating task shows as ticked before it moves on to its next date. */
export const CHECKED_FOR_MS = 450;

/** What the editor's task tools need from the app: the day, the chips setting, and the people and tags to offer. */
export interface TaskEnv {
  today(): string;
  /** The "tasks.chips" setting: tokens as chips, or as the text they are. */
  chips(): boolean;
  people(): Promise<string[]>;
  tags(): Promise<string[]>;
  showPerson(name: string): void;
  say(message: string): void;
  /** The path of the note this editor shows. */
  path(view: EditorView): string;
  /** How a tick in this editor is recorded: the settings, and its note. */
  how(view: EditorView): TickHow;
  /** Add a completion to the daily note's `## Done`, or take it out (its tick was undone). */
  log(c: Completion): void;
  unlog(c: Completion): void;
  /** Put a completion's task back in its note, from its line in the daily note. */
  putBack(line: string): Promise<void>;
}

/** The task on line `n` as the chip editors take it, saving through a transaction on that line. */
export function lineTaskContext(view: EditorView, n: number, env: TaskEnv): ChipContext | null {
  const line = view.state.doc.line(n);
  const task = parseTask(line.text);
  if (!task) return null;
  return {
    task: { path: env.path(view), done: task.done, meta: task.meta },
    save: async (patch) => {
      const spec = taskLineEdit(view.state, n, line.text, patch, env.today(), env.how(view));
      if (spec) view.dispatch(spec);
    },
    people: env.people,
    tags: env.tags,
    showPerson: env.showPerson,
    say: env.say,
    onClose: () => setTimeout(() => view.focus()), // after the key or click that closed it is done
  };
}

/**
 * Tick or untick the task on the line at `pos`. A repeating one shows ticked a moment, then moves on
 * to its next date (and is logged, as the settings say). A completion in a daily note's `## Done`
 * asks instead: put the task back in its note, or only take the line out of the log.
 */
export function toggleTaskAt(view: EditorView, pos: number, env: Pick<TaskEnv, "today" | "say" | "how" | "putBack">, box?: HTMLElement): boolean {
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  const task = parseTask(line.text);
  if (!task || view.state.readOnly) return false;
  const entry = task.done && parseLogLine(line.text);
  if (entry && doneLines(view.state.doc.toString()).some((d) => d.line === line.number)) {
    const remove = () => {
      const now = view.state.doc.line(line.number);
      if (now.text !== line.text) return;
      view.dispatch({ changes: { from: now.from, to: Math.min(now.to + 1, view.state.doc.length) }, userEvent: "delete.task" });
    };
    const anchor = box ?? view.dom;
    choose(anchor, `Done: ${entry.task.summary}`, [
      { label: `Put it back in ${entry.note}`, icon: "reset", run: () => env.putBack(line.text).then(remove, (e) => env.say(e instanceof Error ? e.message : "Couldn't put it back")) },
      { label: "Only take it out of the log", icon: "close", run: remove },
    ], () => setTimeout(() => view.focus()));
    return true;
  }
  const apply = () => {
    const now = view.state.doc.line(line.number);
    try {
      const spec = taskLineEdit(view.state, line.number, now.text, { checked: !task.done }, env.today(), env.how(view));
      // Only the line's text changes; the cursor stays where it is, on this line or another.
      if (spec) view.dispatch(spec);
    } catch (e) {
      env.say(e instanceof Error ? e.message : "Couldn't change the task");
    }
  };
  if (box && !task.done && task.meta.rec) {
    box.classList.add("is-checked", "is-checking");
    box.setAttribute("aria-checked", "true");
    window.setTimeout(apply, CHECKED_FOR_MS);
  } else apply();
  return true;
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly label: string,
    /** The line's whole text: a repeating task's box must redraw when only its date moves on. */
    readonly line: string,
    readonly env: TaskEnv,
  ) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.line === this.line;
  }
  updateDOM(dom: HTMLElement) {
    // Pressing it may have drawn it ticked for a moment; draw it as the task is now.
    dom.classList.remove("is-checking");
    dom.classList.toggle("is-checked", this.checked);
    dom.setAttribute("aria-checked", String(this.checked));
    dom.setAttribute("aria-label", this.label || "Task");
    dom.title = this.checked ? "Mark open" : "Mark done";
    return true;
  }
  toDOM(view: EditorView) {
    const box = el("span", { class: `cm-checkbox${this.checked ? " is-checked" : ""}`, role: "checkbox", "aria-checked": String(this.checked), "aria-label": this.label || "Task", title: this.checked ? "Mark open" : "Mark done" });
    // On press, not click, and with the default stopped: the editor keeps (or doesn't take) focus, and
    // its cursor, Vim's included, stays where it was.
    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(box), this.env, box);
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/**
 * A task token (due date, repeat, person, priority) drawn as a chip. Pressing it opens the same editor
 * as in task lists; the edit is a transaction on this line, so undo takes it back. The chip keeps the
 * press, so the cursor stays where it was.
 */
class TokenWidget extends WidgetType {
  constructor(
    readonly field: ChipField,
    readonly value: string,
    readonly done: boolean,
    readonly now: string,
    readonly env: TaskEnv,
  ) {
    super();
  }
  eq(o: TokenWidget) {
    return o.field === this.field && o.value === this.value && o.done === this.done && o.now === this.now;
  }
  toDOM(view: EditorView) {
    const chip = tokenChip(this.field, this.value, { done: this.done, now: this.now });
    chip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (view.state.readOnly) return;
      const ctx = lineTaskContext(view, view.state.doc.lineAt(view.posAtDOM(chip)).number, this.env);
      if (ctx) openChipEditor(chip, ctx);
    });
    return chip;
  }
  ignoreEvent() {
    return true;
  }
}

const doneText = Decoration.mark({ class: "cm-task-done" });
const tagMark = Decoration.mark({ class: "cm-task-tag" });

/** What a task line draws: its checkbox, its tokens as chips, and a done task's words struck through. */
export function taskPreviews(text: string, lineFrom: number, env: TaskEnv, chips = env.chips()): Preview[] {
  const m = text.match(TASK_LINE);
  const task = m && parseTask(text);
  if (!m || !task) return [];
  const indent = /^\s*/.exec(text)![0].length;
  const boxEnd = lineFrom + m[1].length + 2;
  const at = (offset: number) => lineFrom + offset;
  const now = env.today();
  // The box shows its markdown only while the cursor is on it; the rest of the line reads as it is.
  const box = { from: at(indent), to: boxEnd };
  const out: Preview[] = [{ ...box, span: box, decoration: Decoration.replace({ widget: new CheckboxWidget(task.done, task.summary, text, env) }) }];
  if (task.done && text.length > m[1].length + 2) out.push({ from: boxEnd, to: at(text.length), decoration: doneText, always: true });
  // Each token is a chip until the cursor touches it: then it's its raw text, to edit, and the rest of the line stays still.
  // Its #tags read as tags, the same with the cursor on them: only their colour changes, so nothing moves.
  for (const t of tagsInLine(text.slice(m[1].length + 2))) out.push({ from: boxEnd + t.from - 1, to: boxEnd + t.to, decoration: tagMark, always: true });
  if (chips) {
    for (const t of lineTokens(text)) {
      const token = { from: at(t.from), to: at(t.to) };
      out.push({ ...token, span: token, decoration: Decoration.replace({ widget: new TokenWidget(t.field, t.value, task.done, now, env) }) });
    }
  }
  return out;
}

class ToolsWidget extends WidgetType {
  constructor(
    readonly missing: HintField[],
    readonly env: TaskEnv,
  ) {
    super();
  }
  eq(o: ToolsWidget) {
    return o.missing.join() === this.missing.join();
  }
  toDOM(view: EditorView) {
    const button = el("button", { type: "button", class: "cm-task-gear", title: "Priority, due, repeat, person, tags… (⌘.)", "aria-label": "Task fields" }, icon("sliders", 13));
    // Each word opens its field's editor, anchored to the word: `due` the date, `repeat` the repeat…
    const words = HINTS.filter(([, f]) => this.missing.includes(f)).map(([word, field]) => el("button", { type: "button", class: "cm-hint-word", "data-field": field, title: `Add ${WORD_TITLES[field]}` }, word));
    const hint = words.length ? el("span", { class: "cm-task-hint" }, ...words.flatMap((w, i) => (i ? [" · ", w] : [w]))) : null;
    const wrap = el("span", { class: "cm-task-tools" }, button, hint);
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // the cursor stays on the line, so the tools do too
      e.stopPropagation();
      const ctx = lineTaskContext(view, view.state.doc.lineAt(view.posAtDOM(wrap)).number, this.env);
      const word = (e.target as HTMLElement).closest<HTMLElement>(".cm-hint-word");
      if (!ctx) return;
      if (word) openFieldEditor(word.dataset.field as HintField, word, "", ctx);
      else if ((e.target as HTMLElement).closest(".cm-task-gear")) openTaskMenu(button, ctx);
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

const WORD_TITLES: Record<HintField, string> = { due: "a due date", rec: "a repeat", assignees: "a person", tags: "a tag", priority: "a priority" };

/** Open the cursor's task line's ⚙ menu (⌘. from the keyboard). False if the cursor isn't on a task. */
export function openMenuAt(view: EditorView, env: TaskEnv): boolean {
  const at = taskToolsAt(view.state);
  const gear = view.dom.querySelector<HTMLElement>(".cm-task-gear");
  const ctx = at && lineTaskContext(view, at.line, env);
  if (!ctx || !gear) return false;
  openTaskMenu(gear, ctx);
  return true;
}

/** Tab right after a phrase on a task line makes the line's phrases tokens (not while a suggestion list is open), before Lists' Tab indents. */
const phraseKey = (env: TaskEnv) =>
  Prec.highest(
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          if (completionStatus(view.state) === "active") return false;
          const spec = phraseTab(view.state, env.today());
          return !!spec && (view.dispatch(spec), true);
        },
      },
    ]),
  );

/** A click on an underlined phrase makes just that one a token; a drag across it only selects. */
function phraseClick(env: TaskEnv) {
  /** The phrase a press started on, if it was underlined then. */
  let pressed: { line: number; text: string } | null = null;
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      pressed = null;
      const mark = (e.target as HTMLElement).closest?.(".cm-phrase");
      if (!mark || e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
      const pos = view.posAtDOM(mark);
      const at = phrasesAt(view.state, env.today());
      const p = at?.phrases.find((x) => pos >= x.from && pos < x.to);
      if (at && p) pressed = { line: at.line, text: view.state.sliceDoc(p.from, p.to) };
      return false;
    },
    click(_e, view) {
      const p = pressed;
      pressed = null;
      if (!p || !view.state.selection.main.empty) return false;
      const spec = convertPhrases(view.state, p.line, env.today(), p.text);
      if (spec) view.dispatch(spec);
      return false;
    },
  });
}

/** The tasks live preview, line tools and phrases for note editors. */
export function tasksPreview(env: TaskEnv) {
  return [
    livePreview((line, view) => (isTaskLine(view.state, line.from) ? taskPreviews(line.text, line.from, env) : [])),
    taskTools((missing) => new ToolsWidget(missing, env)),
    taskPhrases(env.today),
    phraseKey(env),
    phraseClick(env),
    // A tick's log line follows the tick: added with it, taken out when it's undone, back on redo.
    logUndo,
    EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) {
        for (const e of tr.effects) {
          if (e.is(logged)) env.log(e.value);
          else if (e.is(unlogged)) env.unlog(e.value);
        }
      }
    }),
  ];
}
