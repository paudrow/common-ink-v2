// Writing .common-ink/places.json from the app: one key at a time (the bottom bar, saved searches), the
// rest of the file as it was. Offline, a change is held like any edit; a second change made before it's
// sent builds on the one held, since both are held under the one path.
import { PLACES_PATH } from "../../worker/src/places.ts";
import { setTopLevelKey, topLevelKeys } from "./json-edit.ts";
import { unreachable, type Offline } from "./offline.ts";

/**
 * Set one top-level key of places.json to what `value` makes of the text as it is (null: it can't be
 * read, so nothing's written), and say what happened through `notice` when it's worth saying.
 */
export async function writePlacesKey(offline: Offline, key: string, value: (now: string) => unknown, what: string, notice: (message: string, alert?: boolean) => void): Promise<void> {
  const What = `${what[0].toUpperCase()}${what.slice(1)}`;
  for (let tries = 0; tries < 3; tries++) {
    // A change held here and not yet sent (made offline) comes first: this one builds on it, not on the
    // server's copy, which would drop it.
    const held = await offline.unsentFor(PLACES_PATH);
    const now = held ? { text: held.text, revision: held.base } : await offline.read(PLACES_PATH);
    const next = value(now.text);
    if (next === null) return notice(`places.json can't be read: fix it to change ${what}.`, true);
    const text = setTopLevelKey(now.text.trim() ? now.text : "{}\n", key, next);
    if (text === null) return notice(`places.json isn't a JSON object: fix it to change ${what}.`, true);
    try {
      if ((await offline.write(PLACES_PATH, text, now.revision)).status !== "conflict") {
        if (held) await offline.release(PLACES_PATH);
        return;
      }
    } catch (err) {
      if (!unreachable(err)) return notice(`${What} couldn't be saved: ${(err as Error).message}`, true);
      await offline.hold({ path: PLACES_PATH, text, base: now.revision });
      return notice(`You're offline: ${what} is changed here, and saved once you're back.`);
    }
  }
  notice(`${What} couldn't be saved: places.json kept changing as it was written. Try again.`, true);
}

/**
 * places.json's saved searches as written, with one set (or, with no query, taken out). Read as
 * setTopLevelKey reads the file, and a trailing comma forgiven: null if "saved" still can't be read,
 * so it's never written over as if it were empty.
 */
export function withSaved(text: string, name: string, query: string | null): Record<string, unknown> | null {
  const keys = topLevelKeys(text.trim() ? text : "{}");
  if (!keys) return null;
  const at = keys.keys.findLast((k) => k.key === "saved");
  let saved: Record<string, unknown> = {};
  if (at) {
    const raw = text.slice(at.valueStart, at.end);
    let was: unknown;
    for (const attempt of [raw, raw.replace(/,(\s*[}\]])/g, "$1")]) {
      try {
        was = JSON.parse(attempt);
        break;
      } catch {
        // Try it without trailing commas.
      }
    }
    if (!was || typeof was !== "object" || Array.isArray(was)) return null;
    saved = { ...(was as Record<string, unknown>) };
  }
  if (query === null) delete saved[name];
  else saved[name] = query;
  return saved;
}
