// Shortcuts, matched by the character a key types rather than where the key sits, so they work on any
// layout (on Dvorak, "p" is the physical R key). Keys are written as CodeMirror writes them: modifiers
// and a key joined by "-", as in "Mod-Shift-p". `Mod` is ⌘ on a Mac and Ctrl elsewhere, `Ctrl` is Ctrl
// everywhere, then `Alt` and `Shift`. The key is one character ("p", ".", "[") or a key name ("Enter").
// Modifiers must match exactly. With Shift the shifted character counts (">" for "."), and a shortcut
// written with a shifted character ("Mod->") is that key with Shift ("Mod-Shift-."). With ⌥ on a Mac
// a key types a symbol ("π" for "p"), so the layout map says which character the key types.

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

let layout: ReadonlyMap<string, string> | null = null;

/** Learn what each physical key types (Chrome and Edge can tell), for shortcuts with ⌥ on a Mac. */
export async function learnLayout(keyboard = (globalThis.navigator as { keyboard?: { getLayoutMap(): Promise<ReadonlyMap<string, string>> } } | undefined)?.keyboard) {
  layout = (await keyboard?.getLayoutMap().catch(() => null)) ?? null;
}

const SHIFTED: Record<string, string> = { ".": ">", ",": "<", "/": "?", ";": ":", "'": '"', "[": "{", "]": "}", "\\": "|", "-": "_", "=": "+", "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")" };
const UNSHIFTED: Record<string, string> = Object.fromEntries(Object.entries(SHIFTED).map(([key, shifted]) => [shifted, key]));
const US_CODE: Record<string, string> = { ".": "Period", ",": "Comma", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote" };
const usCode = (ch: string) => US_CODE[ch] ?? (/^[a-z]$/.test(ch) ? `Key${ch.toUpperCase()}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : null);
const ASCII = /^[\x20-\x7e]$/;

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"];

/** What a shortcut's modifiers hold down on one platform: Mod is ⌘ on a Mac and Ctrl elsewhere. A word that isn't a modifier holds nothing. */
function held(parts: readonly string[], mac: boolean) {
  const has = (m: string) => parts.includes(m);
  return { meta: has("Mod") && mac, ctrl: has("Ctrl") || (has("Mod") && !mac), alt: has("Alt"), unknown: parts.filter((p) => !MODIFIERS.includes(p)) };
}

/**
 * The key press a shortcut is on one platform, as matchKeys reads it, in one spelling ("ctrl-shift-."
 * for "Mod->" off a Mac): two shortcuts with the same chord are the same press there. Null for one with
 * a word that isn't a modifier ("Meta-s"), which matchKeys reads as no modifier at all.
 */
export function chord(keys: string, mac = IS_MAC): string | null {
  const parts = keys.split(/-(?=.)/);
  let last = parts.pop()!;
  const { meta, ctrl, alt, unknown } = held(parts, mac);
  if (unknown.length) return null;
  let shift = parts.includes("Shift");
  if (last.length === 1 && UNSHIFTED[last]) [last, shift] = [UNSHIFTED[last], true];
  return [meta && "meta", ctrl && "ctrl", alt && "alt", shift && "shift", last.length === 1 ? last.toLowerCase() : last].filter(Boolean).join("-");
}

/**
 * Whether a key press is the shortcut `keys`, such as "Mod-Shift-p". With `byPlace` false, only by the
 * character typed, not by what the layout map says the key types.
 */
export function matchKeys(e: KeyLike, keys: string, mac = IS_MAC, byPlace = true): boolean {
  const parts = keys.split(/-(?=.)/);
  const last = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  const { meta, ctrl, alt } = held(parts, mac);
  if (e.metaKey !== meta || e.ctrlKey !== ctrl || e.altKey !== alt) return false;
  // A shifted character without Shift ("Mod->"): that character typed, or its key with Shift ("Mod-Shift-."),
  // whichever the layout needs and whichever the browser reports.
  if (last.length === 1 && UNSHIFTED[last] && !has("Shift")) return e.key === last || (e.shiftKey && matchKeys(e, [...parts, "Shift", UNSHIFTED[last]].join("-"), mac, byPlace));
  if (e.shiftKey !== has("Shift")) return false;
  const want = last.length === 1 ? last.toLowerCase() : last;
  if (want.length > 1) return e.key === want;
  const typed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (typed === want || (e.shiftKey && typed === SHIFTED[want])) return true;
  if (!byPlace) return false;
  const plain = layout?.get(e.code);
  if (plain && ASCII.test(plain)) return plain.toLowerCase() === want;
  // No layout map, or a layout without Latin letters: the key where it is on a US keyboard.
  return ((e.altKey && mac) || !ASCII.test(typed)) && e.code === usCode(want);
}

const MAC_MOD: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const PC_MOD: Record<string, string> = { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
const KEY_NAMES: Record<string, string> = { Enter: "↵", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** "Mod-Shift-p" as ⌘⇧P on a Mac and Ctrl+Shift+P elsewhere. */
export function formatKeys(keys: string, mac = IS_MAC): string {
  const parts = keys.split(/-(?=.)/);
  const key = parts.pop()!;
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return mac ? parts.map((m) => MAC_MOD[m] ?? m).join("") + name : [...parts.map((m) => PC_MOD[m] ?? m), name].join("+");
}
