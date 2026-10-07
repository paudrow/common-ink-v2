// Settings: JSON at two levels, user and workspace, over built-in defaults. Workspace settings override
// user settings. The app's own settings are declared once here, and each extension declares its own
// in its manifest (contributes.configuration). Together they make a catalog, which gives the
// defaults, the JSON Schema, the settings editor's sections and the checks that tell you what in a
// settings file was ignored.
import { isRecordPath } from "./records.ts";
import type { ExtensionManifest, SettingSchema } from "./extensions.ts";
import { parseFilePath, type FilePath } from "./files.ts";

export interface Keybinding {
  key: string;
  /** The command to run, or null to unbind the key. */
  command: string | null;
  /** Declared by a sandboxed extension: its command runs for it, not for the app (commands.ts, appOnly). */
  by?: Sandboxed;
}

/** A sandboxed extension, by its name, that a command runs for: an app-only one refuses (commands.ts). */
export interface Sandboxed {
  sandbox: string;
}

interface Declared<T> {
  description: string;
  default: T;
  schema: Record<string, unknown>;
  /** What a good value is, in words, for problems: "true or false". */
  expects: string;
  /** A change only takes effect when the app reloads. */
  reload?: true;
  check(value: unknown): value is T;
}

const bool = (description: string, value: boolean): Declared<boolean> => ({
  description,
  default: value,
  schema: { type: "boolean" },
  expects: "true or false",
  check: (v): v is boolean => typeof v === "boolean",
});

const int = (description: string, value: number, minimum: number, maximum: number): Declared<number> => ({
  description,
  default: value,
  schema: { type: "integer", minimum, maximum },
  expects: `a whole number from ${minimum} to ${maximum}`,
  check: (v): v is number => Number.isInteger(v) && (v as number) >= minimum && (v as number) <= maximum,
});

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { key: "Mod-k", command: "quickOpen" },
  { key: "Mod-p", command: "quickOpen" },
  { key: "Mod-Shift-p", command: "commandBar" },
  { key: "Mod-s", command: "note.save" },
  { key: "Mod-,", command: "settings.user" },
  { key: "Mod-[", command: "go.back" },
  { key: "Mod-]", command: "go.forward" },
];

const keybindings: Declared<Keybinding[]> = {
  description:
    'Keyboard shortcuts, added after the defaults; a later binding for the same key wins, and "command": null unbinds a key. Keys are matched by the character typed, like "Mod-Shift-p" (Mod is ⌘ on a Mac, Ctrl elsewhere).',
  default: DEFAULT_KEYBINDINGS,
  expects: 'a list of bindings like {"key": "Mod-k", "command": "quickOpen"}',
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
  expects: "a list of strings",
  check: (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string"),
});

/** Your answers to extensions' permission prompts: extension id, then what it asked for, then "allow" or "deny". */
const answers: Declared<Record<string, Record<string, "allow" | "deny">>> = {
  description: 'Your answers when extensions ask for permissions, by extension: what it asked for, like "network:api.weather.gov", and "allow" or "deny". Delete an answer to be asked again.',
  default: {},
  schema: { type: "object", additionalProperties: { type: "object", additionalProperties: { enum: ["allow", "deny"] } } },
  expects: 'answers by extension, like {"weather": {"network:api.weather.gov": "allow"}}',
  check: (v): v is Record<string, Record<string, "allow" | "deny">> =>
    !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((a) => !!a && typeof a === "object" && !Array.isArray(a) && Object.values(a).every((x) => x === "allow" || x === "deny")),
};

export const SETTINGS = {
  "editor.lineNumbers": bool("Line numbers beside the text.", false),
  "editor.lineWrapping": bool("Wrap long lines to the window instead of scrolling sideways.", true),
  "editor.fontSize": int("The editor's text size, in pixels.", 16, 10, 32),
  "editor.livePreview": bool("Show markdown as it reads: headings, emphasis and links drawn, tasks as checkboxes, images shown. The line you're on always shows its raw text.", true),
  "editor.saveDelay": int("Milliseconds after you stop typing before a note saves.", 1000, 200, 10000),
  keybindings,
  "trash.retentionDays": int("Days a deleted note stays in Trash, where you can restore it, before it's purged: its text is taken out of history. A workspace setting.", 30, 1, 3650),
  "extensions.disabled": { ...strings('Extensions to turn off, by id, such as "history" or "quick-open".'), reload: true as const },
  "extensions.trusted": {
    ...strings("Workspace extensions you trust to run in the app's page, by id. A trusted extension can change note editors and draw straight into the page, and it can get around the permissions it asks for. Everything else runs sandboxed."),
    reload: true as const,
  },
  "extensions.permissions": answers,
  "extensions.catalogs": {
    ...strings("Other catalogs for the Extensions view to list, by the address of each one's index.json. They list other people's extensions: these run sandboxed, but you install them at your own risk."),
    reload: true as const,
  },
};

export type SettingName = keyof typeof SETTINGS;
/** The app's settings, typed, and any extension's, by key. */
export type Settings = { [K in SettingName]: (typeof SETTINGS)[K]["default"] } & { readonly [key: string]: unknown };

/** One setting, wherever it's declared: the app's own, or an extension's. */
export interface SettingDeclaration {
  key: string;
  /** Where the settings editor lists it: a section of the app's, or the extension's title. */
  section: string;
  /** The extension that declares it, if it isn't the app's. */
  extension?: string;
  description: string;
  default: unknown;
  /** The value's JSON Schema. */
  schema: Record<string, unknown>;
  /** What a good value is, in words, for problems: "true or false". */
  expects: string;
  /** A change only takes effect when the app reloads. */
  reload: boolean;
  check(value: unknown): boolean;
}

/** Every setting there is, by key. */
export type SettingsCatalog = ReadonlyMap<string, SettingDeclaration>;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const CORE: SettingDeclaration[] = Object.entries(SETTINGS as Record<string, Declared<unknown>>).map(([key, d]) => ({
  key,
  section: capitalize(key.split(".")[0]),
  description: d.description,
  default: d.default,
  schema: d.schema,
  expects: d.expects,
  reload: !!d.reload,
  check: d.check,
}));

/** Whether a value fits a setting's schema: its type, enum and limits. Enough JSON Schema for settings. */
export function fitsSchema(schema: SettingSchema, value: unknown): boolean {
  if (schema.enum && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return false;
      return !(value < (schema.minimum ?? -Infinity)) && !(value > (schema.maximum ?? Infinity));
    case "array":
      return Array.isArray(value) && (!schema.items || value.every((v) => fitsSchema({ type: schema.items!.type }, v)));
    case "object":
      return !!value && typeof value === "object" && !Array.isArray(value);
  }
}

/** A schema's good values, in words. */
export function describeSchema(schema: SettingSchema): string {
  if (schema.enum) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (schema.type === "boolean") return "true or false";
  if (schema.type === "integer" || schema.type === "number") {
    const what = schema.type === "integer" ? "a whole number" : "a number";
    if (schema.minimum !== undefined && schema.maximum !== undefined) return `${what} from ${schema.minimum} to ${schema.maximum}`;
    if (schema.minimum !== undefined) return `${what} of at least ${schema.minimum}`;
    if (schema.maximum !== undefined) return `${what} of at most ${schema.maximum}`;
    return what;
  }
  if (schema.type === "array") return schema.items ? `a list of ${schema.items.type}s` : "a list";
  return schema.type === "string" ? "text" : "an object";
}

/** The catalog: the app's settings, then each extension's, in the section named for it. */
export function settingsCatalog(extensions: readonly ExtensionManifest[] = []): SettingsCatalog {
  const all = new Map(CORE.map((d) => [d.key, d]));
  for (const m of extensions) {
    const conf = m.contributes.configuration;
    if (!conf) continue;
    for (const [key, schema] of Object.entries(conf.properties)) {
      if (all.has(key)) continue;
      const { description = "", default: value, appliesAfterReload, ...rest } = schema;
      all.set(key, {
        key,
        section: conf.title || m.name,
        extension: m.id,
        description,
        default: value ?? null,
        schema: rest as Record<string, unknown>,
        expects: describeSchema(schema),
        reload: !!appliesAfterReload,
        check: (v) => fitsSchema(schema, v),
      });
    }
  }
  return all;
}

export const CORE_CATALOG = settingsCatalog();

export const DEFAULTS = Object.fromEntries(Object.entries(SETTINGS).map(([k, d]) => [k, d.default])) as Settings;

/** Every setting's default, extensions' included. */
export const defaultsOf = (catalog: SettingsCatalog) => Object.fromEntries([...catalog.values()].map((d) => [d.key, d.default])) as Settings;

export const WORKSPACE_SETTINGS = parseFilePath(".common-ink/settings.json")!;
export const DEFAULT_SETTINGS = parseFilePath(".common-ink/defaults/settings.json")!;
export const userSettingsPath = (email: string) => parseFilePath(`.common-ink/users/${email}/settings.json`);

/** Files the app writes itself and nobody may edit: the defaults. */
/** Files only Common Ink writes: the default settings, and data sources' records, which change through their source. */
export const isReadOnly = (path: FilePath) => path.startsWith(".common-ink/defaults/") || isRecordPath(path);

export const SCHEMA_URL = "/schema/settings.json";

/** A catalog as one JSON Schema, as editors outside the app and the JSON editor's help read it. */
export function schemaOf(catalog: SettingsCatalog) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URL,
    title: "Common Ink settings",
    type: "object",
    properties: {
      $schema: { type: "string" },
      ...Object.fromEntries([...catalog.values()].map((d) => [d.key, { ...d.schema, description: d.description, default: d.default, ...(d.reload ? { appliesAfterReload: true } : {}) }])),
    },
    additionalProperties: false,
  };
}

/** The app's own settings' schema, published at /schema/settings.json. */
export const schema = schemaOf(CORE_CATALOG);

/** The defaults as a read-only settings file. Each setting's description is in the schema. */
export function defaultsText(): string {
  return `${JSON.stringify({ $schema: SCHEMA_URL, ...DEFAULTS }, null, 2)}\n`;
}

export const SETTINGS_TEMPLATE = `{\n  "$schema": "${SCHEMA_URL}"\n}\n`;

/** Settings that became something else, and where to find it now. */
const MOVED: Record<string, string> = {
  "editor.vim": '"editor.vim" is gone: Vim keys are the Vim extension now. Turn it off in the Extensions view, or add "vim" to "extensions.disabled".',
};

/** What's wrong with one setting in a settings file, or null if it's fine. */
export function settingProblem(key: string, value: unknown, catalog: SettingsCatalog = CORE_CATALOG): string | null {
  if (key === "$schema") return null;
  const declared = catalog.get(key);
  if (!declared) return MOVED[key] ?? `Unknown setting "${key}"`;
  return declared.check(value) ? null : `"${key}" must be ${declared.expects}`;
}

/** One settings file's settings, and what in it was ignored and why. `broken` if none of it could be read. */
export function parseSettings(text: string, catalog: SettingsCatalog = CORE_CATALOG): { settings: Partial<Settings>; problems: string[]; broken?: true } {
  if (!text.trim()) return { settings: {}, problems: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { settings: {}, problems: [`Not valid JSON: ${(err as Error).message}`], broken: true };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { settings: {}, problems: ["Settings must be a JSON object"], broken: true };
  const settings: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "$schema") continue;
    const problem = settingProblem(key, value, catalog);
    if (problem) problems.push(problem);
    else settings[key] = value;
  }
  return { settings: settings as Partial<Settings>, problems };
}

/**
 * Defaults, then user settings, then workspace settings. Keybindings add up: the app's, then
 * extensions', then the user's, then the workspace's. The rest override.
 */
export function combine(user: Partial<Settings>, workspace: Partial<Settings>, extensionKeybindings: Keybinding[] = [], catalog: SettingsCatalog = CORE_CATALOG): Settings {
  return {
    ...defaultsOf(catalog),
    ...user,
    ...workspace,
    keybindings: [...DEFAULT_KEYBINDINGS, ...extensionKeybindings, ...(user.keybindings ?? []), ...(workspace.keybindings ?? [])],
  } as Settings;
}
