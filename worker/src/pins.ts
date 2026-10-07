// Pins: notes kept at the top of the Feed, under Pinned. Pinning doesn't change a note; its path goes in
// .common-ink/pins.json, in the order they were pinned, so pinning is a change to that file, with an
// author, that undo takes back, as archiving is (archive.ts). They're the workspace's for now, and each
// person's once workspaces are shared (decision 16).
//
// The file is a list kept as a set: a write based on an older version, or an undo, keeps every other
// path's pin as it is now and changes only the paths it changed, so undoing one pin never clashes with
// another from an agent or another tab.
import { isNote, merge, parseFilePath, type FilePath } from "./files.ts";

export const PINS_PATH = parseFilePath(".common-ink/pins.json")!;

/** The pins file, read: the pinned notes' paths in order, and its other keys. */
export interface Pins {
  pinned: FilePath[];
  rest: Record<string, unknown>;
}

/** The pins in a file's text, or null if it isn't valid JSON with a `pinned` list. An empty file is no pins. */
export function readPins(text: string): Pins | null {
  let data: unknown;
  try {
    data = JSON.parse(text.trim() ? text : "{}");
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { pinned = [], ...rest } = data as Record<string, unknown>;
  if (!Array.isArray(pinned)) return null;
  return { pinned: [...new Set(pinned.filter((p): p is FilePath => !!parseFilePath(p) && isNote(p as FilePath)))], rest };
}

/** The pinned paths in the pins file's text; none if it can't be read. */
export const parsePins = (text: string): FilePath[] => readPins(text)?.pinned ?? [];

export function pinsText(pins: Pins): string {
  return `${JSON.stringify({ ...pins.rest, pinned: [...new Set(pins.pinned)] }, null, 2)}\n`;
}

/** The pins with `paths` pinned (after those already pinned, in the order given) or unpinned. */
export function withPinned(current: Pins, paths: readonly FilePath[], pinned: boolean): Pins {
  const gone = new Set(paths);
  return { ...current, pinned: pinned ? [...new Set([...current.pinned, ...paths])] : current.pinned.filter((p) => !gone.has(p)) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of pins files as ordered sets: theirs, with what mine pinned (at the end) and unpinned
 * since base. If a side can't be read, they're merged line by line, as any file is.
 */
export function mergePins(mine: string, base: string, theirs: string): string | null {
  const [m, b, t] = [readPins(mine), readPins(base), readPins(theirs)];
  if (!m || !b || !t) return merge(mine, base, theirs);
  const added = m.pinned.filter((p) => !b.pinned.includes(p));
  const removed = new Set(b.pinned.filter((p) => !m.pinned.includes(p)));
  const keys = new Set([...Object.keys(m.rest), ...Object.keys(b.rest), ...Object.keys(t.rest)]);
  const rest = Object.fromEntries(
    [...keys].flatMap((k) => {
      const v = same(m.rest[k], b.rest[k]) ? t.rest[k] : m.rest[k];
      return v === undefined ? [] : [[k, v]];
    }),
  );
  return pinsText({ pinned: [...new Set([...t.pinned, ...added])].filter((p) => !removed.has(p)), rest });
}
