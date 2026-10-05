// Todos as plain markdown: a checkbox line, with an optional due date and recurrence written inline.
//
//   - [ ] Pay rent due:2026-11-01 every:month
//   - [x] Water the plants due:2026-10-04 every:3days
//
// `due:` takes a date (YYYY-MM-DD). `every:` takes day, weekday, week, month or year, optionally with a
// count in front (2weeks, 3days). Checking off a recurring todo moves it to its next due date, in place.

export type Unit = "day" | "weekday" | "week" | "month" | "year";

export interface Every {
  count: number;
  unit: Unit;
}

export interface Todo {
  /** 0-based line number in its note. */
  line: number;
  done: boolean;
  /** The text without the checkbox, due date or recurrence. */
  title: string;
  due: string | null;
  every: Every | null;
}

const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s?(.*)$/;
const DUE = /(^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const EVERY = /(^|\s)every:(\d*)(days?|weekdays?|weeks?|months?|years?)(?=\s|$)/;

export function parseEvery(text: string): Every | null {
  const m = EVERY.exec(text);
  if (!m) return null;
  const unit = m[3].replace(/s$/, "") as Unit;
  return { count: m[2] ? Math.max(1, Number(m[2])) : 1, unit };
}

/** The todo on a line, or null if the line isn't a checkbox. */
export function parseTodo(text: string, line = 0): Todo | null {
  const m = CHECKBOX.exec(text);
  if (!m) return null;
  const rest = m[3];
  const due = DUE.exec(rest)?.[2] ?? null;
  const title = rest.replace(DUE, "$1").replace(EVERY, "$1").replace(/\s+/g, " ").trim();
  return { line, done: m[2] !== " ", title, due: due && isDate(due) ? due : null, every: parseEvery(rest) };
}

function isDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fromDate = (d: Date) => d.toISOString().slice(0, 10);

/** The next due date after `due` for a recurrence. Months keep the day, or the month's last day if it's shorter. */
export function nextDue(due: string, every: Every): string {
  const d = toDate(due);
  if (every.unit === "day") d.setUTCDate(d.getUTCDate() + every.count);
  else if (every.unit === "week") d.setUTCDate(d.getUTCDate() + 7 * every.count);
  else if (every.unit === "weekday") {
    for (let n = 0; n < every.count; ) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
    }
  } else {
    const months = every.unit === "month" ? every.count : 12 * every.count;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return fromDate(d);
}

/**
 * Check a todo off, or back on. A recurring todo stays open and moves to its next due date (counted
 * from its due date, or from today if it had none): the same line, so nothing piles up. History keeps
 * the completion, as the change from one due date to the next.
 * Returns the line's new text, or null if the line isn't a todo.
 */
export function toggleLine(text: string, today: string): string | null {
  const m = CHECKBOX.exec(text);
  if (!m) return null;
  const todo = parseTodo(text)!;
  if (todo.done) return `${m[1]}[ ] ${m[3]}`;
  if (!todo.every) return `${m[1]}[x] ${m[3]}`;
  const next = nextDue(todo.due ?? today, todo.every);
  return `${m[1]}[ ] ${DUE.test(m[3]) ? m[3].replace(DUE, `$1due:${next}`) : `${m[3]} due:${next}`}`;
}

/** Where a todo line's parts are, as offsets in the line: the list marker and box, and the due and every tokens. */
export interface TodoParts {
  /** From the list marker to the box's closing bracket: "- [ ]". */
  box: { from: number; to: number };
  /** The text after the box. */
  body: { from: number; to: number };
  due: { from: number; to: number; date: string } | null;
  every: { from: number; to: number; every: Every } | null;
}

export function todoParts(text: string): TodoParts | null {
  const m = CHECKBOX.exec(text);
  if (!m) return null;
  const indent = /^\s*/.exec(text)![0].length;
  const boxEnd = m[1].length + 3;
  const bodyFrom = text.length - m[3].length;
  const token = (re: RegExp) => {
    const t = re.exec(m[3]);
    return t ? { from: bodyFrom + t.index + t[1].length, to: bodyFrom + t.index + t[0].length, match: t } : null;
  };
  const due = token(DUE);
  const every = token(EVERY);
  return {
    box: { from: indent, to: boxEnd },
    body: { from: bodyFrom, to: text.length },
    due: due && isDate(due.match[2]) ? { from: due.from, to: due.to, date: due.match[2] } : null,
    every: every ? { from: every.from, to: every.to, every: parseEvery(every.match[0])! } : null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayCount = (s: string) => Math.round(toDate(s).getTime() / 86_400_000);

/** A date as a person says it, from today: "Today", "Tomorrow", "Fri" this week, "Oct 12", or "Overdue 2d". */
export function dueLabel(due: string, today: string): { text: string; when: When } {
  const days = dayCount(due) - dayCount(today);
  if (days < 0) return { text: `Overdue ${-days}d`, when: "overdue" };
  if (days === 0) return { text: "Today", when: "today" };
  if (days === 1) return { text: "Tomorrow", when: "upcoming" };
  const d = toDate(due);
  if (days < 7) return { text: DAYS[d.getUTCDay()], when: "upcoming" };
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return { text: due.slice(0, 4) === today.slice(0, 4) ? date : `${date}, ${due.slice(0, 4)}`, when: "upcoming" };
}

/** A date in a few words, without reference to today: "Oct 6". */
export const shortDate = (due: string) => `${MONTHS[toDate(due).getUTCMonth()]} ${toDate(due).getUTCDate()}`;

/** A recurrence as a person says it: "↻ weekly", "↻ weekdays", "↻ every 3 days". */
export function everyLabel(e: Every): string {
  const once: Record<Unit, string> = { day: "daily", weekday: "weekdays", week: "weekly", month: "monthly", year: "yearly" };
  return `↻ ${e.count === 1 ? once[e.unit] : `every ${e.count} ${e.unit}s`}`;
}

/** What a change did to todos, from its lines before and after: "Completed 'Water the plants' (due Oct 6)". Null if nothing. */
export function describeTodoEdit(before: string, after: string): string | null {
  const a = parseTodo(before);
  const b = parseTodo(after);
  if (!a || !b || a.title !== b.title) return null;
  const name = `'${a.title}'`;
  if (!a.done && b.done) return `Completed ${name}`;
  if (a.done && !b.done) return `Reopened ${name}`;
  // A recurring todo's due date moving on by exactly its recurrence is it being checked off. Moved by hand to another date, it isn't.
  const advanced = a.every && b.due && (a.due ? b.due === nextDue(a.due, a.every) : true);
  if (!a.done && !b.done && advanced) return `Completed ${name}${a.due ? ` (due ${shortDate(a.due)})` : ""}`;
  return null;
}

export function todosIn(text: string): Todo[] {
  return text.split("\n").flatMap((line, i) => parseTodo(line, i) ?? []);
}

export type When = "overdue" | "today" | "upcoming" | "someday";

export function when(todo: Todo, today: string): When {
  if (!todo.due) return "someday";
  return todo.due < today ? "overdue" : todo.due === today ? "today" : "upcoming";
}

/** Today as YYYY-MM-DD where you are. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
