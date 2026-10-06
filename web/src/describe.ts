// Changes in words, for the history panel and the CLI: who made them, when, and which lines.
import { diffPatch } from "node-diff3";
import { isNote, type Author, type Change, type FilePath } from "../../worker/src/files.ts";
import { keyOfPath } from "../../worker/src/records.ts";

/** What each data source's sync is called. */
const SYNCS: Record<string, string> = { "google-calendar": "Google Calendar sync", "sample-calendar": "Sample calendar" };

/** "you", a person's email, an agent's name with who it worked for, or a data source's sync. */
export function describeAuthor(author: Author, me?: string): string {
  switch (author.kind) {
    case "user":
      return author.email === me ? "you" : author.email;
    case "extension":
      return `${author.id} (extension${author.by === me ? "" : `, for ${author.by}`})`;
    case "sync":
      return SYNCS[author.source] ?? `${author.source} sync`;
    case "agent":
      return author.by ? `${author.name} (for ${author.by === me ? "you" : author.by})` : author.name;
  }
}

export interface DiffLine {
  kind: "-" | "+";
  /** The line's number: in the old text for "-", in the new text for "+". */
  line: number;
  text: string;
}

/** A change's removed and added lines, in order. */
export function diffLines(change: Pick<Change, "diff">): DiffLine[] {
  return change.diff.flatMap(({ buffer1, buffer2 }) => [
    ...buffer1.chunk.map((text, i) => ({ kind: "-" as const, line: buffer1.offset + i + 1, text })),
    ...buffer2.chunk.map((text, i) => ({ kind: "+" as const, line: buffer2.offset + i + 1, text })),
  ]);
}

/** "+3 −1": lines added and removed. */
export function diffStat(change: Pick<Change, "diff">): string {
  const lines = diffLines(change);
  return `+${lines.filter((l) => l.kind === "+").length} −${lines.filter((l) => l.kind === "-").length}`;
}

/** "just now", "5 min ago", "3 h ago", or the local day. */
export function ago(time: number, now = Date.now()): string {
  const s = Math.round((now - time) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const NAMES: Array<[RegExp, string]> = [
  [/^\.common-ink\/settings\.json$/, "Workspace settings"],
  [/^\.common-ink\/defaults\/settings\.json$/, "Default settings"],
  [/^\.common-ink\/users\/[^/]+\/settings\.json$/, "User settings"],
  [/^\.common-ink\/layout\.json$/, "Layout"],
  [/^\.common-ink\/uploads\.json$/, "Uploads list"],
  [/^\.common-ink\/labels\.json$/, "Labels"],
];

/** What to call a file: a note's path without ".md", the name of a workspace JSON file, or which record it is. */
export function docLabel(path: FilePath): string {
  if (isNote(path)) return path.replace(/\.md$/, "");
  const record = keyOfPath(path);
  if (record) return record.kind === "calendar" ? `Calendar ${record.id}` : `Event ${record.id} (${record.collection})`;
  const extension = /^\.common-ink\/extensions\/(.+)$/.exec(path);
  return NAMES.find(([re]) => re.test(path))?.[1] ?? (extension ? `Extension ${extension[1]}` : path);
}

/** A before and after, as the lines that changed. */
export function runLines(before: string, after: string): Array<{ kind: "-" | "+"; text: string }> {
  return diffPatch(before.split("\n"), after.split("\n")).flatMap(({ buffer1, buffer2 }) => [
    ...buffer1.chunk.map((text) => ({ kind: "-" as const, text })),
    ...buffer2.chunk.map((text) => ({ kind: "+" as const, text })),
  ]);
}

