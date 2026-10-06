// Ticking a task for an agent (the complete_task tool), the way the Tasks extension does in the app:
// a repeating task moves on to its next date and its completion is logged under ## Done in today's
// daily note, or v1's ticked copy is left, as the person's settings say. It's one step in the Durable
// Object: the note is read, its task ticked, and the note and the daily note written in one
// transaction, so ticks at once can't clash, and the same tick sent twice finds it ticked.
import { completeTask, parseTask, withDone, type LogMode } from "../../web/src/extensions/tasks/tasks.ts";
import { dailyPath, initialText } from "../../web/src/extensions/daily/daily.ts";
import { userSettingsPath, WORKSPACE_SETTINGS } from "./settings.ts";
import type { Author, FilePath, Files as History, WriteResult } from "./files.ts";

/** The task to tick: its note, its line (from 1) and, if given, the text it should still have. */
export interface TaskArgs {
  path: FilePath;
  line: number;
  text?: string;
  done: boolean;
  /** The person's local date, YYYY-MM-DD. */
  today: string;
}

/** What ticking did (the note's write, and the daily note's if it logged one), or why it couldn't. An answer, not a throw, so it crosses the Durable Object's boundary as it is. */
export type Ticked = { note: WriteResult; daily?: WriteResult; logged?: string } | { refused: string };

/** The settings that say how a completion is recorded: the workspace's, then the person's own over them. */
function logSettings(files: Pick<History, "read">, author: Author): { mode: LogMode; logPlain: boolean; folder: string; daily: boolean } {
  const email = author.kind === "user" ? author.email : author.kind === "agent" ? author.by : null;
  const read = (path: FilePath | null) => {
    try {
      return path ? (JSON.parse(files.read(path)?.text || "{}") as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const s = { ...read(WORKSPACE_SETTINGS), ...read(email ? userSettingsPath(email) : null) };
  const mode = s["tasks.completionLog"] === "inline" || s["tasks.completionLog"] === "none" ? s["tasks.completionLog"] : "daily";
  const off = Array.isArray(s["extensions.disabled"]) ? (s["extensions.disabled"] as unknown[]) : [];
  return { mode, logPlain: s["tasks.logPlainTasks"] === true, folder: typeof s["daily.folder"] === "string" ? s["daily.folder"] : "Journal", daily: !off.includes("daily") };
}

/** Tick (or untick, with `done: false`) a task, and log its completion, as one step. */
export function completeTaskIn(files: Pick<History, "read" | "writeAll">, args: TaskArgs, author: Author): Ticked {
  const file = files.read(args.path);
  if (!file) return { refused: `There's no note at ${args.path}` };
  const lines = file.text.split("\n");
  const at = args.line - 1;
  const task = parseTask(lines[at] ?? "");
  if (!task) return { refused: `Line ${args.line} of ${args.path} isn't a task` };
  if (args.text !== undefined && lines[at].trim() !== args.text.trim() && task.text.trim() !== args.text.trim()) return { refused: `Line ${args.line} of ${args.path} isn't that task any more: it's "${lines[at]}"` };
  const how = logSettings(files, author);
  const mode: LogMode = how.mode === "daily" && !how.daily ? "none" : how.mode;
  const done = completeTask(lines[at], lines[at + 1], { checked: args.done }, args.today, { mode, logPlain: how.logPlain, note: args.path.replace(/\.md$/, "") });
  lines.splice(at, done.replaced, ...done.lines);
  const ticked = lines.join("\n");
  const daily = done.log ? (dailyPath(how.folder, args.today) as FilePath) : null;
  if (!daily || !done.log) return { note: files.writeAll([{ path: args.path, text: ticked, base: file.revision, author }])[0] };
  // A task in today's daily note is ticked and logged in one write of it.
  if (daily === args.path) {
    const [note] = files.writeAll([{ path: args.path, text: withDone(ticked, done.log), base: file.revision, author }]);
    return { note, daily: note, logged: done.log };
  }
  const log = files.read(daily);
  const [note, logged] = files.writeAll([
    { path: args.path, text: ticked, base: file.revision, author },
    { path: daily, text: withDone(log?.text || initialText(args.today), done.log), base: log?.revision ?? 0, author },
  ]);
  return { note, daily: logged, logged: done.log };
}
