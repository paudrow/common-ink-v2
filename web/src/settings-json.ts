// Help in a settings file's editor, from the same declarations as everything else about settings:
// completion for keys (with what each does) and for true/false and enum values, problems under the
// text, a description on hover, and a bar back to the settings editor.
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, showPanel } from "@codemirror/view";
import { CORE_CATALOG, schemaOf, settingProblem, type SettingsCatalog } from "../../worker/src/settings.ts";
import { topLevelKeys } from "./json-edit.ts";

interface Property {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  appliesAfterReload?: boolean;
}

/** Every setting in a catalog, as JSON Schema properties. */
const propertiesOf = (catalog: SettingsCatalog) => schemaOf(catalog).properties as Record<string, Property>;
const properties = (catalog: SettingsCatalog) => Object.entries(propertiesOf(catalog)).filter(([k]) => k !== "$schema");

/** What to put after a key when completing it: its default, or an empty list or object for anything bigger. */
function starter(p: Property): string {
  if (Array.isArray(p.default)) return "[]";
  if (p.default && typeof p.default === "object") return "{}";
  return JSON.stringify(p.default);
}

/** Completions at `pos`: setting names where a key goes, values where a value goes. Exported for tests. */
export function settingsCompletions(text: string, pos: number, catalog: SettingsCatalog = CORE_CATALOG): { from: number; to: number; options: Completion[] } | null {
  const propertyOf = (key: string) => propertiesOf(catalog)[key];
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  // A value: after `"key":`, on the same line.
  const valueMatch = /"([^"\n]+)"\s*:\s*("?[\w.-]*)$/.exec(before);
  if (valueMatch) {
    const p = propertyOf(valueMatch[1]);
    const values = p?.enum ?? (p?.type === "boolean" ? [true, false] : []);
    if (!values.length) return null;
    const from = pos - valueMatch[2].length;
    const to = valueMatch[2].startsWith('"') && after.startsWith('"') ? pos + 1 : pos;
    return { from, to, options: values.map((v) => ({ label: JSON.stringify(v), type: "constant", detail: v === p.default ? "default" : undefined })) };
  }
  // A key: after `{` or `,`, at the top level.
  const keyMatch = /("?)([\w.$-]*)$/.exec(before)!;
  const quoted = keyMatch[1] === '"';
  const start = pos - keyMatch[0].length;
  if (!/[{,]\s*$/.test(text.slice(0, start)) || depthAt(text, start) !== 1) return null;
  // What's typed after the quote is what the names are matched against; the quotes come with the pick.
  const from = pos - keyMatch[2].length;
  const to = quoted && after.startsWith('"') ? pos + 1 : pos;
  const used = keysIn(text);
  const options = properties(catalog)
    .filter(([k]) => !used.has(k))
    .map(([key, p]) => ({ label: key, type: "property", info: p.description, apply: `${quoted ? "" : '"'}${key}": ${starter(p)}` }));
  return { from, to, options };
}

/** The top-level keys in a settings file, even one half typed. */
function keysIn(text: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(i + 1))) keys.add(text.slice(start + 1, i));
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return keys;
}

/** How many brackets deep `pos` is, skipping strings. */
function depthAt(text: string, pos: number): number {
  let depth = 0;
  for (let i = 0; i < pos; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < pos && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return depth;
}

const complete = (catalog: () => SettingsCatalog) => (ctx: CompletionContext): CompletionResult | null => {
  const result = settingsCompletions(ctx.state.doc.toString(), ctx.pos, catalog());
  if (!result) return null;
  // Typing a bare word only completes when asked, so Vim's own keys and plain typing aren't interrupted.
  if (result.from === ctx.pos && !ctx.explicit && !/"$/.test(ctx.state.sliceDoc(result.from - 1, result.from))) return null;
  return { ...result, validFor: /^"?[\w.$-]*"?$/ };
};

/** The problems in a settings file: where it isn't JSON, and each setting that's unknown or wrong. Exported for tests. */
export function settingsProblems(text: string, syntaxErrors: number[] = [], catalog: SettingsCatalog = CORE_CATALOG): Array<{ from: number; to: number; message: string }> {
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
  } catch (err) {
    const at = syntaxErrors[0] ?? Math.max(0, text.length - 1);
    return [{ from: at, to: Math.min(text.length, at + 1), message: `Not valid JSON, so none of this file applies: ${(err as Error).message}` }];
  }
  const parsed = topLevelKeys(text);
  if (!parsed) return [{ from: 0, to: Math.min(text.length, 1), message: "Settings must be a JSON object" }];
  return parsed.keys.flatMap((k) => {
    const problem = settingProblem(k.key, JSON.parse(text.slice(k.valueStart, k.end)), catalog);
    if (!problem) return [];
    // An unknown key is marked on the key; a wrong value on the value.
    const unknown = !catalog.has(k.key);
    return [{ from: unknown ? k.start : k.valueStart, to: unknown ? k.valueStart : k.end, message: `${problem}. It's ignored.` }];
  });
}

const lint = (catalog: () => SettingsCatalog) =>
  linter(
    (view): Diagnostic[] => {
      const errors: number[] = [];
      syntaxTree(view.state).iterate({ enter: (n) => void (n.type.isError && errors.push(n.from)) });
      return settingsProblems(view.state.doc.toString(), errors, catalog()).map((p) => ({ ...p, severity: "warning" }));
    },
    { delay: 300 },
  );

const hover = (catalog: () => SettingsCatalog) => hoverTooltip((view, pos) => {
  const key = topLevelKeys(view.state.doc.toString())?.keys.find((k) => pos >= k.start && pos < k.valueStart);
  const p = key && propertiesOf(catalog())[key.key];
  if (!key || !p) return null;
  return {
    pos: key.start,
    end: key.valueStart,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "setting-hover";
      const title = document.createElement("code");
      title.textContent = key.key;
      const desc = document.createElement("p");
      desc.textContent = p.description ?? "";
      const def = document.createElement("p");
      def.className = "muted";
      def.textContent = `Default: ${JSON.stringify(p.default)}${p.appliesAfterReload ? ". Applies after reload." : ""}`;
      dom.append(title, desc, def);
      return { dom };
    },
  };
});

/** A bar above the text, back to the settings editor. */
function backToUi(openUi: () => void) {
  return showPanel.of(() => {
    const dom = document.createElement("div");
    dom.className = "settings-json-bar";
    const text = document.createElement("span");
    text.textContent = "This file is your settings. Hover a setting for what it does; Ctrl-Space lists them.";
    const button = document.createElement("button");
    button.textContent = "Open settings editor";
    button.addEventListener("click", openUi);
    dom.append(text, button);
    return { dom, top: true };
  });
}

/** Everything a settings file's editor gets. The defaults (read-only) get the hovers and the way back. */
export function settingsJson(opts: { readOnly: boolean; catalog: () => SettingsCatalog; openUi: () => void }): Extension {
  return [hover(opts.catalog), backToUi(opts.openUi), opts.readOnly ? [] : [autocompletion({ override: [complete(opts.catalog)], icons: false }), lint(opts.catalog)], theme];
}

const theme = EditorView.theme({
  ".settings-json-bar": { display: "flex", gap: "1rem", alignItems: "center", justifyContent: "space-between", padding: "0.3rem 1rem", fontFamily: "var(--prose)", fontSize: "0.85rem", color: "var(--muted)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-tooltip": { backgroundColor: "var(--bg)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: "6px", fontFamily: "var(--prose)", fontSize: "0.85rem" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--selection)", color: "var(--ink)" },
  ".cm-tooltip.cm-completionInfo": { maxWidth: "24rem", padding: "0.4rem 0.6rem" },
  ".setting-hover": { maxWidth: "24rem", padding: "0.4rem 0.6rem" },
  ".setting-hover p": { margin: "0.25rem 0 0" },
  ".setting-hover .muted": { color: "var(--muted)" },
});
