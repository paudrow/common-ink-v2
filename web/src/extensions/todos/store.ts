// Every task in every note, read through the extension API and kept until a note's revision changes,
// and the one way the Todos view and task lists change a task: read its note, find its line, rewrite
// it with the token writer, and save it as a change by you.
import { isNote } from "common-ink/files";
import type { FilePath, Revision } from "../../../../worker/src/files.ts";
import type { ExtensionContext } from "../../extension-api.ts";
import { today } from "./chips.ts";
import { tagsInLine } from "./tags.ts";
import { editTaskLine, parseTask, patchProblem, tasksIn, withTasksAdded, type Task, type TaskPatch } from "./tasks.ts";

interface Note {
  revision: Revision;
  tasks: Task[];
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

  constructor(private ctx: ExtensionContext) {}

  /** Every task in every note, in note order then line order. Notes are read again only when they've changed. */
  async all(): Promise<Task[]> {
    const listed = (await this.ctx.files.fetchList()).filter((f) => isNote(f.path) && !f.path.startsWith("."));
    await Promise.all(
      listed.map(async (f) => {
        if (this.notes.get(f.path)?.revision === f.revision) return;
        const file = await this.ctx.files.read(f.path);
        this.notes.set(f.path, { revision: file.revision, tasks: tasksIn(f.path, file.text, this.ctx.util.label(f.path)), tags: noteTags(file.text) });
      }),
    );
    const here = new Set(listed.map((f) => f.path));
    for (const path of this.notes.keys()) if (!here.has(path)) this.notes.delete(path);
    return [...this.notes.keys()].sort().flatMap((path) => this.notes.get(path)!.tasks);
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
   * Change a task in its note: `patch` through the token writer (ticking moves a repeating one on to
   * its next date). Throws, saying why, if the task isn't there any more or the patch can't be written.
   */
  async update(t: Task, patch: TaskPatch): Promise<Task> {
    const problem = patchProblem(patch);
    if (problem) throw new Error(problem);
    const { file, lines, at } = await this.find(t);
    const next = editTaskLine(lines[at], patch, today());
    if (next !== lines[at]) {
      lines[at] = next;
      await this.save(t.path, lines.join("\n"), file.revision);
    }
    return { ...t, ...parseTask(next)!, raw: next, line: at + 1 };
  }

  /** Put a task's line back as it was (`was`), if it's still as a change left it (`now`): Undo, from a list. */
  async revert(now: Task, was: Task): Promise<void> {
    const { file, lines, at } = await this.find(now);
    lines[at] = was.raw;
    await this.save(now.path, lines.join("\n"), file.revision);
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
