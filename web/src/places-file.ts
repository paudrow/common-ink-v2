// Changing .common-ink/places.json from the app: one key at a time (the bottom bar, a saved search), the
// rest of the file as it is. A change is held as itself, the key and what to make of it, not as the
// file's whole text: it's sent (now, or once the server's back) by making it on the server's latest
// copy. So it can't clash with another device's change to another key, nothing is built on a stale
// copy, and two changes made offline are both made, in order.
import { PLACES_PATH } from "../../worker/src/places.ts";
import { ServerAnswer } from "./api.ts";
import { setTopLevelKey, topLevelKeys } from "./json-edit.ts";
import type { HeldOp, Offline } from "./offline.ts";

/** A change to one key of places.json: the bar's places, or one saved search set (or, with no query, taken out). */
export type PlacesChange = { key: "bar"; ids: string[] } | { key: "saved"; name: string; query: string | null };

/** The change a held operation makes to places.json, if it's one. */
export function placesChangeOf(op: HeldOp): PlacesChange | null {
  return (op.body.places as PlacesChange | undefined) ?? null;
}

/** places.json's text with a change made, or null if what it changes can't be read. */
export function applyPlaces(text: string, change: PlacesChange): string | null {
  const value = change.key === "bar" ? change.ids : withSaved(text, change.name, change.query);
  if (value === null) return null;
  return setTopLevelKey(text.trim() ? text : "{}\n", change.key, value);
}

/**
 * Send a held change: made on the server's latest places.json and written on its revision, again if
 * another write gets there first. One that can't be made is refused (a 4xx), so it's dropped and said.
 */
export async function sendPlaces(offline: Offline, change: PlacesChange): Promise<void> {
  for (let tries = 0; tries < 5; tries++) {
    const now = await offline.latest(PLACES_PATH);
    const text = applyPlaces(now.text, change);
    if (text === null) throw new ServerAnswer("places.json can't be read: fix it, then make the change again", 422);
    if (text === now.text) return;
    if ((await offline.write(PLACES_PATH, text, now.revision)).status !== "conflict") return;
  }
  throw new ServerAnswer("places.json kept changing as it was written: make the change again", 409);
}

/**
 * Make a change to places.json: held, then sent with whatever else is held (`flush`, which says what
 * the server refused). Offline it waits, and says so.
 */
export async function changePlaces(offline: Offline, change: PlacesChange, what: string, flush: () => Promise<unknown>, notice: (message: string) => void): Promise<void> {
  const op = await offline.holdOp({ method: "PATCH", body: { places: change }, what: `Places: ${what}` });
  const held = async () => (await offline.ops()).some((o) => o.id === op.id);
  // A send already under way doesn't have this one: then the next does.
  for (let tries = 0; tries < 2 && (await held()); tries++) await flush();
  if (await held()) notice(`You're offline: ${what} is changed here, and saved once you're back.`);
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
