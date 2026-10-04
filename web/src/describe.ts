// Changes in words, for the history panel and the CLI: who made them, when, and which lines.
import { isNote, type Author, type Change, type FilePath } from "../../worker/src/files.ts";

/** "you", a person's email, or an agent's name with who it worked for. */
export function describeAuthor(author: Author, me?: string): string {
  if (author.kind === "user") return author.email === me ? "you" : author.email;
  return author.by ? `${author.name} (for ${author.by === me ? "you" : author.by})` : author.name;
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

/** "just now", "5 min ago", "3 h ago", or a date. */
export function ago(time: number, now = Date.now()): string {
  const s = Math.round((now - time) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(time).toISOString().slice(0, 10);
}

const NAMES: Array<[RegExp, string]> = [
  [/^\.common-ink\/settings\.json$/, "Workspace settings"],
  [/^\.common-ink\/defaults\/settings\.json$/, "Default settings"],
  [/^\.common-ink\/users\/[^/]+\/settings\.json$/, "User settings"],
  [/^\.common-ink\/layout\.json$/, "Layout"],
];

/** What to call a file: a note's path without ".md", or the name of a workspace JSON file. */
export function docLabel(path: FilePath): string {
  if (isNote(path)) return path.replace(/\.md$/, "");
  return NAMES.find(([re]) => re.test(path))?.[1] ?? path;
}
