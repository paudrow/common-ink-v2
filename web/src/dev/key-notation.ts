// Keys written the way Vim writes them, for test levers to press (docs/TESTING.md): plain characters,
// and named or held keys in angle brackets, as in "jj>>", ":vs<CR>", "<C-w>l" or "<Mod-S-p>". The page's
// inspector presses them as events, and the probe CLI as a real keyboard. A "<" that doesn't start a
// name is just "<", so "<<" is two of them; "<lt>" is one.

/** One key press: what `KeyboardEvent.key` says, and the modifiers held. */
export interface KeyPress {
  key: string;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
}

const NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  cr: "Enter",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  bs: "Backspace",
  backspace: "Backspace",
  del: "Delete",
  delete: "Delete",
  space: " ",
  lt: "<",
  gt: ">",
  bar: "|",
  bslash: "\\",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

const TOKEN = /^<((?:[CSMADcsmad]|Mod|mod)-)*([^<>\s-]+|-)>/;

/**
 * The presses a sequence spells. `mac` decides what <Mod-…> holds: ⌘ on a Mac, Ctrl elsewhere, as the
 * app's own shortcuts do. Throws on a name it doesn't know, so a typo can't type its letters instead.
 */
export function parseKeys(seq: string, mac: boolean): KeyPress[] {
  const out: KeyPress[] = [];
  for (let i = 0; i < seq.length; ) {
    const m = seq[i] === "<" ? TOKEN.exec(seq.slice(i)) : null;
    // "<x>" with nothing held isn't a name: it's three characters.
    if (!m || (m[2].length === 1 && m[0].length === 3)) {
      const ch = seq[i];
      out.push({ key: ch, ctrl: false, alt: false, meta: false, shift: ch !== ch.toLowerCase() });
      i++;
      continue;
    }
    const mods = m[0].slice(1, -1 - m[2].length).split("-").filter(Boolean).map((x) => x.toLowerCase());
    const name = m[2];
    const key = name.length === 1 ? name : NAMED[name.toLowerCase()];
    if (!key) throw new Error(`No key called <${name}> in "${seq}"`);
    const shift = mods.includes("s");
    out.push({
      key: shift && key.length === 1 ? key.toUpperCase() : key,
      ctrl: mods.includes("c") || (mods.includes("mod") && !mac),
      alt: mods.includes("m") || mods.includes("a"),
      meta: mods.includes("d") || (mods.includes("mod") && mac),
      shift,
    });
    i += m[0].length;
  }
  return out;
}

/** A press as Playwright's keyboard.press names it: "Control+w", "Shift+Tab", "Escape", ">". */
export function playwrightKey(k: KeyPress): string {
  const name = k.key === " " ? "Space" : k.key;
  const mods = [k.ctrl && "Control", k.alt && "Alt", k.meta && "Meta", k.shift && (k.key.length > 1 || /[A-Z]/.test(k.key)) && "Shift"].filter(Boolean);
  return [...mods, name].join("+");
}
