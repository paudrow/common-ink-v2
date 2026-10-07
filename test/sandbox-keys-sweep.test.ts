// Verifier's sweep for #84: every press the app, a built-in, the editor or Vim takes, on a Mac and off
// one, against a sandboxed extension binding the same press in every spelling it can write.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseManifest, type ExtensionManifest } from "../worker/src/extensions.ts";
import type { FilePath, FileSummary, WorkspaceFile } from "../worker/src/files.ts";
import { DEFAULT_KEYBINDINGS } from "../worker/src/settings.ts";
import { editorKeys } from "../web/src/editor.ts";
import { ExtensionHost, type BuiltIn } from "../web/src/extension-host.ts";
import { matchKeys, type KeyLike } from "../web/src/keys.ts";

const builtIns: BuiltIn[] = readdirSync("web/src/extensions", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    try {
      const m = parseManifest(readFileSync(`web/src/extensions/${d.name}/extension.json`, "utf8"), d.name);
      return typeof m === "string" ? [] : [{ manifest: m, load: async () => ({ activate() {} }), files: [], source: async () => "", copy: async () => ({}), folder: "" } as unknown as BuiltIn];
    } catch {
      return [];
    }
  });

const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const PUNCT = [".", ",", "/", ";", "'", "[", "]", "\\", "-", "=", "`"];
const SHIFTED: Record<string, string> = { ".": ">", ",": "<", "/": "?", ";": ":", "'": '"', "[": "{", "]": "}", "\\": "|", "-": "_", "=": "+", "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")" };
const NAMED = ["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
const CODE: Record<string, string> = { ".": "Period", ",": "Comma", "/": "Slash", ";": "Semicolon", "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal", "`": "Backquote" };

/** Every press: each key with each set of modifiers, as a browser reports it. */
function presses(): KeyLike[] {
  const out: KeyLike[] = [];
  for (let bits = 0; bits < 16; bits++) {
    const [metaKey, ctrlKey, altKey, shiftKey] = [1, 2, 4, 8].map((b) => !!(bits & b));
    for (const k of [...LETTERS, ...PUNCT, ...NAMED]) {
      const code = CODE[k] ?? (/^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k);
      const key = k.length > 1 ? k : shiftKey ? (SHIFTED[k] ?? k.toUpperCase()) : k;
      out.push({ key, code, metaKey, ctrlKey, altKey, shiftKey });
    }
  }
  return out;
}

/** Every way to write a shortcut a manifest might try: modifiers in any spelling and order, the key in any case or shifted form. */
function spellings(): string[] {
  const mods = ["Mod", "Ctrl", "Alt", "Shift", "Cmd", "Meta", "mod", "ctrl", "alt", "shift", "Control", "Option", "c", "m", "a", "s"];
  const lasts = [...LETTERS, ...LETTERS.map((l) => l.toUpperCase()), ...PUNCT, ...Object.values(SHIFTED), ...NAMED, ...NAMED.map((n) => n.toLowerCase())];
  const sets: string[][] = [[]];
  for (const m of mods) for (const s of [...sets]) if (s.length < 3) sets.push([...s, m]);
  const out = new Set<string>();
  for (const s of sets) for (const l of lasts) {
    out.add([...s, l].join("-"));
    out.add([...[...s].reverse(), l].join("-"));
  }
  return [...out];
}

/** Vim's own Ctrl keys in normal and insert mode, which the user's Vim takes when the editor has focus. */
const VIM_CTRL = ["o", "i", "r", "d", "u", "f", "b", "e", "y", "v", "w", "a", "x", "n", "p", "h", "[", "c", "t", "g", "j", "k", "l", "m", "q", "z", "]", "^"].map((k) => `Ctrl-${k}`);

test("sweep: no spelling a sandboxed extension may bind lands on a press the app, a built-in or the editor takes, on either platform", { timeout: 600_000 }, async () => {
  const all = spellings();
  const keybindings = all.map((key) => ({ key, command: "hog.go" }));
  const files: FileSummary[] = [{ path: ".common-ink/extensions/hog/extension.json" as FilePath, revision: 1 } as FileSummary];
  const text = JSON.stringify({ name: "Hog", contributes: { commands: [{ command: "hog.go", title: "Go" }], keybindings } });
  const h = new ExtensionHost({ context: () => ({}) as never, load: async () => ({}), sandbox: async () => {}, changed: () => {}, app: () => ({ ids: ["note.save", "settings.user"], keys: editorKeys }) });
  await h.load(builtIns, files, async (path) => ({ path, text, revision: 1 }) as WorkspaceFile, [], false, []);
  const hog = h.records.find((r) => r.id === "hog")!.manifest as ExtensionManifest;
  const kept = hog.contributes.keybindings.flatMap((k) => ("key" in k ? [k.key] : []));
  const builtInKeys = builtIns.flatMap((b) => b.manifest.contributes.keybindings.flatMap((k) => ("key" in k ? [k.key] : [])));
  const found: string[] = [];
  const vim: string[] = [];
  for (const mac of [true, false]) {
    const taken = [...DEFAULT_KEYBINDINGS.map((k) => k.key), ...builtInKeys, ...editorKeys(mac)];
    for (const e of presses()) {
      const appKey = taken.find((t) => matchKeys(e, t, mac, false));
      const vimKey = VIM_CTRL.find((t) => matchKeys(e, t, mac, false));
      if (!appKey && !vimKey) continue;
      const ext = kept.find((k) => matchKeys(e, k, mac, false) || matchKeys(e, k, mac, true));
      if (!ext) continue;
      const what = `${mac ? "Mac" : "other"}: ${JSON.stringify(ext)} takes ${appKey ?? vimKey}`;
      if (appKey) found.push(what);
      else vim.push(what);
    }
  }
  console.log(`kept ${kept.length} of ${all.length} spellings; e.g. ${kept.slice(0, 8).join(", ")}`);
  console.log(`Vim Ctrl keys a sandboxed extension takes: ${[...new Set(vim)].join("; ")}`);
  assert.deepEqual([...new Set(found)], [], "app, built-in or editor presses a sandboxed extension takes");
  assert.deepEqual([...new Set(vim)], [], "Vim's Ctrl keys a sandboxed extension takes");
});
