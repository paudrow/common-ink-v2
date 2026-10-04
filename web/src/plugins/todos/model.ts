// Todos as plain markdown: a checkbox line, with an optional due date and recurrence written inline.
//
//   - [ ] Pay rent due:2026-11-01 every:month
//   - [x] Water the plants due:2026-10-04 every:3days
//
// `due:` takes a date (YYYY-MM-DD). `every:` takes day, weekday, week, month or year, optionally with a
// count in front (2weeks, 3days). Checking off a recurring todo adds the next one above it.

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
 * Check a todo off, or back on. Checking off a recurring todo leaves it done and adds the next one
 * above it, due on the next date (counted from its due date, or from today if it had none).
 * Returns the new lines in place of the one line, or null if the line isn't a todo.
 */
export function toggleLine(text: string, today: string): string[] | null {
  const m = CHECKBOX.exec(text);
  if (!m) return null;
  const todo = parseTodo(text)!;
  if (todo.done) return [`${m[1]}[ ] ${m[3]}`];
  const done = `${m[1]}[x] ${m[3]}`;
  if (!todo.every) return [done];
  const next = nextDue(todo.due ?? today, todo.every);
  const rest = DUE.test(m[3]) ? m[3].replace(DUE, `$1due:${next}`) : `${m[3]} due:${next}`;
  return [`${m[1]}[ ] ${rest}`, done];
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
