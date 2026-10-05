// Every task in every note, read through the extension API and kept until a note's revision changes,
// and the one way the Tasks view and task lists change a task: read its note, find its line, rewrite
// it with the token writer, and save it as a change by you. A completion is logged in today's daily
// note (the "tasks.completionLog" setting) by the same writes, whether it was ticked here or in a note.
import { isNote } from "common-ink/files";
import type { FilePath, Revision } from "../../../../worker/src/files.ts";
import type { ExtensionContext } from "../../extension-api.ts";
import { today } from "./chips.ts";
import { tagsInLine } from "./tags.ts";
import { parseQuickAdd } from "./quickadd.ts";
import type { DailyNotes } from "../daily/daily.ts";
import { backTo, completeTask, doneLines, parseLogLine, parseTask, patchProblem, TASK_LINE, tasksIn, withDone, withoutDone, withTasksAdded, type LogMode, type ParsedTask, type Task, type TaskPatch } from "./tasks.ts";

/** How completions are logged, from the settings: where, and whether plain tasks are too. */
export interface LogSettings {
  mode: LogMode;
  logPlain: boolean;
}

/** A completion in today's daily note, as the Tasks view lists it. */
export interface Logged {
  /** The line in the daily note. */
  line: string;
  task: ParsedTask;
  /** The note it was done in, by name. */
  note: string;
}

/** One completion logged under a daily note's `## Done`: where it is, what it says, and its day. */
export interface LoggedCompletion {
  /** The daily note, and the line (1-based) the completion is on. */
  path: FilePath;
  line: number;
  day: string;
  summary: string;
  /** The note it was done in, by name, as its link says. */
  note: string;
}

interface Note {
  revision: Revision;
  tasks: Task[];
  /** Completions logged in it (a daily note's `## Done`). */
  logged: LoggedCompletion[];
  /** Every #tag in the note, tasks or not, as written. */
  tags: string[];
}

/** A note's tags, outside code: in its prose lines and tasks alike. */
function noteTags(text: string): string[] {
  let fence = false;
  return text.split("\n").flatMap((line) => {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    return fence || /^ {0,3}#{1,6}(\s|$)/.test(line) ? [] : tagsInLine(line).map((t) => t.display);
  });
}

export class TaskStore {
  private notes = new Map<FilePath, Note>();
  /** Each note's writes from here, one after another (a quick tick and its log can't overtake each other). */
  private queues = new Map<string, Promise<unknown>>();
  /** How a completion's task looked before and after, by its log line, this session: to put it back exactly. */
  private advanced = new Map<string, { path: string; before: string; after: string }>();

  constructor(
    private ctx: ExtensionContext,
    /** Where daily notes are, from the Daily notes extension; undefined while it's off. */
    private daily: () => DailyNotes | undefined = () => undefined,
    private logging: () => LogSettings = () => ({ mode: "none", logPlain: false }),
  ) {}

  /** How completions are logged now: as the settings say, or not at all while Daily notes is off. */
  logSettings(): LogSettings {
    const s = this.logging();
    return s.mode === "daily" && !this.daily() ? { ...s, mode: "none" } : s;
  }

  /** Every task in every note, in note order then line order. Notes are read again only when they've changed. */
  async all(): Promise<Task[]> {
    const listed = (await this.ctx.files.fetchList()).filter((f) => isNote(f.path) && !f.path.startsWith("."));
    await Promise.all(
      listed.map(async (f) => {
        if (this.notes.get(f.path)?.revision === f.revision) return;
        const file = await this.ctx.files.read(f.path);
        const logged = doneLines(file.text).flatMap((d) => {
          const l = parseLogLine(d.text)!;
          const day = l.task.meta.done?.slice(0, 10);
          return day ? [{ path: f.path, line: d.line, day, summary: l.task.summary, note: l.note }] : [];
        });
        this.notes.set(f.path, { revision: file.revision, tasks: tasksIn(f.path, file.text, this.ctx.util.label(f.path)), tags: noteTags(file.text), logged });
      }),
    );
    const here = new Set(listed.map((f) => f.path));
    for (const path of this.notes.keys()) if (!here.has(path)) this.notes.delete(path);
    return [...this.notes.keys()].sort().flatMap((path) => this.notes.get(path)!.tasks);
  }

  /**
   * A task's logged completions, newest first, as last read (all() reads them again): the log lines
   * that link to its note and say its words. When none say its words (they were edited since), and it's
   * its note's only repeating task, the lines linking to its note that say no other task's words.
   */
  completionsOf(t: { path: string; summary: string }): LoggedCompletion[] {
    const all = [...this.notes.values()].flatMap((n) => n.logged).filter((l) => this.ctx.util.notePathFor(l.note) === t.path);
    let mine = all.filter((l) => l.summary === t.summary);
    if (!mine.length) {
      const tasks = this.notes.get(t.path as FilePath)?.tasks ?? [];
      const repeating = tasks.filter((x) => x.meta.rec);
      const others = new Set(tasks.filter((x) => x.summary !== t.summary).map((x) => x.summary));
      if (repeating.length === 1 && repeating[0].summary === t.summary) mine = all.filter((l) => !others.has(l.summary));
    }
    return mine.sort((a, b) => b.day.localeCompare(a.day) || b.path.localeCompare(a.path) || b.line - a.line);
  }

  /** Everyone @-mentioned on a task anywhere, most tasks first. */
  async people(): Promise<string[]> {
    return byUse((await this.all()).flatMap((t) => t.meta.assignees));
  }

  /** Every tag in the notes, most used first. */
  async tags(): Promise<string[]> {
    await this.all();
    return byUse([...this.notes.values()].flatMap((n) => n.tags));
  }

  /** Notes a task can move to, most recently listed first. */
  noteList(): Array<{ path: FilePath; title: string }> {
    return this.ctx.files
      .list()
      .filter((f) => isNote(f.path) && !f.path.startsWith("."))
      .map((f) => ({ path: f.path, title: this.ctx.util.label(f.path) }));
  }

  /**
   * Change a task in its note: `patch` through the token writer. Ticking a repeating one moves it on
   * to its next date (or, set to "inline", leaves a ticked copy), and logs it in today's daily note
   * when the settings say. Throws, saying why, if the task isn't there any more or the patch can't be
   * written. `log` is the line it logged, if any, for an Undo to take back.
   */
  async update(t: Task, patch: TaskPatch): Promise<Task & { log: string | null; logged: { path: FilePath; line: number } | null }> {
    const problem = patchProblem(patch);
    if (problem) throw new Error(problem);
    const { file, lines, at } = await this.find(t);
    const done = completeTask(lines[at], lines[at + 1], patch, today(), { ...this.logSettings(), note: t.title });
    const before = lines[at];
    lines.splice(at, done.replaced, ...done.lines);
    if (lines.join("\n") !== file.text) await this.save(t.path, lines.join("\n"), file.revision);
    const logged = done.log ? await this.log(done.log, { path: t.path, before, after: done.lines[0] }) : null;
    return { ...t, ...parseTask(done.lines[0])!, raw: done.lines[0], line: at + 1, log: done.log, logged };
  }

  /** Put a task's line back as it was (`was`), if it's still as a change left it (`now`), and take back what it logged: Undo, from a list. */
  async revert(now: Task & { log?: string | null }, was: Task): Promise<void> {
    const { file, lines, at } = await this.find(now);
    lines[at] = was.raw;
    await this.save(now.path, lines.join("\n"), file.revision);
    if (now.log) await this.unlog(now.log);
  }

  /** Add a completion to the end of its day's daily note's `## Done`, making the note (with its date as its title) or the section if they're missing. */
  async log(line: string, record?: { path: string; before: string; after: string }): Promise<{ path: FilePath; line: number } | null> {
    const daily = this.daily();
    const day = parseLogLine(line)?.task.meta.done?.slice(0, 10);
    if (!daily || !day) return null;
    if (record) this.advanced.set(line, record);
    const path = daily.pathFor(day) as FilePath;
    let at = 0;
    await this.queued(path, async () => {
      const file = await this.ctx.files.read(path);
      const text = withDone(file.revision === 0 ? daily.initial(day) : file.text, line);
      at = doneLines(text).filter((d) => d.text === line).at(-1)?.line ?? 0;
      await this.save(path, text, file.revision);
    });
    return { path, line: at };
  }

  /** Take a completion out of its daily note's `## Done`, if it's there. */
  async unlog(line: string): Promise<void> {
    const daily = this.daily();
    const day = parseLogLine(line)?.task.meta.done?.slice(0, 10);
    if (!daily || !day) return;
    const path = daily.pathFor(day);
    await this.queued(path, async () => {
      const file = await this.ctx.files.read(path as FilePath);
      const text = withoutDone(file.text, line);
      if (text !== null) await this.save(path, text, file.revision);
    });
  }

  /** What's logged as done in today's daily note, in the order it was done. */
  async loggedToday(): Promise<Logged[]> {
    const daily = this.daily();
    if (!daily) return [];
    const file = await this.ctx.files.read(daily.pathFor(daily.today()) as FilePath);
    return doneLines(file.text).map((d) => ({ line: d.text, ...parseLogLine(d.text)! }));
  }

  /**
   * Take a completion back from the log: the task, in the note it was done in, is put back as it was
   * (a repeating one to the day it was done, or exactly as it was if it moved on in this session; a
   * plain one unticked), and its line leaves the log. Throws if the task can't be found there.
   */
  async putBack(line: string): Promise<void> {
    const logged = parseLogLine(line);
    const day = logged?.task.meta.done?.slice(0, 10);
    const path = logged && this.ctx.util.notePathFor(logged.note);
    if (!logged || !day || !path) throw new Error("That isn't a task's completion");
    const file = await this.ctx.files.read(path);
    const lines = file.text.split("\n");
    const known = this.advanced.get(line);
    const same = (l: string) => parseTask(l)?.summary === logged.task.summary;
    let at = known?.path === path ? lines.indexOf(known.after) : -1;
    if (at >= 0) lines[at] = known!.before;
    else {
      // A repeating task still open, or a plain one ticked that day.
      at = lines.findIndex((l) => same(l) && !parseTask(l)!.done && !!parseTask(l)!.meta.rec);
      // `last:` goes back to the completion logged before this one, if there is one.
      const before = this.completionsOf({ path, summary: logged.task.summary }).find((c) => c.day < day)?.day ?? null;
      if (at >= 0) lines[at] = backTo(lines[at], day, before) ?? lines[at];
      else {
        at = lines.findIndex((l) => same(l) && parseTask(l)!.done && parseTask(l)!.meta.done?.slice(0, 10) === day);
        if (at < 0) throw new Error(`"${logged.task.summary}" isn't in ${logged.note} any more`);
        lines[at] = completeTask(lines[at], undefined, { checked: false }, day, { mode: "none", note: logged.note }).lines[0];
      }
    }
    await this.save(path, lines.join("\n"), file.revision);
    this.advanced.delete(line);
    await this.unlog(line);
  }

  /** Run `write` after the writes to `path` before it. */
  private queued(path: string, write: () => Promise<void>): Promise<void> {
    const run = (this.queues.get(path) ?? Promise.resolve()).catch(() => {}).then(write);
    this.queues.set(path, run);
    return run;
  }

  /**
   * Add a task typed in words (the quick-add bar) to a note: one named with `→ [[Note]]` or `named`
   * (it must exist), `path` (made if it's missing), as one change. A daily note (`daily`) gets a
   * `## Tasks` section for it if it has none, and is made with its date as its title.
   */
  async add(text: string, ignore: string[], to: { named: string | null; path: string | null; daily?: boolean }): Promise<{ path: FilePath; line: number; text: string }> {
    const daily = to.daily ? this.daily() : undefined;
    const q = parseQuickAdd(text, today(), ignore);
    if (!q.words) throw new Error("Say what the task is: once its dates and repeats are taken out, there are no words left");
    const name = q.target ?? to.named;
    const path = name ? this.ctx.util.notePathFor(name) : (to.path as FilePath | null);
    if (!path) throw new Error(`"${name ?? to.path}" isn't a note's name`);
    const file = await this.ctx.files.read(path);
    if (name && file.revision === 0) throw new Error(`There's no note named ${name}`);
    const title = path.replace(/\.md$/, "").split("/").pop()!;
    const day = daily?.dayOf(path);
    const before = file.revision === 0 ? (day ? daily!.initial(day) : `# ${title}\n`) : file.text;
    const added = withTasksAdded(before, [q.line], !name && !!to.daily);
    await this.save(path, added.content, file.revision);
    return { path, line: added.line, text: q.line.match(TASK_LINE)![4] };
  }

  /** Move a task to the end of another note's Tasks section (or the note's end), and out of its own. */
  async move(t: Task, to: FilePath): Promise<void> {
    const { lines, at } = await this.find(t);
    const line = lines[at];
    const target = await this.ctx.files.read(to);
    await this.save(to, withTasksAdded(target.text, [line.trimStart()], false).content, target.revision);
    // Read it again: it's only taken out once it's safely in the other note.
    const again = await this.find(t);
    again.lines.splice(again.at, 1);
    await this.save(t.path, again.lines.join("\n"), again.file.revision);
  }

  /** The task's note and its line there now: where it was, or, if the note moved it, the one line that's the same task. */
  private async find(t: Task) {
    const file = await this.ctx.files.read(t.path as FilePath);
    const lines = file.text.split("\n");
    const same = (line: string | undefined) => {
      const now = line === undefined ? null : parseTask(line);
      return !!now && now.text === t.text && now.done === t.done;
    };
    let at = same(lines[t.line - 1]) ? t.line - 1 : -1;
    if (at < 0) {
      const matches = lines.flatMap((line, i) => (same(line) ? [i] : []));
      if (matches.length === 1) at = matches[0];
    }
    if (at < 0) throw new Error("That task changed in its note. The list shows it as it is now.");
    return { file, lines, at };
  }

  private async save(path: string, text: string, base: Revision) {
    const result = await this.ctx.files.write(path as FilePath, text, base);
    if (result.status === "conflict") throw new Error("The note changed meanwhile. Try again.");
    await this.ctx.workbench.refreshFromServer([path as FilePath]);
  }
}

/** Values by how often they're used, most first, each once (first spelling kept, case aside). */
function byUse(values: string[]): string[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const v of values) {
    const key = v.toLowerCase();
    const c = count.get(key);
    if (c) c.n++;
    else count.set(key, { name: v, n: 1 });
  }
  return [...count.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((c) => c.name);
}
