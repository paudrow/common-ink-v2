// Ticking a task for an agent (the complete_task tool), the way the Tasks extension does in the app:
// a repeating task moves on to its next date and its completion is logged under ## Done in today's
// daily note, or v1's ticked copy is left, as the person's settings say. Two changes to two files,
// each by the agent, both reported so they can be undone together.
import { completeTask, parseTask, withDone, type LogMode } from "../../web/src/extensions/tasks/tasks.ts";
import { dailyPath, initialText } from "../../web/src/extensions/daily/daily.ts";
import { userSettingsPath, WORKSPACE_SETTINGS } from "./settings.ts";
import type { Author, FilePath, WriteResult } from "./files.ts";

interface Files {
  read(path: FilePath): Promise<{ text: string; revision: number } | null> | { text: string; revision: number } | null;
  write(w: { path: FilePath; text: string; base: number; author: Author }): Promise<WriteResult> | WriteResult;
}

/** The settings that say how a completion is recorded: the workspace's, then the person's own over them. */
async function logSettings(store: Files, author: Author): Promise<{ mode: LogMode; logPlain: boolean; folder: string; daily: boolean }> {
  const email = author.kind === "user" ? author.email : author.kind === "agent" ? author.by : null;
  const read = async (path: FilePath | null) => {
    try {
      return path ? (JSON.parse((await store.read(path))?.text || "{}") as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const s = { ...(await read(WORKSPACE_SETTINGS)), ...(await read(email ? userSettingsPath(email) : null)) };
  const mode = s["tasks.completionLog"] === "inline" || s["tasks.completionLog"] === "none" ? s["tasks.completionLog"] : "daily";
  const off = Array.isArray(s["extensions.disabled"]) ? (s["extensions.disabled"] as unknown[]) : [];
  return { mode, logPlain: s["tasks.logPlainTasks"] === true, folder: typeof s["daily.folder"] === "string" ? s["daily.folder"] : "Journal", daily: !off.includes("daily") };
}

/** Today in UTC, when the caller doesn't say what day it is where they are. */
const utcDay = () => new Date().toISOString().slice(0, 10);

export class TaskError extends Error {}

/**
 * Tick (or untick, with `done: false`) the task on line `line` (1-based) of a note, checking it's still
 * `text` if given. Returns what changed: the note's write and the daily note's, if it logged one.
 */
export async function completeTaskIn(store: Files, args: { path: FilePath; line: number; text?: string; done: boolean; today?: string }, author: Author) {
  const file = await store.read(args.path);
  if (!file) throw new TaskError(`There's no note at ${args.path}`);
  const lines = file.text.split("\n");
  const at = args.line - 1;
  const task = parseTask(lines[at] ?? "");
  if (!task) throw new TaskError(`Line ${args.line} of ${args.path} isn't a task`);
  if (args.text !== undefined && lines[at].trim() !== args.text.trim() && task.text.trim() !== args.text.trim()) throw new TaskError(`Line ${args.line} of ${args.path} isn't that task any more: it's "${lines[at]}"`);
  const day = args.today ?? utcDay();
  const how = await logSettings(store, author);
  const mode: LogMode = how.mode === "daily" && !how.daily ? "none" : how.mode;
  const note = args.path.replace(/\.md$/, "");
  const done = completeTask(lines[at], lines[at + 1], { checked: args.done }, day, { mode, logPlain: how.logPlain, note });
  lines.splice(at, done.replaced, ...done.lines);
  const result: { note: WriteResult; daily?: WriteResult; logged?: string } = { note: await store.write({ path: args.path, text: lines.join("\n"), base: file.revision, author }) };
  if (done.log && result.note.status !== "conflict") {
    const path = dailyPath(how.folder, day) as FilePath;
    const daily = await store.read(path);
    result.daily = await store.write({ path, text: withDone(daily?.text || initialText(day), done.log), base: daily?.revision ?? 0, author });
    result.logged = done.log;
  }
  return result;
}
