// A list of tasks from across the notes (or a folder, a note, a tag, a person, a due date), grouped by
// note or by due date, priority, tag or person: the ::tasks embed, and the list under Today in the
// Tasks view. Ticking one, or changing its details, edits the note it lives in.
import { el, icon } from "./dom.ts";
import { taskRow, redrawRows, type RowEnv } from "./rows.ts";
import { normalizeTag, tagMatches } from "./tags.ts";
import { addDays, dueFilter, type Task } from "./tasks.ts";
import { today } from "./chips.ts";

type Show = "open" | "done" | "all";
type Group = "note" | "due" | "priority" | "tag" | "person";
type Sort = "note" | "due" | "priority";
const GROUPS: Record<Group, string> = { note: "By note", due: "By due date", priority: "By priority", tag: "By tag", person: "By person" };
const SORTS: Record<Sort, string> = { note: "Note order", due: "Due first", priority: "Priority first" };
const PRIORITY = { high: 0, none: 1, low: 2 };
const prevent = (e: Event) => e.preventDefault();

/** What a list shows: an embed's arguments, or the view's filters. */
export interface ListArgs {
  folder?: string;
  note?: string;
  tag?: string;
  assignee?: string;
  due?: string;
  group?: string;
  sort?: string;
  status?: string;
  limit?: string;
}

export interface ListEnv extends Omit<RowEnv, "reload"> {
  /** Every task, as the store has them now. */
  tasks(): Promise<Task[]>;
  /** Leave these out (the view's Today block already shows them). */
  skip?(t: Task): boolean;
  /** What to show when there are no tasks at all. */
  empty?(): HTMLElement;
}

/** Where a task goes when grouped `by`: one group, or one per tag or person. `rank` orders the groups. */
function groupsOf(t: Task, by: Group, now: string): Array<{ key: string; label: string; rank: string }> {
  const m = t.meta;
  switch (by) {
    case "note":
      return [{ key: t.path, label: t.title, rank: "" }];
    case "due": {
      const d = m.due?.slice(0, 10);
      if (!d) return [{ key: "none", label: "No due date", rank: "4" }];
      if (d < now) return [{ key: "overdue", label: "Overdue", rank: "0" }];
      if (d === now) return [{ key: "today", label: "Today", rank: "1" }];
      return d <= addDays(now, 7) ? [{ key: "week", label: "Next 7 days", rank: "2" }] : [{ key: "later", label: "Later", rank: "3" }];
    }
    case "priority":
      return [{ key: m.priority ?? "none", label: m.priority === "high" ? "High priority" : m.priority === "low" ? "Low priority" : "No priority", rank: String(PRIORITY[m.priority ?? "none"]) }];
    case "tag":
      return m.tags.length ? m.tags.map((tag) => ({ key: tag.toLowerCase(), label: `#${tag}`, rank: tag.toLowerCase() })) : [{ key: "", label: "No tag", rank: "￿" }];
    case "person":
      return m.assignees.length ? m.assignees.map((a) => ({ key: a.toLowerCase(), label: `@${a}`, rank: a.toLowerCase() })) : [{ key: "", label: "Unassigned", rank: "￿" }];
  }
}

const SORTERS: Record<Sort, (a: Task, b: Task) => number> = {
  note: () => 0,
  due: (a, b) => (a.meta.due ?? "~").localeCompare(b.meta.due ?? "~"),
  priority: (a, b) => PRIORITY[a.meta.priority ?? "none"] - PRIORITY[b.meta.priority ?? "none"] || (a.meta.due ?? "~").localeCompare(b.meta.due ?? "~"),
};

/** The tasks `args` asks for, from all of them; or why it can't say (a due filter it can't read). */
export function selectTasks(all: Task[], args: ListArgs, now: string): Task[] | string {
  const folder = args.folder?.trim().replace(/^\/+|\/+$/g, "");
  const note = args.note?.trim().replace(/\.md$/, "").toLowerCase();
  const tag = args.tag ? normalizeTag(args.tag) : null;
  const person = args.assignee?.trim().replace(/^@/, "").toLowerCase();
  const due = args.due?.trim() ? dueFilter(args.due, now) : null;
  if (args.due?.trim() && !due) return `"${args.due}" isn't a due filter: try <=today, tomorrow or >=2026-10-01`;
  return all.filter(
    (t) =>
      (!folder || t.path.startsWith(`${folder}/`)) &&
      (!note || t.path.replace(/\.md$/, "").toLowerCase() === note || t.title.toLowerCase() === note) &&
      (!tag || t.meta.tags.some((x) => tagMatches(x.toLowerCase(), tag))) &&
      (!person || t.meta.assignees.some((a) => a.toLowerCase() === person)) &&
      (!due || due(t.meta.due)),
  );
}

/** Mount a task list into `body`. `load()` reads the notes again; `set()` takes new arguments. */
export function mountTaskList(body: HTMLElement, first: ListArgs, env: ListEnv): { load(): Promise<void>; set(args: ListArgs): void } {
  let args = first;
  let show: Show = "open";
  let group: Group = "note";
  let sort: Sort = "note";
  const fromArgs = () => {
    show = (["open", "done", "all"] as const).find((s) => s === args.status) ?? "open";
    group = Object.hasOwn(GROUPS, args.group ?? "") ? (args.group as Group) : "note";
    sort = Object.hasOwn(SORTS, args.sort ?? "") ? (args.sort as Sort) : "note";
  };
  fromArgs();
  let all: Task[] = [];
  /** Tasks were found, counting the ones `skip` leaves out. */
  let found = false;
  let problem = "";
  let expanded = false;
  let loaded = false;

  const summary = el("div", { class: "qt-summary" });
  const bar = el("span");
  const seg = el("div", { class: "seg qt-seg", role: "group", "aria-label": "Show" });
  const select = <T extends string>(label: string, options: Record<T, string>, value: () => T, set: (v: T) => void) => {
    const s = el("select", { class: "qt-select", "aria-label": label, onmousedown: (e: Event) => e.stopPropagation() }, ...Object.entries(options).map(([k, text]) => el("option", { value: k }, text as string)));
    s.value = value();
    s.addEventListener("change", () => (set(s.value as T), render()));
    return s;
  };
  const groupSel = select("Group", GROUPS, () => group, (v) => (group = v));
  const sortSel = select("Sort", SORTS, () => sort, (v) => (sort = v));
  const list = el("div", { class: "qt-list" });
  const top = el("div", { class: "qt-top" }, summary, el("span", { class: "spacer" }), groupSel, sortSel, seg);
  const progress = el("div", { class: "qt-progress" }, bar);
  body.replaceChildren(top, progress, list);

  async function load() {
    try {
      const picked = selectTasks(await env.tasks(), args, today());
      if (typeof picked === "string") [all, problem, found] = [[], picked, false];
      else [all, problem, found] = [env.skip ? picked.filter((x) => !env.skip!(x)) : picked, "", picked.length > 0];
    } catch (e) {
      [all, problem] = [[], e instanceof Error ? e.message : "Couldn't read the tasks"];
    }
    loaded = true;
    render();
  }

  function render() {
    const now = today();
    const limit = Number(args.limit) || 50;
    const done = all.filter((t) => t.done).length;
    summary.textContent = all.length ? `${done} of ${all.length} done` : "No tasks yet";
    const blank = !found && !problem && !!env.empty;
    top.hidden = progress.hidden = blank;
    bar.style.width = `${all.length ? (done / all.length) * 100 : 0}%`;
    groupSel.value = group;
    sortSel.value = sort;
    seg.replaceChildren(
      ...(["open", "done", "all"] as Show[]).map((s) =>
        el("button", { type: "button", class: s === show ? "is-on" : "", "aria-pressed": String(s === show), onmousedown: prevent, onclick: () => ((show = s), render()) }, s[0].toUpperCase() + s.slice(1)),
      ),
    );
    // Open tasks that start later stay out of the way until then; All shows them.
    const later = (t: Task) => !!t.meta.start && t.meta.start.slice(0, 10) > now;
    const order = new Map(all.map((t, i) => [t, i]));
    const visible = all.filter((t) => (show === "all" || (show === "done") === t.done) && !(show === "open" && later(t))).sort((a, b) => SORTERS[sort](a, b) || order.get(a)! - order.get(b)!);
    const shown = expanded ? visible : visible.slice(0, limit);
    const groups = new Map<string, { label: string; rank: string; tasks: Task[] }>();
    for (const t of shown) {
      for (const g of groupsOf(t, group, now)) {
        if (!groups.has(g.key)) groups.set(g.key, { label: g.label, rank: g.rank, tasks: [] });
        groups.get(g.key)!.tasks.push(t);
      }
    }
    const ordered = group === "note" ? [...groups] : [...groups].sort(([, a], [, b]) => a.rank.localeCompare(b.rank));
    const row = (t: Task) => taskRow(t, { ...env, reload: () => void load() }, group === "note" ? (t.heading && t.heading !== t.title ? t.heading : null) : t.title);
    redrawRows(list, () =>
      list.replaceChildren(
        ...(!loaded
          ? [el("div", { class: "qt-empty" }, "Gathering tasks…")]
          : problem
            ? [el("div", { class: "qt-empty is-problem" }, problem)]
            : shown.length
              ? ordered.map(([key, g]) =>
                  el(
                    "div",
                    { class: "qt-group" },
                    group === "note"
                      ? el("button", { type: "button", class: "qt-note", onmousedown: prevent, onclick: () => env.open(key, 1) }, icon("file", 13), g.label)
                      : el("div", { class: "qt-note is-label" }, g.label, el("span", { class: "n" }, String(g.tasks.length))),
                    ...g.tasks.map(row),
                  ),
                )
              : [blank ? env.empty!() : el("div", { class: "qt-empty" }, show === "open" && all.length ? "All done." : "Nothing here.")]),
        ...(visible.length > shown.length ? [el("button", { type: "button", class: "qt-more", onmousedown: prevent, onclick: () => ((expanded = true), render()) }, `Show ${visible.length - shown.length} more`)] : []),
      ),
    );
  }

  render();
  void load();
  return {
    load,
    set(next) {
      args = next;
      fromArgs();
      void load();
    },
  };
}
