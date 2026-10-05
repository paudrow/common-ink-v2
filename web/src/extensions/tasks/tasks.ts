// Tasks: a markdown checkbox line, plus optional todo.txt-style tokens anywhere in its text:
//   - [ ] Send invoice to Acme due:2026-10-01 rec:monthly #work/clients @jane !high
// The line stays the source of truth. This reads the tokens and rewrites one at a time in place, so
// an edit never touches the rest of the line.
import { daysBetween, formatRule, nextDue, parseRule, ruleProblem, shiftDate, type Rule } from "./recurrence.ts";
import { cleanTag, headingText, normalizeTag, tagsInLine, withoutCodeOrLinks } from "./tags.ts";

export const TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;

export type Priority = "high" | "low";
export interface TaskMeta {
  /** YYYY-MM-DD, or YYYY-MM-DDTHH:MM. */
  due: string | null;
  /** Hidden until this day (`start:` or `scheduled:`). */
  start: string | null;
  /** When it was ticked. */
  done: string | null;
  /** How it repeats, as written (`rec:monthly`, `rec:1st-tue`): see recurrence.ts. */
  rec: string | null;
  /** A repeat's last day (`until:`): no occurrence after it. */
  until: string | null;
  /** How many times it's left to happen, this one included (`times:`); each tick counts one down. */
  times: number | null;
  /** When a repeating task was last done (`last:`): each tick that moves it on sets it. */
  last: string | null;
  priority: Priority | null;
  assignees: string[];
  tags: string[];
}
export interface ParsedTask {
  done: boolean;
  /** Everything after the checkbox. */
  text: string;
  /** The text without the run of tokens at its end. */
  summary: string;
  meta: TaskMeta;
}
/**
 * Fields to change: a value sets it, null or [] clears it. `checked` ticks or unticks the box, and
 * `summary` replaces the task's words (everything before its trailing tokens).
 */
export type TaskPatch = Partial<TaskMeta> & { checked?: boolean; summary?: string };

type Field = "due" | "start" | "done" | "rec" | "until" | "times" | "last" | "priority" | "assignees" | "tags";
/** One token in a task's text; `from`/`to` are its columns there. `key` is how it's written (`scheduled` for a start). */
interface Token {
  field: Field;
  key: string;
  value: string;
  from: number;
  to: number;
}

const PERSON = "[\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)*";
/** A person ends where the word does, so `@jane,` and `@jane.` count and `@jane's` doesn't. */
const WORD = new RegExp(`(?<!\\S)(due|start|scheduled|done|rec|until|times|last):(\\S+)|(?<!\\S)!(high|low)(?!\\S)|(?<!\\S)@(${PERSON})(?=$|[\\s,.;:!?)\\]])`, "giu");
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d)?$/;

const TIMES = /^[1-9]\d{0,3}$/;
/** A real calendar day with no time (for `until:`). */
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && isDate(s);

/** A real calendar day (2026-04-31 isn't), optionally with a time. */
export const isDate = (s: string) => {
  const m = s.match(DATE);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

/** The day `ms` falls on here, as YYYY-MM-DD. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  for (const m of withoutCodeOrLinks(text).matchAll(WORD)) {
    const at = { from: m.index, to: m.index + m[0].length };
    if (m[1]) {
      const key = m[1].toLowerCase();
      const value = m[2];
      if (!(key === "rec" ? parseRule(value) : key === "times" ? TIMES.test(value) : key === "until" ? isDay(value) : isDate(value))) continue;
      out.push({ field: key === "scheduled" ? "start" : (key as Field), key, value, ...at });
    } else if (m[3]) out.push({ field: "priority", key: "!", value: m[3].toLowerCase(), ...at });
    else out.push({ field: "assignees", key: "@", value: m[4], ...at });
  }
  for (const t of tagsInLine(text)) {
    let to = t.to;
    while (text[to] === "/") to++; // `#work/` is the tag work: its slash goes with it
    out.push({ field: "tags", key: "#", value: t.display, from: t.from - 1, to });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** A task line's tokens other than tags (those have chips of their own), with their columns in the line. */
export function lineTokens(line: string): Array<{ field: Exclude<Field, "tags">; value: string; from: number; to: number }> {
  const m = line.match(TASK_LINE);
  if (!m) return [];
  const at = line.length - m[4].length;
  return tokensOf(m[4]).flatMap((t) => (t.field === "tags" ? [] : [{ field: t.field, value: t.value, from: t.from + at, to: t.to + at }]));
}

export function parseTask(line: string): ParsedTask | null {
  const m = line.match(TASK_LINE);
  if (!m) return null;
  const text = m[4];
  const tokens = tokensOf(text);
  const end = trailing(text, tokens)[0]?.from ?? text.trimEnd().length;
  const first = (f: Field) => tokens.find((t) => t.field === f)?.value ?? null;
  const all = (f: Field) => tidy(f, tokens.filter((t) => t.field === f).map((t) => t.value));
  return {
    done: m[2] !== " ",
    text,
    summary: text.slice(0, end).trimEnd(),
    meta: { due: first("due"), start: first("start"), done: first("done"), rec: first("rec"), until: first("until"), times: first("times") === null ? null : Number(first("times")), last: first("last"), priority: first("priority") as Priority | null, assignees: all("assignees"), tags: all("tags") },
  };
}

/** The run of tokens at the end of a task's text (only whitespace between them), in order. */
function trailing(text: string, tokens: Token[]): Token[] {
  const run: Token[] = [];
  let end = text.trimEnd().length;
  for (const t of [...tokens].reverse()) {
    if (t.to !== end) break;
    run.unshift(t);
    end = text.slice(0, t.from).trimEnd().length;
  }
  return run;
}

/** The order tokens are shown in, and the place a new one goes: priority, due, start, repeat (and its ends), when it was last done, people, tags, done. */
const RANK: Record<Field, number> = { priority: 0, due: 1, start: 2, rec: 3, until: 4, times: 5, last: 6, assignees: 7, tags: 8, done: 9 };

/** What's wrong with a patch that couldn't be written back as tokens, or null if nothing is. */
export function patchProblem(patch: TaskPatch): string | null {
  if (patch.summary !== undefined && /[\r\n]/.test(patch.summary)) return "A task's text is one line";
  for (const f of ["due", "start", "done", "last"] as const) {
    const v = patch[f];
    if (v !== undefined && v !== null && !isDate(v)) return `"${f}" must be a date like 2026-10-01 or 2026-10-01T09:30, not "${v}"`;
  }
  const rec = patch.rec ? ruleProblem(patch.rec) : null;
  if (rec) return rec;
  if (patch.until !== undefined && patch.until !== null && !isDay(patch.until)) return `"until" must be a date like 2026-10-01, not "${patch.until}"`;
  if (patch.times !== undefined && patch.times !== null && !TIMES.test(String(patch.times))) return `"times" must be a whole number of repeats left, 1 or more`;
  if (patch.priority !== undefined && patch.priority !== null && patch.priority !== "high" && patch.priority !== "low") return `"priority" must be high or low`;
  const person = (patch.assignees ?? []).find((a) => !new RegExp(`^@?${PERSON}$`, "u").test(a.trim()));
  if (person !== undefined) return `"${person}" isn't a person: use a name like jane or jane.doe, without the @`;
  const tag = (patch.tags ?? []).find((t) => !normalizeTag(t));
  if (tag !== undefined) return `"${tag}" isn't a tag: use letters, numbers, - and _, nested with /`;
  return null;
}

const write = (field: Field, value: string, key?: string) =>
  field === "priority" ? `!${value}` : field === "assignees" ? `@${value}` : field === "tags" ? `#${value}` : `${key ?? field}:${value}`;
const same = (field: Field, a: string, b: string) => (field === "tags" ? normalizeTag(a) === normalizeTag(b) : a.toLowerCase() === b.toLowerCase());

/** List values the way tokens hold them (tags tidied, people without the @), each once, first spelling kept. */
function tidy(field: Field, values: string[]): string[] {
  const clean = values.map((v) => (field === "tags" ? (cleanTag(v) ?? v.trim()) : field === "assignees" ? v.trim().replace(/^@/, "") : v.trim())).filter(Boolean);
  return clean.filter((v, i) => clean.findIndex((o) => same(field, o, v)) === i);
}

/** How many spaces and tabs come just before `at` (a loop: /[ \t]*$/ is quadratic on a long run). */
function blanksBefore(text: string, at: number): number {
  let i = at;
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
  return at - i;
}

/**
 * Apply a patch to a task line. A token whose value stays is left as written; a changed value (or
 * a person swapped for another) is replaced where it stands; a cleared one is cut out with the
 * whitespace before it; a new one goes into the tokens at the end of the line at its place in RANK
 * order. Not a task line: returned as is.
 */
export function editTask(line: string, patch: TaskPatch): string {
  const m = line.match(TASK_LINE);
  if (!m) return line;
  let text = m[4];
  if (patch.summary !== undefined) {
    // The words end where the trailing run of tokens starts; that run, and the spacing before it, stay.
    const end = trailing(text, tokensOf(text))[0]?.from ?? text.trimEnd().length;
    const words = patch.summary.trim();
    let rest = text.slice(text.slice(0, end).trimEnd().length);
    if (!words) rest = rest.trimStart();
    text = words + (words && rest && !/^\s/.test(rest) ? " " : "") + rest;
  }
  for (const field of Object.keys(RANK) as Field[]) {
    if (!(field in patch)) continue;
    const v = patch[field];
    const want = tidy(field, Array.isArray(v) ? v : v !== null && v !== undefined && v !== "" ? [String(v)] : []);
    const have = tokensOf(text).filter((t) => t.field === field);
    // A single value changed in place keeps its spot in the sentence (and `scheduled:` stays `scheduled:`).
    if (!Array.isArray(v) && want.length && have.length) {
      const t = have[0];
      if (!same(field, t.value, want[0])) text = text.slice(0, t.from) + write(field, want[0], t.key) + text.slice(t.to);
      continue;
    }
    const kept = new Set<Token>();
    for (const w of want) {
      const hit = have.find((t) => !kept.has(t) && same(field, t.value, w));
      if (hit) kept.add(hit);
    }
    const gone = have.filter((t) => !kept.has(t));
    const fresh = want.filter((w) => ![...kept].some((t) => same(field, t.value, w)));
    // A value swapped for another (a different person) takes the old one's place in the sentence.
    const swaps = Math.min(gone.length, fresh.length);
    for (let i = gone.length - 1; i >= 0; i--) {
      const t = gone[i];
      if (i < swaps) {
        text = text.slice(0, t.from) + write(field, fresh[i], t.key) + text.slice(t.to);
        continue;
      }
      const before = blanksBefore(text, t.from);
      const after = before ? 0 : text.slice(t.to).match(/^[ \t]*/)![0].length;
      text = text.slice(0, t.from - before) + text.slice(t.to + after);
    }
    for (const w of fresh.slice(swaps)) text = insertToken(text, field, write(field, w));
  }
  const box = patch.checked === undefined || patch.checked === (m[2] !== " ") ? m[2] : patch.checked ? "x" : " ";
  return `${m[1]}${box}${m[3]}${text}`;
}

/**
 * Apply a patch to a task line, with what ticking means. Ticking stamps `done:` with `today` and
 * unticking takes it off, unless the patch sets it. Ticking a repeating task doesn't tick it: it
 * stays open on the same line and moves on to its next date (its due and start dates, and one fewer
 * `times:`), with `last:` saying when it was done, so nothing piles up. Its last time, it's ticked like
 * any other.
 */
export function editTaskLine(line: string, patch: TaskPatch, today: string): string {
  return completeTask(line, undefined, patch, today, { mode: "none", note: "" }).lines[0];
}

/** Where a completion is recorded: the daily note's `## Done` (and the task moves on), a ticked copy left in the note (v1's way), or only history. */
export type LogMode = "daily" | "inline" | "none";

/**
 * Tick or untick the task on `line` (with the line below it, for v1's way of unticking), as
 * `mode` says: the lines that replace it (and the line below, if `replaced` is 2), and the line
 * to add to the daily note's `## Done`, if any. A repeating task moves on to its next date; with
 * "inline", it's ticked where it is and its next occurrence goes right below, as v1 did, and
 * unticking it straight after takes that back. A plain task (or a repeat's last time) is ticked
 * with `done:`, and logged too only with `logPlain`.
 */
export function completeTask(line: string, below: string | undefined, patch: TaskPatch, today: string, opts: { mode: LogMode; logPlain?: boolean; note: string }): { lines: string[]; replaced: 1 | 2; log: string | null } {
  const was = parseTask(line);
  if (!was || patch.checked === undefined || patch.checked === was.done) return { lines: [was ? editTask(line, patch) : line], replaced: 1, log: null };
  if (!patch.checked) {
    const out = editTask(line, "done" in patch ? patch : { ...patch, done: null });
    const takeBack = opts.mode === "inline" && !!was.meta.done && below !== undefined && below === nextOccurrence(out, was.meta.done);
    return { lines: [out], replaced: takeBack ? 2 : 1, log: null };
  }
  const day = patch.done ?? today;
  const next = following(was.meta, day);
  if (next && opts.mode === "inline") {
    const ticked = editTask(line, { ...patch, done: day });
    return { lines: [ticked, nextOccurrence(ticked, day)!], replaced: 1, log: null };
  }
  if (next) {
    // It moves on, and says when it was done: `last:`, rewritten in place each time.
    const { checked: _, done: __, ...rest } = patch;
    return { lines: [editTask(line, { ...rest, ...next.patch, last: day })], replaced: 1, log: opts.mode === "daily" ? logLine(was, day, opts.note) : null };
  }
  return { lines: [editTask(line, { ...patch, done: day })], replaced: 1, log: opts.mode === "daily" && opts.logPlain ? logLine(was, day, opts.note) : null };
}

/**
 * The task that follows a repeating one done on `done` (v1's way of ticking): the same line,
 * unticked, due on the rule's next date, with its start moved by as many days and one fewer
 * `times:` left. Null if it doesn't repeat, or never again.
 */
export function nextOccurrence(line: string, done: string): string | null {
  const task = parseTask(line);
  const next = task && following(task.meta, done);
  return next ? editTask(line, { checked: false, done: null, ...next.patch }) : null;
}

/**
 * The line a completion leaves under `## Done` in the daily note: the task's words, its people and
 * tags, the day, and its note, `- [x] Water the plants done:2026-10-05 ([[Chores]])`. Not its
 * dates or repeat: it records that it was done, not what comes next.
 */
export function logLine(task: ParsedTask, day: string, note: string): string {
  return `${editTask(`- [x] ${task.summary}`, { assignees: task.meta.assignees, tags: task.meta.tags, done: day })} ([[${note}]])`;
}

const LOG_NOTE = /^(.*\S)\s+\(\[\[([^[\]\n]+)\]\]\)\s*$/;

/** A `## Done` line read back: the task as logged, and the name of the note it was done in. Null if it isn't one. */
export function parseLogLine(line: string): { task: ParsedTask; note: string } | null {
  const m = line.match(LOG_NOTE);
  const task = m && parseTask(m[1]);
  return m && task ? { task, note: m[2] } : null;
}

/** The lines of a note's `## Done` section that are completions, with their line numbers (1-based). */
export function doneLines(content: string): Array<{ line: number; text: string }> {
  const lines = content.split("\n");
  const out: Array<{ line: number; text: string }> = [];
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (level && h[1].length <= level) break;
      if (!level && headingText(h[2]).toLowerCase() === "done") level = h[1].length;
      continue;
    }
    if (level && parseLogLine(lines[i])) out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}

/** A daily note's text with a completion added at the end of its `## Done` (made if it has none). */
export const withDone = (content: string, line: string) => withSectionAdded(content, [line], "Done", true).content;

/** A daily note's text without a completion line in its `## Done` (the last one that matches), or null if it isn't there. */
export function withoutDone(content: string, line: string): string | null {
  const at = doneLines(content).filter((d) => d.text === line).at(-1);
  if (!at) return null;
  const lines = content.split("\n");
  lines.splice(at.line - 1, 1);
  return lines.join("\n");
}

/**
 * Put a repeating task that moved on back to the day it was done (`day`): its due date that day,
 * its start moved by as many days, one more `times:` (or COUNT) left, and `last:` the completion
 * before it (`before`, or none). Used to take back a completion from the log when how the line was
 * before isn't known; null for a task that isn't a repeating one with a due date.
 */
export function backTo(line: string, day: string, before: string | null = null): string | null {
  const task = parseTask(line);
  if (!task?.meta.rec || !task.meta.due) return null;
  const rule = parseRule(task.meta.rec);
  const time = task.meta.due.slice(10);
  const shift = daysBetween(task.meta.due.slice(0, 10), day);
  const patch: TaskPatch = { due: day + time, last: before };
  if (task.meta.start) patch.start = shiftDate(task.meta.start, shift);
  if (task.meta.times !== null) patch.times = task.meta.times + 1;
  else if (rule?.count) patch.rec = formatRule({ ...rule, count: rule.count + 1 });
  return editTask(line, patch);
}

/**
 * Where a repeat ends: the earlier of its `until:` and its rule's UNTIL, and its `times:` (else the
 * rule's COUNT), the occurrences left with this one included. Null for no end.
 */
export function endsOf(meta: Pick<TaskMeta, "until" | "times">, rule: Rule): { until: string | null; times: number | null } {
  const untils = [meta.until, rule.until].filter((u): u is string => !!u).sort();
  return { until: untils[0] ?? null, times: meta.times ?? rule.count ?? null };
}

/**
 * The next occurrence of a repeating task that's done (or skipped) with `after` as the day to count
 * from: its due date, and the patch that counts `times:` (or the rule's COUNT) down. Null if the
 * task doesn't repeat, or this was its last time.
 */
function following(meta: TaskMeta, after: string): { due: string; patch: TaskPatch } | null {
  const rule = meta.rec ? parseRule(meta.rec) : null;
  if (!rule) return null;
  const ends = endsOf(meta, rule);
  if (ends.times !== null && ends.times <= 1) return null;
  const due = nextDue(rule, meta.due, after);
  if (!due || (ends.until && due.slice(0, 10) > ends.until)) return null;
  const start = meta.start && shiftDate(meta.start, daysBetween(meta.due ?? after, due));
  const countdown: TaskPatch = meta.times !== null ? { times: meta.times - 1 } : rule.count ? { rec: formatRule({ ...rule, count: rule.count - 1 }) } : {};
  return { due, patch: { due, ...(start ? { start } : {}), ...countdown } };
}

/**
 * The patch that skips a repeating task's current occurrence: due (and start) move to the next
 * date without it being done, and a skipped time counts as one of its `times:`. A gap after
 * completion counts from the due date, as if done on time. Null if the task doesn't repeat, or has
 * no next time to skip to.
 */
export function skipPatch(meta: TaskMeta, today: string): TaskPatch | null {
  return following(meta, meta.due?.slice(0, 10) ?? today)?.patch ?? null;
}

/** Put a new token among the tokens at the end of the text, before the first that ranks after it (else last). */
function insertToken(text: string, field: Field, token: string): string {
  const next = trailing(text, tokensOf(text)).find((t) => RANK[t.field] > RANK[field]);
  if (next) return `${text.slice(0, next.from)}${token} ${text.slice(next.from)}`;
  const body = text.trimEnd();
  return `${body}${body ? " " : ""}${token}${text.slice(body.length)}`;
}

/**
 * A test for due dates from an expression like `<=today`, `>2026-10-01` or `tomorrow` (no operator
 * means that day), or null if it isn't one. `today` is the day it's evaluated on. A task with no
 * due date never matches.
 */
export function dueFilter(expr: string, today: string): ((due: string | null) => boolean) | null {
  const m = expr.trim().match(/^(<=|>=|<|>|=)?\s*(today|tomorrow|yesterday|\d{4}-\d{2}-\d{2})$/i);
  if (!m || (/^\d/.test(m[2]) && !isDate(m[2]))) return null;
  const shift = { today: 0, tomorrow: 1, yesterday: -1 }[m[2].toLowerCase()];
  const day = shift === undefined ? m[2] : addDays(today, shift);
  const op = m[1] ?? "=";
  return (due) => {
    if (!due) return false;
    const d = due.slice(0, 10);
    return op === "<" ? d < day : op === "<=" ? d <= day : op === ">" ? d > day : op === ">=" ? d >= day : d === day;
  };
}

/** The day `n` days after `day` (both YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A note with task lines added: at the end of its "Tasks" section (a heading named Tasks, at any
 * level), or, without one, at the end of the note, under a new `## Tasks` heading if `heading`
 * (a daily note) or right after the last line otherwise. `line` is where the first one landed.
 */
export function withTasksAdded(content: string, block: string[], heading: boolean): { content: string; line: number } {
  return withSectionAdded(content, block, "Tasks", heading);
}

/** The same, for any section by its heading's words (a daily note's "Done"). */
export function withSectionAdded(content: string, block: string[], name: string, heading: boolean): { content: string; line: number } {
  let last = content.length;
  while (last > 0 && content[last - 1] === "\n") last--; // a loop: /\n+$/ is quadratic on many blank lines
  const lines = content.slice(0, last).split("\n");
  if (lines.length === 1 && lines[0] === "") lines.pop();
  let fence: string | null = null;
  let section = -1;
  let level = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? null : f;
    const h = !fence && !f ? lines[i].match(/^(#{1,6})\s+(.*)$/) : null;
    if (!h) continue;
    if (section < 0 && headingText(h[2]).toLowerCase() === name.toLowerCase()) [section, level] = [i, h[1].length];
    else if (section >= 0 && h[1].length <= level) {
      end = i;
      break;
    }
  }
  let at: number;
  if (section >= 0) {
    // After the section's last line with anything on it; a section with nothing yet gets a blank line first.
    let last = end;
    while (last > section + 1 && !lines[last - 1].trim()) last--;
    const empty = last === section + 1;
    const insert = empty ? ["", ...block] : block;
    lines.splice(last, 0, ...insert);
    at = last + (empty ? 1 : 0);
    const after = last + insert.length;
    if (after < lines.length && lines[after].trim()) lines.splice(after, 0, ""); // keep a blank line before the next heading
  } else if (heading) {
    lines.push(...(lines.length ? [""] : []), `## ${name}`, "", ...block);
    at = lines.length - block.length;
  } else {
    // Straight after a list; after a blank line otherwise.
    if (lines.length && !/^\s*([-*+]|\d+[.)])\s/.test(lines[lines.length - 1])) lines.push("");
    at = lines.length;
    lines.push(...block);
  }
  return { content: lines.join("\n") + "\n", line: at + 1 };
}

/**
 * Which Today section an open task is in on `date`: overdue (due before it), due today, or starting
 * today; null if none. The most urgent wins, so a task is in one section at most.
 */
export function todaySection(meta: TaskMeta, date: string): "overdue" | "due" | "starting" | null {
  const due = meta.due?.slice(0, 10) ?? "";
  if (due && due < date) return "overdue";
  if (due === date) return "due";
  return meta.start?.slice(0, 10) === date ? "starting" : null;
}

/** A task where it lives: its note, its line (1-based), and the heading it's under. */
export interface Task extends ParsedTask {
  path: string;
  /** The whole line, as written. */
  raw: string;
  /** Its note, as people see it. */
  title: string;
  line: number;
  heading: string | null;
}

/** Every task in a note, in order: lines in fenced code aren't tasks, and nor are completions logged under `## Done` (records, not tasks). */
export function tasksIn(path: string, text: string, title: string): Task[] {
  const out: Task[] = [];
  const logged = new Set(doneLines(text).map((d) => d.line));
  let fence: string | null = null;
  let heading: string | null = null;
  text.split("\n").forEach((line, i) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? null : f;
    if (fence || f) return;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) heading = headingText(h[1]);
    const task = logged.has(i + 1) ? null : parseTask(line);
    if (task) out.push({ ...task, path, raw: line, title, line: i + 1, heading });
  });
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A day in a few words, without reference to today: "Oct 6". */
export const shortDate = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

/**
 * What a change to one line did to its task, for history: "Completed 'Pay rent'", "Reopened …", or,
 * for a repeating one that moved on to its next date, "Completed 'Pay rent' (due Oct 1)". Null if
 * it's neither (or the words changed, so it's an edit).
 */
export function describeTaskEdit(before: string, after: string): string | null {
  const a = parseTask(before);
  const b = parseTask(after);
  if (!a || !b || a.summary !== b.summary) return null;
  const name = `'${a.summary}'`;
  if (!a.done && b.done) return `Completed ${name}`;
  if (a.done && !b.done) return `Reopened ${name}`;
  if (a.done || !a.meta.rec || !b.meta.due || b.meta.due === a.meta.due || b.meta.rec === null) return null;
  // A due date moving on to the rule's next one is the task done (an `after-` rule's next depends on
  // the day it was done, so any later day counts). Moved by hand to another date, it isn't.
  const rule = parseRule(a.meta.rec);
  if (!rule) return null;
  const advanced = rule.from === "done" || !a.meta.due ? b.meta.due > (a.meta.due ?? "") : b.meta.due === nextDue(rule, a.meta.due, a.meta.due);
  return advanced ? `Completed ${name}${a.meta.due ? ` (due ${shortDate(a.meta.due)})` : ""}` : null;
}
