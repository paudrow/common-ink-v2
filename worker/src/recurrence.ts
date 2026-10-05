// How a task or an event repeats: the `rec:` token or an event's RRULE, read into an RFC 5545
// recurrence rule, and the date math for the next due date or an event's days. It's all calendar days
// counted in UTC (a date never moves with a time zone or a daylight-saving change); an event puts its
// time of day on each day in its own time zone (worker/src/calendar.ts).
//
//   rec:weekly  rec:2w  rec:mon,thu  rec:2w-mon,thu  rec:6th  rec:last-day  rec:1st-tue,3rd-tue
//   rec:last-fri  rec:mar-1  rec:1st-mon-mar  rec:day-50  rec:after-1m  rec:RRULE:FREQ=…;BYDAY=…
//
// By default the next date follows the calendar from the current due date (a bill due on the 6th is
// next due on the 6th, however early it's paid); `after-` counts from the day it was done instead.

export type Freq = "day" | "week" | "month" | "year";

export interface Rule {
  freq: Freq;
  interval: number;
  /** "due": the next date follows the rule from the current due date. "done": a gap after completion. */
  from: "due" | "done";
  /** Weekdays (0 = Monday … 6 = Sunday), each with an ordinal in its month or year (1st, -1 = last), or 0 for every one. */
  byDay: Array<{ n: number; day: number }>;
  /** Days of the month; negative counts from the end (-1 = the last day). */
  byMonthDay: number[];
  /** Months, 1 = January. */
  byMonth: number[];
  /** Days of the year; negative counts from the end. */
  byYearDay: number[];
  /** An RRULE's BYSETPOS: which of each period's dates count (1st, -1 = last). */
  bySetPos?: number[];
  /** An RRULE's WKST: the day weeks start on (0 = Monday), for rules every few weeks. */
  weekStart?: number;
  /** An RRULE's COUNT: how many times it's left to happen (read like a task's `times:`). */
  count?: number;
  /** An RRULE's UNTIL, as a day: no occurrence after it. */
  until?: string;
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const RFC_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WORDS: Record<Freq, string> = { day: "daily", week: "weekly", month: "monthly", year: "yearly" };
const UNIT: Record<string, Freq> = { d: "day", w: "week", m: "month", y: "year" };
const RFC_FREQ: Record<string, Freq> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
const ORDINAL = /^(1st|2nd|3rd|4th|5th|last)$/;

const blank = (freq: Freq, interval = 1, from: Rule["from"] = "due"): Rule => ({ freq, interval, from, byDay: [], byMonthDay: [], byMonth: [], byYearDay: [] });
/** A plain gap (every N days, weeks…) rather than a calendar rule. */
export const isInterval = (r: Rule) => !r.byDay.length && !r.byMonthDay.length && !r.byMonth.length && !r.byYearDay.length;
const ordinalOf = (s: string) => (s === "last" ? -1 : parseInt(s, 10));
export const nth = (n: number) => (n === -1 ? "last" : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`);

/** A `rec:` value as a rule, or null if it isn't one. */
export function parseRule(raw: string): Rule | null {
  const t = raw.trim();
  if (/^rrule:/i.test(t)) return parseRRule(t.slice(6));
  let s = t.toLowerCase();
  const done = s.startsWith("after-");
  if (done) s = s.slice(6);
  const word = (Object.keys(WORDS) as Freq[]).find((f) => WORDS[f] === s);
  if (word) return blank(word, 1, done ? "done" : "due");
  const gap = s.match(/^(\+)?([1-9]\d{0,2})([dwmy])$/);
  if (gap && !(done && gap[1])) return blank(UNIT[gap[3]], +gap[2], done ? "done" : "due");
  if (done) return null; // `after-` only takes a gap
  const weekly = s.match(/^(?:([1-9]\d?)w-)?([a-z]{3}(?:,[a-z]{3})*)$/);
  if (weekly && weekly[2].split(",").every((d) => DAYS.includes(d))) {
    return { ...blank("week", weekly[1] ? +weekly[1] : 1), byDay: unique(weekly[2].split(",").map((d) => ({ n: 0, day: DAYS.indexOf(d) }))) };
  }
  const items = s.split(",");
  if (items.every((x) => x === "last-day" || /^\d{1,2}(st|nd|rd|th)$/.test(x))) {
    const days = items.map((x) => (x === "last-day" ? -1 : parseInt(x, 10)));
    return days.every((d) => d === -1 || (d >= 1 && d <= 31)) ? { ...blank("month"), byMonthDay: [...new Set(days)] } : null;
  }
  const ords = items.map((x) => x.split("-"));
  if (ords.every((p) => p.length === 2 && ORDINAL.test(p[0]) && DAYS.includes(p[1]))) {
    return { ...blank("month"), byDay: unique(ords.map(([o, d]) => ({ n: ordinalOf(o), day: DAYS.indexOf(d) }))) };
  }
  const date = s.match(/^([a-z]{3})-(\d{1,2})$/);
  if (date && MONTHS.includes(date[1])) {
    const m = MONTHS.indexOf(date[1]) + 1;
    const d = +date[2];
    return d >= 1 && d <= daysIn(2024, m) ? { ...blank("year"), byMonth: [m], byMonthDay: [d] } : null; // 2024 is a leap year: feb-29 is allowed
  }
  const nthOfMonth = s.split("-");
  if (nthOfMonth.length === 3 && ORDINAL.test(nthOfMonth[0]) && DAYS.includes(nthOfMonth[1]) && MONTHS.includes(nthOfMonth[2])) {
    return { ...blank("year"), byMonth: [MONTHS.indexOf(nthOfMonth[2]) + 1], byDay: [{ n: ordinalOf(nthOfMonth[0]), day: DAYS.indexOf(nthOfMonth[1]) }] };
  }
  const yearDay = s.match(/^day-(\d{1,3})$/);
  if (yearDay && +yearDay[1] >= 1 && +yearDay[1] <= 366) return { ...blank("year"), byYearDay: [+yearDay[1]] };
  return null;
}

/** An RRULE's parts (FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, BYYEARDAY, BYSETPOS, WKST, COUNT, UNTIL), or null if it has anything else. */
function parseRRule(src: string): Rule | null {
  const parts = new Map<string, string>();
  for (const p of src.split(";")) {
    const [k, v] = p.split("=");
    if (!k || v === undefined || parts.has(k.toUpperCase())) return null;
    parts.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = RFC_FREQ[parts.get("FREQ") ?? ""];
  if (!freq) return null;
  const rule = blank(freq);
  const list = (v: string, min: number, max: number) => {
    const ns = v.split(",").map(Number);
    return ns.every((n) => Number.isInteger(n) && n !== 0 && n >= min && n <= max) ? ns : null;
  };
  for (const [k, v] of parts) {
    if (k === "FREQ") continue;
    if (k === "INTERVAL") {
      if (!/^[1-9]\d{0,2}$/.test(v)) return null;
      rule.interval = +v;
    } else if (k === "COUNT") {
      if (!/^[1-9]\d{0,3}$/.test(v)) return null;
      rule.count = +v;
    } else if (k === "UNTIL") {
      // A day, or a day and a time (the day is what counts for tasks).
      const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?$/);
      if (!m || valid(+m[1], +m[2], +m[3]) === null) return null;
      rule.until = `${m[1]}-${m[2]}-${m[3]}`;
    } else if (k === "BYDAY") {
      const days = v.split(",").map((x) => x.match(/^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/));
      if (days.some((m) => !m)) return null;
      rule.byDay = unique(days.map((m) => ({ n: m![1] ? +m![1] : 0, day: RFC_DAYS.indexOf(m![2]) })));
    } else if (k === "WKST") {
      if (!RFC_DAYS.includes(v)) return null;
      rule.weekStart = RFC_DAYS.indexOf(v);
    } else {
      const range = { BYMONTHDAY: [-31, 31], BYMONTH: [1, 12], BYYEARDAY: [-366, 366], BYSETPOS: [-366, 366] }[k];
      const ns = range && list(v, range[0], range[1]);
      if (!ns) return null;
      rule[k === "BYMONTHDAY" ? "byMonthDay" : k === "BYMONTH" ? "byMonth" : k === "BYSETPOS" ? "bySetPos" : "byYearDay"] = [...new Set(ns)];
    }
  }
  return rule;
}

function unique(days: Rule["byDay"]): Rule["byDay"] {
  return days.filter((d, i) => days.findIndex((o) => o.n === d.n && o.day === d.day) === i);
}

/** What's wrong with a `rec:` value, or null if it's a rule. */
export function ruleProblem(raw: string): string | null {
  if (parseRule(raw)) return null;
  if (/^after-/i.test(raw.trim())) return `"after-" repeats a gap after it's done (after-1m, after-10d), not a calendar rule`;
  return `"${raw}" isn't a repeat: try weekly, 2w, mon,thu, 6th, last-fri, mar-1, after-1m or RRULE:FREQ=…`;
}

/** A rule as the shortest `rec:` value that says it. */
export function formatRule(r: Rule): string {
  if (r.count || r.until || r.bySetPos || r.weekStart !== undefined) return toRRule(r); // only an RRULE says these
  if (isInterval(r)) {
    const gap = `${r.interval}${r.freq[0]}`;
    return r.from === "done" ? `after-${gap}` : r.interval === 1 ? WORDS[r.freq] : gap;
  }
  const only = (...keys: Array<keyof Rule>) =>
    (["byDay", "byMonthDay", "byMonth", "byYearDay"] as const).every((k) => keys.includes(k) === (r[k] as unknown[]).length > 0);
  const day = (d: Rule["byDay"][number]) => `${nth(d.n)}-${DAYS[d.day]}`;
  if (r.freq === "week" && only("byDay") && r.byDay.every((d) => d.n === 0)) {
    const days = [...r.byDay].sort((a, b) => a.day - b.day).map((d) => DAYS[d.day]).join(",");
    return r.interval === 1 ? days : `${r.interval}w-${days}`;
  }
  if (r.interval === 1 && r.freq === "month") {
    if (only("byMonthDay") && r.byMonthDay.every((d) => d > 0 || d === -1)) return r.byMonthDay.map((d) => (d === -1 ? "last-day" : nth(d))).join(",");
    if (only("byDay") && r.byDay.every((d) => (d.n >= 1 && d.n <= 5) || d.n === -1)) return r.byDay.map(day).join(",");
  }
  if (r.interval === 1 && r.freq === "year") {
    if (only("byMonth", "byMonthDay") && r.byMonth.length === 1 && r.byMonthDay.length === 1 && r.byMonthDay[0] > 0) return `${MONTHS[r.byMonth[0] - 1]}-${r.byMonthDay[0]}`;
    if (only("byMonth", "byDay") && r.byMonth.length === 1 && r.byDay.length === 1 && ((r.byDay[0].n >= 1 && r.byDay[0].n <= 5) || r.byDay[0].n === -1)) {
      return `${day(r.byDay[0])}-${MONTHS[r.byMonth[0] - 1]}`;
    }
    if (only("byYearDay") && r.byYearDay.length === 1 && r.byYearDay[0] > 0) return `day-${r.byYearDay[0]}`;
  }
  return toRRule(r);
}

export function toRRule(r: Rule): string {
  const freq = Object.keys(RFC_FREQ).find((k) => RFC_FREQ[k] === r.freq)!;
  const parts = [`FREQ=${freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byDay.length) parts.push(`BYDAY=${r.byDay.map((d) => `${d.n || ""}${RFC_DAYS[d.day]}`).join(",")}`);
  if (r.byMonthDay.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.byMonth.length) parts.push(`BYMONTH=${r.byMonth.join(",")}`);
  if (r.byYearDay.length) parts.push(`BYYEARDAY=${r.byYearDay.join(",")}`);
  if (r.bySetPos) parts.push(`BYSETPOS=${r.bySetPos.join(",")}`);
  if (r.weekStart !== undefined) parts.push(`WKST=${RFC_DAYS[r.weekStart]}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}`);
  return `RRULE:${parts.join(";")}`;
}

// ------------------------------------------------------------------ labels

const SHORT_UNIT: Record<Freq, string> = { day: "days", week: "wks", month: "mos", year: "yrs" };
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const ampList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} & ${xs.at(-1)}`);

/** What a rule does: short for a chip ("1st & 3rd Tue"), or long for the editor ("Every month on the 1st and 3rd Tuesday"). */
export function ruleLabel(r: Rule, long = false): string {
  if (r.bySetPos) {
    const which = r.bySetPos.map(nth);
    return `${ruleLabel({ ...r, bySetPos: undefined }, long)}${long ? `, the ${andList(which)} of them` : ` (${which.join(", ")})`}`;
  }
  const every = r.interval === 1 ? (long ? `Every ${r.freq}` : WORDS[r.freq][0].toUpperCase() + WORDS[r.freq].slice(1)) : `Every ${r.interval} ${r.freq}s`;
  if (isInterval(r)) {
    if (r.from === "due") return every;
    const gap = r.interval === 1 ? (long ? `A ${r.freq}` : WORDS[r.freq][0].toUpperCase() + WORDS[r.freq].slice(1)) : `${r.interval} ${r.freq}s`;
    return long ? `${gap} after it's done` : `${gap} after done`;
  }
  const days = r.byDay.every((d) => d.n === 0);
  const sameN = r.byDay.every((d) => d.n === r.byDay[0]?.n);
  const dayPart = (full: boolean) => {
    const name = (d: number) => (full ? DAY_NAMES[d] : DAY_NAMES[d].slice(0, 3));
    if (days) return (full ? andList : (xs: string[]) => xs.join(", "))(r.byDay.map((d) => name(d.day)));
    if (sameN && r.byDay.length > 1) return `${nth(r.byDay[0].n)} ${(full ? andList : ampList)(r.byDay.map((d) => name(d.day)))}`;
    const byDay = r.byDay.every((d) => d.day === r.byDay[0].day) && r.byDay.length > 1;
    if (byDay) return `${(full ? andList : ampList)(r.byDay.map((d) => nth(d.n)))} ${name(r.byDay[0].day)}`;
    return (full ? andList : ampList)(r.byDay.map((d) => `${nth(d.n)} ${name(d.day)}`));
  };
  const monthDays = (full: boolean) => (full ? andList : ampList)(r.byMonthDay.map((d) => (d === -1 ? (full ? "last day" : "Last day") : d < 0 ? `${nth(-d)} from last` : nth(d))));
  const months = (full: boolean) => andList(r.byMonth.map((m) => (full ? MONTH_NAMES[m - 1] : MONTH_NAMES[m - 1].slice(0, 3))));
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  if (!long) {
    const prefix = r.interval > 1 ? `Every ${r.interval} ${SHORT_UNIT[r.freq]}: ` : "";
    let body: string;
    if (r.byYearDay.length) body = `Day ${r.byYearDay.join(", ")}`;
    else if (r.byMonth.length && r.byMonthDay.length) body = `${months(false)} ${r.byMonthDay.join(", ")}`;
    else if (r.byMonth.length && r.byDay.length) body = `${cap(dayPart(false))} of ${months(false)}`;
    else if (r.byMonthDay.length) body = monthDays(false);
    else body = cap(dayPart(false));
    return prefix + body;
  }
  if (r.byYearDay.length) return `${every} on day ${andList(r.byYearDay.map(String))}`;
  if (r.byMonth.length && r.byMonthDay.length) return `${every} on ${months(true)} ${andList(r.byMonthDay.map(String))}`;
  if (r.byMonth.length && r.byDay.length) return `${every} on the ${dayPart(true)} of ${months(true)}`;
  if (r.byMonthDay.length) return `${every} on the ${monthDays(true)}`;
  return `${every} on ${days ? "" : "the "}${dayPart(true)}`;
}

// ------------------------------------------------------------------ dates

/** Calendar days since 1970-01-01. */
const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;
const partsOf = (n: number) => {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const fromIso = (s: string) => dayNumber(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
const toIso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const weekday = (n: number) => (new Date(n * 86_400_000).getUTCDay() + 6) % 7;
const daysIn = (y: number, m: number) => partsOf(dayNumber(y, m + 1, 0)).d;
/** A real date, or null for one like Feb 30 (RFC 5545 skips those). */
const valid = (y: number, m: number, d: number) => (d >= 1 && d <= daysIn(y, m) ? dayNumber(y, m, d) : null);

/** The nth (or, negative, nth from last; 0: every) `day` of the week between first and last. */
function weekdaysBetween(first: number, last: number, n: number, day: number): number[] {
  const all: number[] = [];
  for (let x = first + ((day - weekday(first) + 7) % 7); x <= last; x += 7) all.push(x);
  if (n === 0) return all;
  const pick = n > 0 ? all[n - 1] : all[all.length + n];
  return pick === undefined ? [] : [pick];
}

/** Every date the rule gives in the `k`th period after the anchor's (period = interval × freq), in order. */
function period(r: Rule, anchor: number, k: number): number[] {
  const all = [...new Set(periodDates(r, anchor, k))].sort((x, y) => x - y);
  if (!r.bySetPos) return all;
  return [...new Set(r.bySetPos.map((n) => all.at(n > 0 ? n - 1 : n)).filter((x): x is number => x !== undefined))].sort((x, y) => x - y);
}

function periodDates(r: Rule, anchor: number, k: number): number[] {
  const a = partsOf(anchor);
  const monthFilter = (xs: number[]) => (r.byMonth.length ? xs.filter((x) => r.byMonth.includes(partsOf(x).m)) : xs);
  if (r.freq === "day") {
    const x = anchor + k * r.interval;
    const ok = (!r.byDay.length || r.byDay.some((d) => d.day === weekday(x))) && (!r.byMonthDay.length || r.byMonthDay.includes(partsOf(x).d));
    return ok ? monthFilter([x]) : [];
  }
  if (r.freq === "week") {
    const weekStart = r.weekStart ?? 0;
    const start = anchor - ((weekday(anchor) - weekStart + 7) % 7) + 7 * k * r.interval;
    return monthFilter((r.byDay.length ? r.byDay.map((d) => d.day) : [weekday(anchor)]).map((d) => start + ((d - weekStart + 7) % 7)));
  }
  if (r.freq === "month") {
    const index = a.y * 12 + (a.m - 1) + k * r.interval;
    const [y, m] = [Math.floor(index / 12), (index % 12) + 1];
    return monthFilter(inMonth(r, y, m, a.d));
  }
  const y = a.y + k * r.interval;
  if (r.byYearDay.length) {
    const len = dayNumber(y + 1, 1, 1) - dayNumber(y, 1, 1);
    return monthFilter(r.byYearDay.filter((n) => Math.abs(n) <= len).map((n) => (n > 0 ? dayNumber(y, 1, n) : dayNumber(y + 1, 1, 1) + n)));
  }
  if (!r.byMonth.length && r.byDay.length) return r.byDay.flatMap((d) => weekdaysBetween(dayNumber(y, 1, 1), dayNumber(y, 12, 31), d.n, d.day));
  return (r.byMonth.length ? r.byMonth : [a.m]).flatMap((m) => inMonth(r, y, m, a.d));
}

/** The rule's dates in one month: its days of the month and/or its weekdays (both: where they agree), else the anchor's day. */
function inMonth(r: Rule, y: number, m: number, anchorDay: number): number[] {
  const first = dayNumber(y, m, 1);
  const last = first + daysIn(y, m) - 1;
  const byMonthDay = r.byMonthDay.map((d) => (d > 0 ? valid(y, m, d) : daysIn(y, m) + d + 1 >= 1 ? last + d + 1 : null)).filter((x): x is number => x !== null);
  const byDay = r.byDay.flatMap((d) => weekdaysBetween(first, last, d.n, d.day));
  if (r.byMonthDay.length && r.byDay.length) return byMonthDay.filter((x) => byDay.includes(x));
  if (r.byMonthDay.length) return byMonthDay;
  if (r.byDay.length) return byDay;
  const d = valid(y, m, anchorDay);
  return d === null ? [] : [d];
}

/** How many periods to look through before giving up (a rule like "every Feb 30" never happens). */
const HORIZON: Record<Freq, number> = { day: 4000, week: 600, month: 1300, year: 420 };

/** The first date the rule gives strictly after `after`, counting periods from `anchor`. Null if there's none in sight. */
function nextAfter(r: Rule, anchor: number, after: number): number | null {
  for (let k = 0; k < HORIZON[r.freq]; k++) {
    const hit = period(r, anchor, k).sort((x, y) => x - y).find((x) => x > after);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * The next due date for a task repeating by `r`: from its current due date (the next one strictly
 * after it) or, for `after-` rules, a gap after the day it was done. A task with no due date counts
 * from the day it was done. Keeps a due date's time of day. Null if the rule never happens again.
 */
export function nextDue(r: Rule, due: string | null, done: string): string | null {
  const time = due && due.length > 10 ? due.slice(10) : "";
  if (r.from === "done") return addGap(fromIso(done), r) + time;
  const anchor = fromIso(due ?? done);
  const next = nextAfter(r, anchor, anchor);
  return next === null ? null : toIso(next) + time;
}

/** A gap after a day. A month after the 31st is the next month's last day, if it's shorter. */
function addGap(from: number, r: Rule): string {
  if (r.freq === "day" || r.freq === "week") return toIso(from + r.interval * (r.freq === "week" ? 7 : 1));
  const { y, m, d } = partsOf(from);
  const index = y * 12 + (m - 1) + r.interval * (r.freq === "year" ? 12 : 1);
  const [ny, nm] = [Math.floor(index / 12), (index % 12) + 1];
  return toIso(dayNumber(ny, nm, Math.min(d, daysIn(ny, nm))));
}

/** The next `count` dates after `from`, each one's successor from it (what the editor previews). */
export function occurrences(r: Rule, from: string, count: number): string[] {
  const out: string[] = [];
  let at = from;
  for (let i = 0; i < count; i++) {
    const next = nextDue(r, at, at);
    if (!next) break;
    out.push(next);
    at = next;
  }
  return out;
}

/**
 * The days a rule gives, from `first` (the series' own first day, which always counts) through
 * `last`, in order. An RRULE's COUNT counts from `first`, and nothing comes after its UNTIL.
 */
export function ruleDays(r: Rule, first: string, last: string): string[] {
  const anchor = fromIso(first);
  const end = Math.min(fromIso(last), r.until ? fromIso(r.until) : Infinity);
  const out: number[] = [anchor];
  // A rule that stops giving days (every Feb 30) is given up on a horizon after its last one.
  for (let k = 0, hit = 0; out.at(-1)! <= end && (!r.count || out.length < r.count) && k - hit <= HORIZON[r.freq]; k++) {
    const days = period(r, anchor, k).filter((x) => x > out.at(-1)!).sort((x, y) => x - y);
    if (days.length) hit = k;
    for (const x of days) if (!r.count || out.length < r.count) out.push(x);
  }
  return out.filter((x) => x <= end).map(toIso);
}

/** Days from one date to another. */
export const daysBetween = (from: string, to: string) => fromIso(to) - fromIso(from);
/** A date moved by some days. */
export const shiftDate = (date: string, days: number) => toIso(fromIso(date) + days) + date.slice(10);

/** A `rec:` value for a chip: what it does ("1st & 3rd Tue"), or the value as written if it isn't a rule. */
export function recLabel(value: string): string {
  const r = parseRule(value);
  return r ? ruleLabel(r) : value;
}

/** How a repeat ends, for its chip ("5 left", "until Jun 30, 2027") or the editor's summary (", 5 more times"). "" for no end. */
export function endsLabel(ends: { until: string | null; times: number | null }, long = false): string {
  // The chip's is short ("Jun 30"); the summary's says the year too ("June 30, 2027").
  const day = (d: string, month: "short" | "long") => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month, day: "numeric", ...(month === "long" ? { year: "numeric" } : {}), timeZone: "UTC" });
  if (long) {
    const parts = [
      ends.times === null ? "" : ends.times === 1 ? "this is the last time" : `${ends.times} more times`,
      ends.until ? `until ${day(ends.until, "long")}` : "",
    ].filter(Boolean);
    return parts.length ? `, ${parts.join(", ")}` : "";
  }
  return [ends.times === null ? "" : `${ends.times} left`, ends.until ? `until ${day(ends.until, "short")}` : ""].filter(Boolean).join(" · ");
}
