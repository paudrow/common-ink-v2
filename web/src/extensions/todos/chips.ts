// How a task's tokens look, in the editor and in task lists: a priority flag, a date pill, a repeat
// mark, a person, a tag. The markdown keeps the tokens; these only draw them. Each chip says which
// token it is (data-field, data-value), so a click can open that token's editor.
import { avatar, el, icon } from "./dom.ts";
import { endsLabel, nextDue, parseRule, ruleLabel } from "./recurrence.ts";
import { tagsInLine } from "./tags.ts";
import { endsOf, localDate, type TaskMeta } from "./tasks.ts";

export const today = () => localDate(Date.now());

/** Day names by day, for the day they were worked out on: a long task list shows the same few dates many times. */
const dayNames = { now: "", names: new Map<string, string>() };

/** "Today", "Tomorrow", "Yesterday", "Oct 1", or "Oct 1, 2027", then the time if there is one. */
export function dayLabel(value: string, now = today()): string {
  const day = value.slice(0, 10);
  if (dayNames.now !== now) Object.assign(dayNames, { now, names: new Map() });
  let name = dayNames.names.get(day);
  if (name === undefined) {
    const at = (n: number) => localDate(new Date(`${now}T12:00:00`).getTime() + n * 86_400_000);
    const d = new Date(`${day}T12:00:00`);
    name =
      day === now ? "Today"
      : day === at(1) ? "Tomorrow"
      : day === at(-1) ? "Yesterday"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(day.slice(0, 4) === now.slice(0, 4) ? {} : { year: "numeric" }) });
    dayNames.names.set(day, name);
  }
  return value.length > 10 ? `${name} ${value.slice(11)}` : name;
}

export type ChipField = keyof Omit<TaskMeta, "tags" | "assignees"> | "assignees" | "tags";

/**
 * One token as a chip. `done` mutes a due date that would otherwise show as overdue. `next` is a
 * repeating task's date after this one, and `ends` how it stops, both shown on its repeat chip in
 * task lists ("Monthly · 5 left").
 */
export function tokenChip(field: ChipField, value: string, opts: { done?: boolean; now?: string; next?: string | null; ends?: { until: string | null; times: number | null } } = {}): HTMLElement {
  const now = opts.now ?? today();
  const chip = (cls: string, title: string, ...children: Array<Node | string>) => el("span", { class: `tk ${cls}`.trim(), title, "data-field": field, "data-value": value }, ...children);
  switch (field) {
    case "due": {
      const state = opts.done ? "" : value.slice(0, 10) < now ? " is-overdue" : value.slice(0, 10) === now ? " is-today" : "";
      return chip(`tk-due${state}`, `Due ${value}`, icon("calendar", 12), dayLabel(value, now));
    }
    case "start":
      return chip("", `Hidden until ${value}`, icon("clock", 12), `from ${dayLabel(value, now)}`);
    case "done":
      return chip("tk-muted", `Done ${value}`, icon("check", 12), dayLabel(value, now));
    case "rec": {
      const rule = parseRule(value);
      const ends = rule ? endsOf(opts.ends ?? { until: null, times: null }, rule) : null;
      const end = ends ? endsLabel(ends) : "";
      const then = opts.next ? dayLabel(opts.next, now) : null;
      const title = `${rule ? ruleLabel(rule, true) + endsLabel(ends!, true) : `Repeats ${value}`}${then ? `. After this one: ${then}` : ""}`;
      const label = (rule ? ruleLabel(rule) : value) + (end ? ` · ${end}` : "");
      return then ? chip("", title, icon("reset", 12), label, el("span", { class: "tk-next" }, `· ${then}`)) : chip("", title, icon("reset", 12), label);
    }
    // A repeat's ends, on their own (the editor draws each token): they open the repeat's editor.
    case "until":
      return chip("tk-muted", `Repeats until ${value}`, icon("reset", 12), `until ${dayLabel(value, now)}`);
    case "times":
      return chip("tk-muted", `${value} ${value === "1" ? "time" : "times"} left, this one included`, icon("reset", 12), `${value} left`);
    case "priority":
      return chip(`tk-priority is-${value}`, `${value === "high" ? "High" : "Low"} priority`, icon("flag", 12), value === "high" ? "High" : "Low");
    case "assignees":
      return chip("tk-person", `@${value}`, avatar(value, 14), value);
    case "tags":
      return chip("tk-tag", `Tasks tagged #${value}`, `#${value}`);
  }
}

/** The date after a repeating task's current due date, when the calendar says (not for `after-` rules, which wait for completion), and if it hasn't ended by then. */
export function nextOf(meta: TaskMeta): string | null {
  const rule = meta.rec ? parseRule(meta.rec) : null;
  if (!rule || rule.from !== "due" || !meta.due) return null;
  const ends = endsOf(meta, rule);
  const next = ends.times === null || ends.times > 1 ? nextDue(rule, meta.due, meta.due) : null;
  return next && (!ends.until || next.slice(0, 10) <= ends.until) ? next : null;
}

/**
 * A task's chips in one fixed order, whatever order its tokens are in: priority, due (and a start
 * still ahead), repeat, people, then `tags` sorted by name, and done last.
 */
export function metaChips(meta: TaskMeta, done: boolean, tags: string[] = [], now = today()): HTMLElement[] {
  return [
    meta.priority && tokenChip("priority", meta.priority),
    meta.due && tokenChip("due", meta.due, { done, now }),
    meta.start && meta.start.slice(0, 10) > now && tokenChip("start", meta.start, { now }),
    meta.rec && tokenChip("rec", meta.rec, { next: done ? null : nextOf(meta), ends: meta, now }),
    ...meta.assignees.map((a) => tokenChip("assignees", a)),
    ...[...tags].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((t) => tokenChip("tags", t)),
    done && meta.done && tokenChip("done", meta.done, { now }),
  ].filter((c): c is HTMLElement => !!c);
}

/** Tags a task's chips show: the ones not already in its words (those stay there, in the sentence). */
export function endTags(summary: string, tags: string[]): string[] {
  const inText = new Set(tagsInLine(summary).map((h) => h.tag));
  return tags.filter((tag) => !inText.has(tag.toLowerCase()));
}
