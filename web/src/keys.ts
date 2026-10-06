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

/**
 * Whether a key press is the shortcut `keys`, such as "Mod-Shift-p". With `byPlace` false, only by the
 * character typed, not by what the layout map says the key types.
 */
export function matchKeys(e: KeyLike, keys: string, mac = IS_MAC, byPlace = true): boolean {
  const parts = keys.split(/-(?=.)/);
  const last = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  if (e.metaKey !== (has("Mod") && mac) || e.ctrlKey !== (has("Ctrl") || (has("Mod") && !mac)) || e.altKey !== has("Alt")) return false;
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
