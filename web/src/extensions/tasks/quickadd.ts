// Quick-add: a task typed the way you'd say it, turned into a task line. Phrases for a due date,
// a start date and a repeat become tokens (see tasks.ts and recurrence.ts), and `→ [[Note]]` says
// which note it goes to. Tokens typed as tokens (`due:`, `!high`, `@jane`, `#tag`) pass through
// where they are. Every phrase it takes is reported as a span of the input, so the app can show it
// highlighted in place, and a phrase the person clicks away (`ignore`) stays words.
import { addDays, editTask, isDate, parseTask, TASK_LINE, type TaskMeta, type TaskPatch } from "./tasks.ts";
import { isInterval, nextDue, nth, parseRule } from "common-ink/recurrence";
import { tagsInLine } from "./tags.ts";

export type QuickKind = "due" | "start" | "rec" | "ends" | "target";
export interface QuickSpan {
  kind: QuickKind;
  /** Where the phrase is in the input. */
  from: number;
  to: number;
  /** What it became: `due:2026-10-01`, `rec:1st`, `[[Bills]]`. */
  token: string;
}
export interface QuickAdd {
  input: string;
  /** The task line to write. */
  line: string;
  /** The task's words: the input without the phrases that became tokens. */
  words: string;
  /** The note named with `→ [[Note]]`, or null for the default (the inbox, or today's daily note). */
  target: string | null;
  meta: TaskMeta;
  spans: QuickSpan[];
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 };

const DAY_FULL = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
// Short names ("sat", "sun", "wed") are words too, so they only count after next/this/on/by/every.
const DAY_ANY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)";
const MONTH = "(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?";
const NUM = "(?:\\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)";
const UNIT = "(?:day|week|month|year)s?";
const ORD = "(?:first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)";
const DONE = "after\\s+(?:it'?s\\s+)?(?:done|completion|completed|finished|finishing)";
// A phrase starts and ends at a word's edges, and never inside a token, a link or a path.
const B = "(?<![\\p{L}\\p{N}_:#@/.'’-])";
const E = "(?![\\p{L}\\p{N}_'’])";

const DATE = [
  "today|tonight|tomorrow|tmrw",
  "next\\s+(?:week|month|year)",
  `in\\s+${NUM}\\s+${UNIT}`,
  `(?:next|this)\\s+${DAY_ANY}`,
  DAY_FULL,
  `${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?`,
  `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?`,
  "\\d{4}-\\d{2}-\\d{2}",
].join("|");
const PREFIXED = `(?:${DATE}|${DAY_ANY})`;

const re = (src: string) => new RegExp(`${B}(?:${src})${E}`, "giu");
const DUE = re(`(?:on|by|due|before|for)\\s+${PREFIXED}|${DATE}`);
const START = re(`(?:start(?:s|ing)?(?:\\s+on)?|from)\\s+${PREFIXED}`);
// A repeat's end, read only when there's a repeat: "until dec 1", "for 6 months", "10 times".
const UNTIL = re(`until\\s+${PREFIXED}`);
const FOR = re(`for\\s+(${NUM})\\s+(${UNIT})`);
const TIMES_PHRASE = re(`(${NUM})\\s+times`);
const TARGET = /(?:→|->)\s*\[\[([^[\]\n]+)\]\]/gu;

const count = (s: string) => NUMBERS[s.toLowerCase()] ?? parseInt(s, 10);
const unitOf = (s: string) => s.toLowerCase()[0];
const dayOf = (s: string) => DAYS.indexOf(s.toLowerCase().slice(0, 3));
const monthOf = (s: string) => MONTHS.indexOf(s.toLowerCase().slice(0, 3)) + 1;

/** Repeats, most specific first; each gives a `rec:` value. */
const REPEATS: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [re(`every\\s+other\\s+(day|week|month|year)`), (m) => `2${unitOf(m[1])}`],
  [re(`(?:every\\s+(?:(${NUM})\\s+)?|(${NUM})\\s+)(${UNIT})\\s+${DONE}`), (m) => `after-${count(m[1] ?? m[2] ?? "1")}${unitOf(m[3])}`],
  [re(`every\\s+weekday`), () => "mon,tue,wed,thu,fri"],
  [re(`every\\s+weekend`), () => "sat,sun"],
  [re(`(?:every\\s+month\\s+on\\s+|monthly\\s+on\\s+|on\\s+)?the\\s+last\\s+day\\s+of\\s+(?:the|every|each)\\s+month|every\\s+last\\s+day(?:\\s+of\\s+the\\s+month)?`), () => "last-day"],
  [re(`(?:every\\s+)?(?:the\\s+)?(${ORD})\\s+(${DAY_ANY})\\s+of\\s+(?:the|every|each)\\s+month|every\\s+(${ORD})\\s+(${DAY_ANY})`), (m) => `${nth(ORDINALS[(m[1] ?? m[3]).toLowerCase()])}-${DAYS[dayOf(m[2] ?? m[4])]}`],
  [re(`(?:every\\s+month|monthly)\\s+on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?|on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(?:every|each)\\s+month|every\\s+(\\d{1,2})(?:st|nd|rd|th)`), (m) => nth(+(m[1] ?? m[2] ?? m[3]))],
  [re(`(?:every\\s+year\\s+on|yearly\\s+on|annually\\s+on|every)\\s+(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?`), (m) => `${MONTHS[monthOf(m[1]) - 1]}-${+m[2]}`],
  [re(`every\\s+(${DAY_ANY}(?:\\s*(?:,\\s*and|,|and|&)\\s*${DAY_ANY})*)`), (m) => [...new Set(m[1].toLowerCase().split(/\s*(?:,\s*and|,|and|&)\s*/).map(dayOf))].sort().map((d) => DAYS[d]).join(",")],
  [re(`every\\s+(${NUM})\\s+(${UNIT})`), (m) => (count(m[1]) === 1 ? WORDS[unitOf(m[2])] : `${count(m[1])}${unitOf(m[2])}`)],
  [re(`every\\s+(day|week|month|year)|daily|weekly|monthly|yearly|annually`), (m) => WORDS[unitOf(m[1] ?? m[0].replace(/^annually$/i, "yearly"))]],
];
const WORDS: Record<string, string> = { d: "daily", w: "weekly", m: "monthly", y: "yearly" };

/** A month's worth of days on: the same day of the month, or the month's last day if it's shorter. */
function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  const [ny, nm] = [Math.floor(index / 12), (index % 12) + 1];
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The day a date phrase means, counted from `today`; null if it names no real day. */
export function dateOf(phrase: string, today: string): string | null {
  const p = phrase.toLowerCase().replace(/^(?:on|by|due|before|for|start(?:s|ing)?(?:\s+on)?|from)\s+/, "").replace(/\s+/g, " ").trim();
  if (p === "today" || p === "tonight") return today;
  if (p === "tomorrow" || p === "tmrw") return addDays(today, 1);
  if (p === "next week") return addDays(today, 7);
  if (p === "next month") return addMonths(today, 1);
  if (p === "next year") return addMonths(today, 12);
  let m = p.match(/^in (\S+) (day|week|month|year)s?$/);
  if (m) {
    const n = count(m[1]);
    return m[2] === "day" ? addDays(today, n) : m[2] === "week" ? addDays(today, 7 * n) : addMonths(today, m[2] === "month" ? n : 12 * n);
  }
  m = p.match(/^(?:(?:next|this) )?([a-z]+)$/);
  if (m && dayOf(m[1]) >= 0) {
    // The coming one: a weekday never means today, and "next friday" is the Friday coming up.
    const now = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return addDays(today, (dayOf(m[1]) - now + 7) % 7 || 7);
  }
  if (isDate(p)) return p;
  // "oct 3", "october 3rd, 2027", "3 oct", "3rd of october"
  const monthFirst = p.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/);
  const dayFirst = p.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)\.?(?:,? (\d{4}))?$/);
  const [month, date, year] = monthFirst ? [monthFirst[1], monthFirst[2], monthFirst[3]] : dayFirst ? [dayFirst[2], dayFirst[1], dayFirst[3]] : [];
  if (!month || !date || monthOf(month) <= 0) return null;
  const md = `${String(monthOf(month)).padStart(2, "0")}-${date.padStart(2, "0")}`;
  const thisYear = +today.slice(0, 4);
  let day = `${year ?? thisYear}-${md}`;
  if (!year && day < today) day = `${thisYear + 1}-${md}`; // a date without a year is the next one
  return isDate(day) ? day : null;
}

/**
 * Read a quick-add line. `today` is the person's day (YYYY-MM-DD); `ignore` holds phrases they
 * clicked away, which stay words. A kind of token the line already has (`due:…`) isn't read from
 * words too.
 */
export function parseQuickAdd(input: string, today: string, ignore: string[] = [], opts: { targets?: boolean } = {}): QuickAdd {
  const skip = new Set(ignore.map((p) => p.toLowerCase().replace(/\s+/g, " ").trim()));
  // Where a phrase kept as words sits: nothing shorter inside it is read either ("every month" in "every month on the 1st").
  const lower = input.toLowerCase().replace(/\s/g, " ");
  const kept = [...skip].filter(Boolean).flatMap((p) => [...lower.matchAll(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g"))].map((m) => [m.index, m.index + m[0].length]));
  const typed = parseTask(`- [ ] ${input}`)!.meta;
  const spans: QuickSpan[] = [];
  const free = (from: number, to: number) => spans.every((s) => to <= s.from || from >= s.to);
  const take = (pattern: RegExp, kind: QuickKind, token: (m: RegExpExecArray) => string | null) => {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(input); m; m = pattern.exec(input)) {
      const [from, to] = [m.index, m.index + m[0].length];
      if (!free(from, to) || skip.has(m[0].toLowerCase().replace(/\s+/g, " ")) || kept.some(([f, t]) => from < t && to > f)) continue;
      const t = token(m);
      if (t === null) continue;
      spans.push({ kind, from, to, token: t });
      return t;
    }
    return null;
  };

  // `→ [[Note]]` says where the quick-add bar files it; anywhere else a task is typed, it's just words.
  const target = opts.targets === false ? null : take(TARGET, "target", (m) => `[[${m[1].trim()}]]`);
  let rec: string | null = null;
  if (!typed.rec) for (const [pattern, value] of REPEATS) if ((rec = take(pattern, "rec", (m) => (parseRule(value(m)) ? `rec:${value(m)}` : null)))) break;
  // How the repeat ends: a last day, a stretch (worked out once the first due date is known), or a count.
  const repeats = !!(rec || typed.rec);
  const until = repeats && !typed.until ? take(UNTIL, "ends", (m) => { const d = dateOf(m[0].replace(/^until\s+/i, ""), today); return d ? `until:${d}` : null; }) : null;
  let stretch: { n: number; unit: string } | null = null;
  const times = repeats && typed.times === null
    ? take(TIMES_PHRASE, "ends", (m) => `times:${count(m[1])}`) ?? take(FOR, "ends", (m) => ((stretch = { n: count(m[1]), unit: unitOf(m[2]) }), "for"))
    : null;
  const start = typed.start ? null : take(START, "start", (m) => (dateOf(m[0], today) ? `start:${dateOf(m[0], today)}` : null));
  let due = typed.due ? null : take(DUE, "due", (m) => (dateOf(m[0], today) ? `due:${dateOf(m[0], today)}` : null));

  const patch: TaskPatch = {};
  if (start) patch.start = start.slice(6);
  if (rec) patch.rec = rec.slice(4);
  if (due) patch.due = due.slice(4);
  else if (rec && !typed.due) {
    // A repeat with no date: due the first time it comes round, from the start date or today.
    const rule = parseRule(patch.rec!)!;
    const from = patch.start ?? today;
    patch.due = rule.from === "done" || isInterval(rule) ? from : (nextDue(rule, null, addDays(from, -1)) ?? from);
    due = `due:${patch.due}`;
  }
  if (until) patch.until = until.slice(6);
  if (times && times !== "for") patch.times = Number(times.slice(6));
  else if (stretch) {
    // "for 6 months": six times, for a plain every-month repeat; otherwise up to the day before 6 months from the first due date.
    const s: { n: number; unit: string } = stretch;
    const rule = parseRule(patch.rec ?? typed.rec!)!;
    const first = (patch.due ?? typed.due ?? today).slice(0, 10);
    if (isInterval(rule) && rule.interval === 1 && rule.freq[0] === s.unit) patch.times = s.n;
    else patch.until = addDays(s.unit === "d" ? addDays(first, s.n) : s.unit === "w" ? addDays(first, 7 * s.n) : addMonths(first, s.unit === "m" ? s.n : 12 * s.n), -1);
  }

  // The words: what's left once the phrases are cut, with the spacing around each cut closed up.
  let words = "";
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    words += input.slice(at, s.from);
    at = s.to;
  }
  words = (words + input.slice(at)).replace(/[ \t]{2,}/g, " ").trim();
  const line = editTask(`- [ ] ${words}`, patch);
  return {
    input,
    line,
    words,
    target: target ? target.slice(2, -2) : null,
    meta: parseTask(line)!.meta,
    spans: spans.sort((a, b) => a.from - b.from),
  };
}

/** A task's text (after its checkbox) as typed somewhere other than the quick-add bar (a card): phrases read into tokens, no `→ [[Note]]` target. */
export function typedTask(text: string, today: string, ignore: string[] = []): string {
  return parseQuickAdd(text, today, ignore, { targets: false }).line.match(TASK_LINE)![4];
}

/**
 * The patch for a task's words retyped in place (the Tasks page's inline edit): the new words, and
 * a token for each phrase read from them or token typed after them, next to the tokens the task
 * already has. A date, repeat or priority replaces its own; tags and people join the ones it has.
 * A repeat with no due date anywhere also gets its first one.
 */
export function retypeTask(line: string, words: string, today: string, ignore: string[] = []): TaskPatch {
  const q = parseQuickAdd(words, today, ignore, { targets: false });
  const had = parseTask(line)?.meta;
  const typed = parseTask(`- [ ] ${q.words}`)!; // the words, and any tokens typed at their end
  const read = new Set<string>(q.spans.map((s) => s.kind));
  const said = (field: "due" | "start" | "rec" | "until" | "times", kind: QuickKind) => read.has(kind) || typed.meta[field] !== null;
  const patch: TaskPatch = { summary: typed.summary };
  if (said("due", "due") || (read.has("rec") && !had?.due && q.meta.due)) patch.due = q.meta.due;
  if (said("start", "start")) patch.start = q.meta.start;
  if (said("rec", "rec")) patch.rec = q.meta.rec;
  if (said("until", "ends") && q.meta.until) patch.until = q.meta.until;
  if (said("times", "ends") && q.meta.times !== null) patch.times = q.meta.times;
  if (typed.meta.priority) patch.priority = typed.meta.priority;
  const inWords = new Set(tagsInLine(typed.summary).map((h) => h.tag.toLowerCase()));
  const join = (old: string[], more: string[]) => (more.some((m) => !old.includes(m)) ? [...new Set([...old, ...more])] : null);
  const tags = join(had?.tags ?? [], typed.meta.tags.filter((t) => !inWords.has(t.toLowerCase())));
  const people = join(had?.assignees ?? [], typed.meta.assignees.filter((p) => !typed.summary.includes(`@${p}`)));
  if (tags) patch.tags = tags;
  if (people) patch.assignees = people;
  return patch;
}
