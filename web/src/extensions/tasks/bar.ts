// The quick-add bar: type a task the way you'd say it and press Enter. It's the task input (input.ts):
// phrases light up, the chips below show what will be written, and a click on a lit phrase keeps it as
// words. The task goes to the inbox (the "tasks.inbox" setting, or today's daily note), or the note
// named with `→ [[Note]]`; opened from a note, Tab switches it to that note.
import { el, icon } from "./dom.ts";
import { HINT, taskInput, type TaskInput } from "./input.ts";

/** Where a task from the bar goes by default: the inbox note, or today's daily note. */
export interface Inbox {
  label: string;
  path: string;
  /** It's today's daily note: the task goes under a `## Tasks` heading. */
  daily?: boolean;
}

/** Where the bar's task goes, and what to call it: the → [[Note]] in its words, else the note it was opened from (Tab), else the inbox. */
export function targetOf(named: string | null, toNote: boolean, note: string | undefined, inbox: Inbox): Target {
  if (named) return { label: named, named, path: null };
  if (toNote && note) return { label: note.replace(/\.md$/, "").split("/").pop()!, named: null, path: note };
  return { label: inbox.label, named: null, path: inbox.path, ...(inbox.daily ? { daily: true } : {}) };
}

/** Where a task goes: a note by name (`→ [[Note]]`), or by path. */
export interface Target {
  label: string;
  named: string | null;
  path: string | null;
  daily?: boolean;
}

export interface QuickAddOptions {
  /** Write the task: its words as typed, the phrases kept as words, and where it goes (a note's name, or its path). */
  add(text: string, ignore: string[], to: Target): Promise<{ path: string; line: number }>;
  /** A task was written: where it went. */
  added(r: { path: string; line: number }): void;
  /** Open a note (the "Added to …" link). */
  open(path: string, line: number): void;
  /** The default target, now. */
  inbox(): Inbox;
  /** Escape out of the bar (the floating one closes). */
  escape?(): void;
  /** The note it was opened from: Tab sends the task there instead. */
  note?: string;
  /** How the shortcut that opens it reads (⌘⇧.), for its hint. */
  shortcut?: string;
}

/** A quick-add bar; focus it with the returned `focus`. */
export function quickAddBar(opts: QuickAddOptions): { root: HTMLElement; focus(): void; destroy(): void } {
  /** What the bar last did ("Added to …"), until you type again. */
  let status: HTMLElement | null = null;
  let toNote = false;
  let input!: TaskInput; // set just below; the input draws its preview (and so the target) as it's made

  const where = () => targetOf(input?.parsed()?.target ?? null, toNote, opts.note, opts.inbox());
  const targetChip = opts.note
    ? el("button", { type: "button", class: "qa-target", title: "Where it goes (Tab switches)", onmousedown: (e: Event) => e.preventDefault(), onclick: () => toggleTarget() })
    : null;
  const drawTarget = () => targetChip?.replaceChildren(icon(toNote && !input?.parsed()?.target ? "file" : "calendar", 12), where().label);
  const toggleTarget = () => {
    if (!opts.note) return false;
    toNote = !toNote;
    input.render();
    return true;
  };

  /** A task is on its way to its note: another Enter now would add it twice. */
  let adding = false;
  const submit = async (text: string, ignore: string[]) => {
    if (!input.parsed()?.words || adding) return;
    adding = true;
    try {
      const r = await opts.add(text, ignore, where());
      input.clear();
      status = el("span", { class: "qa-done" }, icon("check", 13), "Added to ", el("button", { type: "button", class: "qa-link", onclick: () => opts.open(r.path, r.line) }, r.path.replace(/\.md$/, "")));
      input.render();
      opts.added(r);
    } catch (e) {
      input.preview.hidden = false;
      input.preview.replaceChildren(el("span", { class: "qa-error" }, e instanceof Error ? e.message : "Couldn't add the task"));
    } finally {
      adding = false;
    }
  };

  input = taskInput({
    targets: true,
    submit,
    // Esc clears what's typed, and on an empty bar leaves it (the floating one closes).
    cancel: () => (input.value() ? input.clear() : opts.escape?.()),
    tab: toggleTarget,
    where: () => (drawTarget(), where().label),
    idle: () => (drawTarget(), status ?? el("span", { class: "qa-hint" }, HINT, " · ", el("kbd", {}, "Enter"), " adds", ...(opts.shortcut ? [" · ", el("kbd", {}, opts.shortcut), " opens this anywhere"] : []))),
    typed: () => (status = null),
  });
  const root = el("div", { class: "qa" }, el("div", { class: "qa-field" }, icon("plus", 15), input.dom, targetChip), input.preview);
  return { root, focus: () => input.focus(), destroy: () => input.destroy() };
}

/** The quick-add bar floating over whatever's open. Enter adds and closes it; focus goes back where it was. */
export function openQuickAdd(opts: Omit<QuickAddOptions, "escape">) {
  if (document.querySelector(".qa-float")) return;
  const back = document.activeElement as HTMLElement | null;
  const close = () => {
    float.remove();
    setTimeout(() => bar.destroy()); // after the key that closed it is handled
    document.removeEventListener("mousedown", outside, true);
    back?.focus?.(); // back to the note (and its Vim mode) or wherever it was opened from
  };
  const bar = quickAddBar({ ...opts, added: (r) => (opts.added(r), close()), escape: close });
  const float = el("div", { class: "qa-float", role: "dialog", "aria-label": "Add a task" }, bar.root);
  const outside = (e: MouseEvent) => !float.contains(e.target as Node) && close();
  document.addEventListener("mousedown", outside, true);
  document.body.append(float);
  bar.focus();
}
