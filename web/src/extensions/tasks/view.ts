// The Tasks view: the quick-add bar, then Today (what's overdue, due today or starting today), then
// every other task, in the same rows the ::tasks embed draws. Narrowed to a tag or a person, the list
// stands alone. Ticking a box here edits the note the task lives in.
import { quickAddBar, type QuickAddOptions } from "./bar.ts";
import { el, icon } from "./dom.ts";
import { choose } from "./editors.ts";
import type { Logged } from "./store.ts";
import { mountTaskList, type ListEnv } from "./list.ts";
import { redrawRows, taskRow, type RowEnv } from "./rows.ts";
import { today } from "./chips.ts";
import { todaySection, type Task } from "./tasks.ts";

const SECTIONS = [
  ["overdue", "Overdue"],
  ["due", "Due today"],
  ["starting", "Starting today"],
] as const;

/** What the view needs: a tag or person chip in it narrows the view itself. */
export type ViewEnv = Omit<ListEnv, "skip" | "empty" | "openTag" | "openPerson"> & {
  /** The note a name means (a log line's [[Note]]). */
  notePathFor(name: string): string | null;
  /** What the quick-add bar at the top needs. */
  quickAdd(): Omit<QuickAddOptions, "added" | "escape">;
};

/** The view in `root`: drawn the first time, and read again (keeping its filters) each time after. */
export class TasksView {
  private drawn = new WeakMap<HTMLElement, () => Promise<void>>();
  private filter: { tag?: string; assignee?: string } = {};
  /** The filter changed from outside (a person chip in a note): the next render draws it anew. */
  private changed = false;
  /** The quick-add bar drawn last, to let go of when the view draws anew. */
  private bar: { destroy(): void } | null = null;

  constructor(private env: ViewEnv) {}

  /** Narrow the view to one person's tasks (from a person chip's "Show …'s tasks"), the next time it draws. */
  showPerson(name: string) {
    this.filter = { assignee: name };
    this.changed = true;
  }

  async render(root: HTMLElement) {
    const reload = this.drawn.get(root);
    if (reload && !this.changed && root.querySelector(".tasks-view")) return reload();
    this.changed = false;
    this.draw(root);
  }

  private draw(root: HTMLElement) {
    const env = this.env;
    const filter = this.filter;
    const whole = !filter.tag && !filter.assignee;
    const todayHost = el("div", { class: "td-block", hidden: true });
    const host = el("div", { class: "qw-tasks" });
    const filters = el("div", { class: "tasks-filters" });
    const set = (next: { tag?: string; assignee?: string }) => {
      this.filter = next;
      this.draw(root);
    };
    const links = { openTag: (tag: string) => set({ ...filter, tag }), openPerson: (assignee: string) => set({ ...filter, assignee }) };
    const rowEnv: Omit<RowEnv, "reload"> = { ...env, ...links };

    // Today on top of the whole list; what it shows isn't listed again below it.
    let todayTasks: Task[] = [];
    let loggedToday: Logged[] = [];
    const drawToday = () => {
      const now = today();
      const sections = SECTIONS.map(([id, title]) => ({ id, title, tasks: todayTasks.filter((t) => !t.done && todaySection(t.meta, now) === id) })).filter((s) => s.tasks.length);
      const done = doneToday(now);
      todayHost.hidden = !whole || (!sections.length && !done.length);
      redrawRows(todayHost, () =>
        todayHost.replaceChildren(
          el("div", { class: "td-title" }, icon("sun", 14), "Today"),
          ...sections.map((s) =>
            el(
              "section",
              { class: `td-section is-${s.id}` },
              el("div", { class: "qt-note is-label" }, s.title, el("span", { class: "n" }, String(s.tasks.length))),
              ...s.tasks.map((t) => taskRow(t, { ...rowEnv, reload: () => void load() }, t.title)),
            ),
          ),
          ...(done.length
            ? [
                el(
                  "section",
                  { class: "td-section is-done" },
                  el("div", { class: "qt-note is-label" }, "Done today", el("span", { class: "n" }, String(done.length))),
                  ...done.map((d) => d.row()),
                ),
              ]
            : []),
        ),
      );
    };
    /**
     * Done today: the completions logged in today's daily note, in the order they were done, then the
     * plain tasks ticked today in their own notes that aren't logged too.
     */
    const doneToday = (now: string) => {
      const reload = () => void load();
      const logged = loggedToday.map((l) => {
        const t: Task = { ...l.task, path: env.notePathFor(l.note) ?? "", raw: l.line, title: l.note, line: 1, heading: null };
        const onBox = (anchor: HTMLElement) =>
          choose(anchor, `Done: ${l.task.summary}`, [
            { label: `Put it back in ${l.note}`, icon: "reset", run: () => env.store.putBack(l.line).then(reload, (e) => env.notice(e instanceof Error ? e.message : "Couldn't put it back")) },
            { label: "Only take it out of the log", icon: "close", run: () => env.store.unlog(l.line).then(reload) },
          ]);
        return { key: `${l.note}|${l.task.summary}`, row: () => taskRow(t, { ...rowEnv, reload }, l.note, { onBox }) };
      });
      const seen = new Set(logged.map((l) => l.key));
      const plain = todayTasks
        .filter((t) => t.done && t.meta.done?.slice(0, 10) === now && !seen.has(`${t.title}|${t.summary}`))
        .map((t) => ({ key: "", row: () => taskRow(t, { ...rowEnv, reload }, t.title) }));
      return [...logged, ...plain];
    };
    const tasks = async () => {
      [todayTasks, loggedToday] = await Promise.all([env.tasks(), env.store.loggedToday().catch(() => [])]);
      if (whole) drawToday();
      return todayTasks;
    };
    const empty = () =>
      el(
        "div",
        { class: "qt-blank" },
        icon("task", 20),
        el("strong", {}, "No tasks yet"),
        el("span", {}, "Any line in a note that starts with ", el("code", {}, "- [ ]"), " shows up here, so you can tick it off without opening the note."),
      );
    const list = mountTaskList(host, { ...filter, limit: "500" }, { ...rowEnv, tasks, skip: whole ? (t) => !t.done && todaySection(t.meta, today()) !== null : undefined, empty: whole ? empty : undefined });
    const load = () => list.load();

    // A tag to narrow to (the tags in use, most first), and the person it's narrowed to, if any.
    const tagSelect = el("select", { class: "qt-select tasks-tag", "aria-label": "Tag" }, el("option", { value: "" }, "All tags"));
    tagSelect.addEventListener("change", () => set({ ...filter, tag: tagSelect.value || undefined }));
    void env.store.tags().then((tags) => {
      for (const t of filter.tag && !tags.some((x) => x.toLowerCase() === filter.tag) ? [filter.tag, ...tags] : tags) tagSelect.append(el("option", { value: t.toLowerCase() }, `#${t}`));
      tagSelect.value = filter.tag ?? "";
    });
    const person = filter.assignee
      ? el("span", { class: "tasks-filter" }, icon("at", 13), filter.assignee, el("button", { type: "button", class: "tasks-filter-clear", title: "Everyone's tasks", onclick: () => set({ ...filter, assignee: undefined }) }, icon("close", 12)))
      : null;
    filters.replaceChildren(tagSelect, ...(person ? [person] : []));
    this.bar?.destroy();
    // Added: the lists read the notes again when the note saves.
    const bar = (this.bar = quickAddBar({ ...env.quickAdd(), added: () => {} }));
    root.replaceChildren(el("div", { class: "tasks-view" }, bar.root, todayHost, filters, host));
    this.drawn.set(root, load);
  }
}
