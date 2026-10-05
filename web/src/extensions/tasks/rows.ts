// One task in a list (the Tasks view, a ::tasks embed): its checkbox, its words, its chips in the fixed
// order, and its ⚙, ↗ and split buttons. Click the words to edit them in place, a chip to edit that
// token, ⌘-click (Ctrl-click off a Mac) to open the note at the line to the side. Every change goes to
// the note the task lives in.
import { IS_MAC } from "common-ink/keys";
import { dayLabel, endTags, metaChips } from "./chips.ts";
import { el, icon } from "./dom.ts";
import { openChipEditor, openTaskMenu, type ChipContext } from "./editors.ts";
import type { TaskStore } from "./store.ts";
import { tagsInLine } from "./tags.ts";
import type { Task, TaskPatch } from "./tasks.ts";

export interface RowEnv {
  store: Pick<TaskStore, "update" | "revert" | "move" | "people" | "tags" | "noteList">;
  /** `side`: in a new window to the right (⌘-click). */
  open(path: string, line: number, side?: boolean): void;
  openTag(tag: string): void;
  openPerson(name: string): void;
  /** The list reloads after a change (the task's line, or where it lives, moved). */
  reload(): void;
  /** A short message, with buttons. */
  notice(message: string, actions?: Array<{ label: string; run(): unknown }>): void;
}

const prevent = (e: Event) => e.preventDefault();
/** A click that opens to the side: ⌘ on a Mac, Ctrl elsewhere. */
const sideClick = (e: MouseEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);

/** A task's row. `where` is the muted label on the right (its heading, or its note when grouped otherwise). */
export function taskRow(t: Task, env: RowEnv, where: string | null): HTMLElement {
  const box = el("span", { class: `cm-checkbox${t.done ? " is-checked" : ""}`, role: "checkbox", tabindex: "0", "aria-checked": String(t.done), "aria-label": t.summary, title: t.done ? "Mark open" : "Mark done" });
  const words = el("span", { class: "qt-words" }, ...inline(t.summary));
  const text = el("span", { class: "qt-text", title: `${t.title}, line ${t.line}` }, words, ...metaChips(t.meta, t.done, endTags(t.summary, t.meta.tags))); // tags mid-sentence stay there
  const save = async (patch: TaskPatch) => {
    Object.assign(t, await env.store.update(t, patch)); // its new text, for the next change
    env.reload();
  };
  const move = async (to: string) => {
    await env.store.move(t, to as never);
    env.reload();
  };
  const ctx: ChipContext = {
    task: t,
    save,
    people: () => env.store.people(),
    tags: () => env.store.tags(),
    showPerson: env.openPerson,
    say: (message) => env.notice(message),
    move,
    notes: () => env.store.noteList(),
  };
  text.addEventListener("mousedown", (e) => {
    // A click on the words edits them, so let that one place the caret; chips and tags keep focus where it is.
    const target = e.target as HTMLElement;
    if (target.closest(".qt-edit")) return; // placing the caret or selecting in the open edit
    if (!target.closest(".qt-words") || sideClick(e)) prevent(e);
  });
  text.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (sideClick(e)) return env.open(t.path, t.line, true);
    const chip = target.closest<HTMLElement>(".tk[data-field]");
    const tag = chip?.dataset.field === "tags" ? chip.dataset.value!.toLowerCase() : target.closest<HTMLElement>(".tag")?.dataset.tag;
    if (tag) env.openTag(tag);
    else if (chip) openChipEditor(chip, ctx);
    else if (target.closest(".qt-words")) editWords(t, words, save, env);
  });
  const menu = el("button", { type: "button", class: "qt-act", title: "Priority, due, repeat, person, tags…", "aria-label": "Task fields", onmousedown: prevent }, icon("sliders", 13));
  menu.addEventListener("click", () => openTaskMenu(menu, ctx));
  const go = el("button", { type: "button", class: "qt-act", title: "Go to note", "aria-label": `Go to ${t.title}, line ${t.line}`, onmousedown: prevent, onclick: (e: MouseEvent) => env.open(t.path, t.line, sideClick(e)) }, icon("open", 13));
  const side = el("button", { type: "button", class: "qt-act", title: "Open to the side", "aria-label": `Open ${t.title} to the side`, onmousedown: prevent, onclick: () => env.open(t.path, t.line, true) }, icon("split", 13));
  const row = el("div", { class: `qt-row${t.done ? " is-done" : ""}` }, box, text, where ? el("span", { class: "qt-where" }, where) : null, menu, go, side);
  box.addEventListener("mousedown", (e) => {
    e.preventDefault();
    void toggle(t, row, box, env);
  });
  box.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    void toggle(t, row, box, env);
  });
  return row;
}

/** How long a task just ticked stays in its list, struck through, before a list that hides it lets it go. */
export const LINGER = 1500;
const lingerFor = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : LINGER);
/** Each list's latest redraw, held while a row in it lingers. */
const held = new Map<HTMLElement, () => void>();
/** Tasks being ticked or unticked right now: another click waits for the first. */
const busy = new WeakSet<Task>();

/**
 * Draw a list of task rows again. If a row's checkbox or button had the keyboard focus, the same
 * control on the row now in its place gets it (a task ticked off an Open list is gone, so that's the next one).
 * While a row just ticked lingers, the redraw waits for it.
 */
export function redrawRows(list: HTMLElement, draw: () => void) {
  if (list.querySelector(".qt-row.is-lingering")) return void held.set(list, () => redrawRows(list, draw));
  const rows = () => [...list.querySelectorAll<HTMLElement>(".qt-row")];
  const controls = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".cm-checkbox, .qt-act")];
  const row = rows().findIndex((r) => r.contains(document.activeElement));
  const control = row < 0 ? -1 : controls(rows()[row]).indexOf(document.activeElement as HTMLElement);
  draw();
  if (control < 0) return;
  const now = rows();
  const there = now[Math.min(row, now.length - 1)];
  if (there) controls(there)[control]?.focus({ preventScroll: true });
}

/**
 * Tick or untick: shown at once, then the list reloads with what the note says now. The row stays a
 * moment first, so a list that hides done tasks doesn't whisk away the one you just ticked, and
 * ticking one says so, with an Undo. A repeating task moves on to its next date instead of staying ticked.
 */
async function toggle(t: Task, row: HTMLElement, box: HTMLElement, env: RowEnv) {
  if (busy.has(t)) return;
  busy.add(t);
  const next = !t.done;
  show(row, box, next);
  linger(row, lingerFor());
  try {
    const was = { ...t };
    const now = await env.store.update(t, { checked: next });
    Object.assign(t, now);
    // A repeating task stays open, moved on: the message says when it's next.
    const then = !now.done && now.meta.due ? `. Next: ${dayLabel(now.meta.due)}` : "";
    if (next) env.notice(`Done: ${clip(was.summary)}${then}`, [{ label: "Undo", run: () => void undo(now, was, env) }]);
  } catch (e) {
    // The note changed underneath: the reload shows what's there now.
    env.notice(e instanceof Error ? e.message : "Couldn't change the task");
  }
  busy.delete(t);
  env.reload();
}

async function undo(now: Task, was: Task, env: RowEnv) {
  try {
    await env.store.revert(now, was);
  } catch {
    env.notice(`Couldn't put back “${clip(was.summary)}”. Open its note to change it.`);
  }
  env.reload();
}

function show(row: HTMLElement, box: HTMLElement, done: boolean) {
  row.classList.toggle("is-done", done);
  box.classList.toggle("is-checked", done);
  box.setAttribute("aria-checked", String(done));
  box.title = done ? "Mark open" : "Mark done";
}

function linger(row: HTMLElement, ms: number) {
  if (!ms) return;
  row.classList.add("is-lingering");
  setTimeout(() => {
    row.classList.remove("is-lingering");
    for (const [list, redraw] of held) {
      if (list.querySelector(".qt-row.is-lingering")) continue;
      held.delete(list);
      redraw();
    }
  }, ms);
}

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/**
 * Edit a task's words in place, its chips left as they are. Enter or leaving the field saves; Escape
 * puts the words back.
 */
function editWords(t: Task, words: HTMLElement, save: (patch: TaskPatch) => Promise<void>, env: RowEnv) {
  let done = false;
  const input = el("input", { class: "qt-input", value: t.summary, "aria-label": "Task", spellcheck: "true" });
  const edit = el("span", { class: "qt-edit", onclick: (e: Event) => e.stopPropagation() }, input);
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    edit.replaceWith(words);
    if (!keep || !text || text === t.summary) return;
    words.replaceChildren(...inline(text)); // show it now; the reload confirms it
    void save({ summary: text }).catch((e) => {
      words.replaceChildren(...inline(t.summary));
      env.notice(e instanceof Error ? e.message : "Couldn't change the task");
    });
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the page's own keys stay out of the field
    if (e.key === "Enter") (e.preventDefault(), finish(true));
    else if (e.key === "Escape") (e.preventDefault(), finish(false));
  });
  input.addEventListener("blur", () => finish(true));
  words.replaceWith(edit);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * A task's words as inline markdown, built as nodes (never HTML): `code`, **bold**, *emphasis*,
 * [[links]] and [links](…) by their names, and #tags as chips that filter.
 */
export function inline(md: string): Node[] {
  const out: Node[] = [];
  const INLINE = /`([^`]+)`|\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]|\[([^\]\n]+)\]\([^)\s]+\)|\*\*([^*\n]+)\*\*|(?<![\w*])[*_]([^*_\s][^*_\n]*?)[*_](?![\w*])/g;
  let at = 0;
  for (const m of md.matchAll(INLINE)) {
    out.push(...withTags(md.slice(at, m.index)));
    if (m[1] !== undefined) out.push(el("code", {}, m[1]));
    else if (m[2] !== undefined) out.push(el("span", { class: "qt-link" }, m[3] ?? m[2]));
    else if (m[4] !== undefined) out.push(el("span", { class: "qt-link" }, m[4]));
    else if (m[5] !== undefined) out.push(el("strong", {}, ...withTags(m[5])));
    else out.push(el("em", {}, ...withTags(m[6])));
    at = m.index + m[0].length;
  }
  out.push(...withTags(md.slice(at)));
  return out;
}

/** Plain text with its #tags as chips. */
function withTags(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const hit of tagsInLine(text)) {
    out.push(document.createTextNode(text.slice(at, hit.from - 1)), el("span", { class: "tag", "data-tag": hit.tag, title: `Tasks tagged #${hit.display}` }, `#${hit.display}`));
    at = hit.to;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out.filter((n) => n.nodeType !== Node.TEXT_NODE || n.textContent);
}
