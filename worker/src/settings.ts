// Settings: JSON at two levels, user and workspace, over built-in defaults. Workspace settings override
// user settings. Every setting is declared once here, which gives the defaults, the published JSON
// Schema (/schema/settings.json) and the checks that tell you what in a settings file was ignored.
import { parseFilePath, type FilePath } from "./files.ts";

export interface Keybinding {
  key: string;
  /** The command to run, or null to unbind the key. */
  command: string | null;
}

interface Declared<T> {
  description: string;
  default: T;
  schema: Record<string, unknown>;
  check(value: unknown): value is T;
}

const bool = (description: string, value: boolean): Declared<boolean> => ({
  description,
  default: value,
  schema: { type: "boolean" },
  check: (v): v is boolean => typeof v === "boolean",
});

const int = (description: string, value: number, minimum: number, maximum: number): Declared<number> => ({
  description,
  default: value,
  schema: { type: "integer", minimum, maximum },
  check: (v): v is number => Number.isInteger(v) && (v as number) >= minimum && (v as number) <= maximum,
});

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: "Mod-p", command: "quickOpen" },
  { key: "Mod-Shift-p", command: "commandBar" },
  { key: "Mod-s", command: "note.save" },
  { key: "Mod-\\", command: "window.splitRight" },
];

const keybindings: Declared<Keybinding[]> = {
  description:
    'Keyboard shortcuts, added after the defaults; a later binding for the same key wins, and "command": null unbinds a key. Keys are matched by the character typed, like "Mod-Shift-p" (Mod is ⌘ on a Mac, Ctrl elsewhere).',
  default: DEFAULT_KEYBINDINGS,
  schema: {
    type: "array",
    items: {
      type: "object",
      properties: { key: { type: "string" }, command: { type: ["string", "null"] } },
      required: ["key", "command"],
      additionalProperties: false,
    },
  },
  check: (v): v is Keybinding[] =>
    Array.isArray(v) && v.every((b) => b && typeof b === "object" && typeof b.key === "string" && b.key !== "" && (typeof b.command === "string" || b.command === null)),
};

const strings = (description: string): Declared<string[]> => ({
  description,
  default: [],
  schema: { type: "array", items: { type: "string" } },
  check: (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"),
});

export const SETTINGS = {
  "editor.vim": bool("Vim keys in the editor.", true),
  "editor.lineNumbers": bool("Line numbers beside the text.", false),
  "editor.lineWrapping": bool("Wrap long lines to the window instead of scrolling sideways.", true),
  "editor.fontSize": int("The editor's text size, in pixels.", 16, 10, 32),
  "editor.saveDelay": int("Milliseconds after you stop typing before a note saves.", 1000, 200, 10000),
  keybindings,
  "plugins.disabled": strings('Plugins to turn off, by id, such as "history" or "commandBar.notes". Takes effect when the app reloads.'),
};

export type SettingName = keyof typeof SETTINGS;
export type Settings = { [K in SettingName]: (typeof SETTINGS)[K]["default"] };

export const DEFAULTS = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.default])) as Settings;

export const WORKSPACE_SETTINGS = parseFilePath(".common-ink/settings.json")!;
export const DEFAULT_SETTINGS = parseFilePath(".common-ink/defaults/settings.json")!;
export const userSettingsPath = (email: string) => parseFilePath(`.common-ink/users/${email}/settings.json`);

/** Files the app writes itself and nobody may edit: the defaults. */
export const isReadOnly = (path: FilePath) => path.startsWith(".common-ink/defaults/");

export const SCHEMA_URL = "/schema/settings.json";

export const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_URL,
  title: "Common Ink settings",
  type: "object",
  properties: {
    $schema: { type: "string" },
    ...Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, { ...d.schema, description: d.description, default: d.default }])),
  },
  additionalProperties: false,
};

/** The defaults as a read-only settings file. Each setting's description is in the schema. */
export function defaultsText(): string {
  return `${JSON.stringify({ $schema: SCHEMA_URL, ...DEFAULTS }, null, 2)}\n`;
}

export const SETTINGS_TEMPLATE = `{\n  "$schema": "${SCHEMA_URL}"\n}\n`;

/** One settings file's settings, and what in it was ignored and why. */
export function parseSettings(text: string): { settings: Partial<Settings>; problems: string[] } {
  if (!text.trim()) return { settings: {}, problems: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { settings: {}, problems: [`Not valid JSON: ${(err as Error).message}`] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { settings: {}, problems: ["Settings must be a JSON object"] };
  const settings: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "$schema") continue;
    const declared = (SETTINGS as Record<string, Declared<unknown>>)[key];
    if (!declared) problems.push(`Unknown setting "${key}"`);
    else if (!declared.check(value)) problems.push(`"${key}" must be ${JSON.stringify(declared.schema)}`);
    else settings[key] = value;
  }
  return { settings: settings as Partial<Settings>, problems };
}

/**
 * Defaults, then user settings, then workspace settings. Keybindings add up: the app's, then plugins',
 * then the user's, then the workspace's. The rest override.
 */
export function combine(user: Partial<Settings>, workspace: Partial<Settings>, pluginKeybindings: Keybinding[] = []): Settings {
  return {
    ...DEFAULTS,
    ...user,
    ...workspace,
    keybindings: [...DEFAULT_KEYBINDINGS, ...pluginKeybindings, ...(user.keybindings ?? []), ...(workspace.keybindings ?? [])],
  };
}
