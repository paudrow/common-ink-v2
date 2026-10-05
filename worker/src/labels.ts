// Labels: names for a note's state at one revision, like git tags. They live in a JSON file in the
// workspace, so adding one is a change with an author, and anyone can read or edit them.
import { parseFilePath, type FilePath, type Revision } from "./files.ts";

export const LABELS_PATH = parseFilePath(".common-ink/labels.json")!;

export interface Label {
  name: string;
  path: FilePath;
  revision: Revision;
}

/** The labels in the labels file. Entries that aren't labels are skipped. */
export function parseLabels(text: string): Label[] {
  let data: unknown;
  try {
    data = JSON.parse(text || "{}");
  } catch {
    return [];
  }
  const list = (data as { labels?: unknown })?.labels;
  if (!Array.isArray(list)) return [];
  return list.flatMap((l) => {
    const path = parseFilePath(l?.path);
    const ok = path && typeof l.name === "string" && l.name.trim() && Number.isSafeInteger(l.revision) && l.revision > 0;
    return ok ? [{ name: l.name.trim(), path, revision: l.revision as number }] : [];
  });
}

export function labelsText(labels: Label[]): string {
  return `${JSON.stringify({ labels }, null, 2)}\n`;
}
