// Extensions: what each one is and adds, declared in its extension.json (ADR 0006). The app reads the
// manifests to list commands, keybindings, menus, settings, views, embeds and more before any
// extension code runs, and starts an extension's code only when one of its activation events happens.
// Built-ins ship with the same files. A workspace extension is a folder of files in the workspace,
// .common-ink/extensions/<id>/, edited and kept in history like any note.
import { WIDTH_CLASSES, type Requires, type WidthClass } from "./devices.ts";
import type { FilePath } from "./files.ts";

export const EXTENSIONS_DIR = ".common-ink/extensions/";

/** An extension's id: its folder's name. Letters, digits, dots, dashes and underscores. */
export const EXTENSION_ID = /^[a-zA-Z0-9][\w.-]{0,63}$/;

export const manifestPath = (id: string) => `${EXTENSIONS_DIR}${id}/extension.json` as FilePath;
export const extensionFilePath = (id: string, file: string) => `${EXTENSIONS_DIR}${id}/${file}` as FilePath;

/** Where an extension keeps its state (ctx.state): its own, always writable, and not part of its code. */
export const STATE_FILE = "state.json";
export const statePath = (id: string) => extensionFilePath(id, STATE_FILE);

/** A workspace extension's file, by path: its folder's id and the file's path inside it. */
export function extensionFileOf(path: string): { id: string; file: string } | null {
  const m = /^\.common-ink\/extensions\/([a-zA-Z0-9][\w.-]{0,63})\/(.+)$/.exec(path);
  if (!m || m[2].split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  return { id: m[1], file: m[2] };
}

export type ActivationEvent = "onStartup" | `onCommand:${string}` | `onView:${string}` | `onEmbed:${string}` | `onUrlEmbed:${string}`;

/**
 * What an extension may ask for, beyond running and drawing: the most it can ever get. Each comes with
 * a "why", shown when it asks, as iOS shows an app's usage descriptions. Asking happens the first time
 * it's used; your answer is kept in settings ("extensions.permissions"), where you can see and change it.
 */
export type PermissionKind =
  | "network"
  | "files:read"
  | "files:write"
  | "clipboard:read"
  | "clipboard:write"
  | "notifications"
  | "media"
  | "history:read"
  /** Data sources' records (ADR 0007): reading and changing calendar events, reading contacts. */
  | "data:calendar:read"
  | "data:calendar:write"
  | "data:contacts:read"
  | "settings:write"
  /** CodeMirror extensions in note editors: decorations, keys, live preview. Trusted extensions only. */
  | "editor";

export const PERMISSION_KINDS: readonly PermissionKind[] = [
  "network",
  "files:read",
  "files:write",
  "clipboard:read",
  "clipboard:write",
  "notifications",
  "media",
  "history:read",
  "data:calendar:read",
  "data:calendar:write",
  "data:contacts:read",
  "settings:write",
  "editor",
];

/** Whether a kind of permission is declared with a scope: hosts, paths or setting keys. */
export const needsScope = (kind: PermissionKind) => kind === "network" || kind === "files:read" || kind === "files:write" || kind === "settings:write";

/** One declared permission: why it's wanted and, for network and files, how far it reaches. */
export interface PermissionRequest {
  why: string;
  /** network: the hosts it may reach, like "api.weather.gov" or "*.example.com". */
  hosts?: string[];
  /** files:read and files:write: the paths it may touch, as globs like "Journal/**". */
  paths?: string[];
  /** settings:write: settings outside its own section it may change. */
  keys?: string[];
}

export type Permissions = Partial<Record<PermissionKind, PermissionRequest>>;

const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export interface CommandContribution {
  command: string;
  title: string;
  /** What it needs from the device; off there, it's listed greyed, with why. */
  requires?: Requires;
}

/** A default shortcut for a command: a key ("Mod-Enter") or a Vim normal-mode sequence ("gx"). Settings can rebind it. */
/**
 * A key, or a Vim sequence, that runs a command. A Vim key with "operator": true replaces Vim's operator
 * of that key (">", say): the command runs on the lines a motion covers (>>, >j, >ip) or the visual selection.
 */
export type KeybindingContribution = { key: string; command: string } | { vim: string; command: string; operator?: true };

export type MenuId = "commandBar" | "tabMenu" | "editorContext" | "quickOpen";

export interface MenuContribution {
  command: string;
}

/** One setting, as a JSON Schema: type, default, description and limits. */
export interface SettingSchema {
  type: "boolean" | "integer" | "number" | "string" | "array" | "object";
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: { type: "string" | "number" | "integer" | "boolean" };
  appliesAfterReload?: boolean;
}

/** An extension's settings: one section in the settings editor, under its title. */
export interface ConfigurationContribution {
  title: string;
  properties: Record<string, SettingSchema>;
}

export interface ViewContainerContribution {
  id: string;
  title: string;
  /** One of the app's icons, by name. */
  icon?: string;
}

export interface ViewContribution {
  id: string;
  name: string;
  requires?: Requires;
}

export interface StatusBarItemContribution {
  id: string;
  alignment: "left" | "right";
  priority: number;
  /** The command a click runs. */
  command?: string;
}

/**
 * How an embed is written in a note: a leaf directive on a line of its own (`::timer{duration=25m}`),
 * a container directive around markdown (`:::kanban` … `:::`), or a fenced block around code.
 */
export type EmbedSyntax = "leaf" | "container" | "fence";

export const EMBED_SYNTAXES: readonly EmbedSyntax[] = ["leaf", "container", "fence"];

/** One of an embed's arguments: its type and what it means, and how its settings form offers it. */
export interface EmbedArgument {
  type: "string" | "number" | "duration" | "boolean";
  description: string;
  default?: string;
  /** Its name in the settings form; the key, capitalized, if it doesn't say. */
  label?: string;
  /** The values it may take, offered as a choice. */
  enum?: string[];
  /** Values offered in one click (durations: 5m, 25m, 1h). */
  presets?: string[];
  /** Kept as it is, and not in the settings form: an `id`. */
  hidden?: boolean;
}

/** An embed in notes, named `language`, drawn by the extension in place of its markdown. */
export interface EmbedContribution {
  language: string;
  title: string;
  description: string;
  syntax: EmbedSyntax;
  /** Its key=value arguments, each with its type and what it means. */
  arguments: Record<string, EmbedArgument>;
  /** What the block's body holds, if anything: a container's markdown, or a fence's code. */
  body?: string;
  requires?: Requires;
}

const ARGUMENT_TYPES = ["string", "number", "duration", "boolean"];

/** A URL alone on its own line, drawn as an embed. */
/** A link alone on its own line, drawn as an embed: the first contribution whose pattern matches draws it. */
export interface UrlEmbedContribution {
  /** Names it, for its activation event (onUrlEmbed:<id>) and ctx.urlEmbeds.register. */
  id: string;
  /** A regular expression the URL must match (its groups are passed to the drawing). */
  pattern: string;
  title: string;
  /** Hosts the embed's frame loads from: the app's frame-src allows these only while the extension is on. */
  frameHosts: string[];
}

/**
 * A data source the extension shows (ADR 0007): records of one kind from outside the workspace. The
 * sync that fills it runs in the Worker; the extension draws its views and embeds from its records.
 */
export interface DataSourceContribution {
  id: string;
  kind: "calendar" | "contacts";
  title: string;
  description?: string;
}

/**
 * A part of the windows' layout an extension draws, and what it needs from the device: the Workbench's
 * "tabs" and "splits". Where it isn't met, the part is put away (the layout keeps it), and it's back when it is.
 */
export interface LayoutContribution {
  id: string;
  title: string;
  requires?: Requires;
}

export interface Contributions {
  commands: CommandContribution[];
  keybindings: KeybindingContribution[];
  menus: Partial<Record<MenuId, MenuContribution[]>>;
  configuration: ConfigurationContribution | null;
  viewsContainers: { activitybar: ViewContainerContribution[]; panel: ViewContainerContribution[] };
  /** Views, by the container they start in. */
  views: Record<string, ViewContribution[]>;
  statusBarItems: StatusBarItemContribution[];
  embeds: EmbedContribution[];
  urlEmbeds: UrlEmbedContribution[];
  dataSources: DataSourceContribution[];
  layout: LayoutContribution[];
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Who made it, as its prompts and details say. */
  publisher?: string;
  /** The module that's started, relative to the folder. */
  main: string;
  /** Every file the extension is made of, for copying it: main and what main imports. */
  files: string[];
  activationEvents: ActivationEvent[];
  permissions: Permissions;
  /** What it needs from the device to start there (devices.ts). Off on a device that hasn't it, unless you turn it on there. */
  requires?: Requires;
  contributes: Contributions;
}

type Json = Record<string, unknown>;

class ManifestError extends Error {}

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function text(v: unknown, what: string, optional = false): string {
  if (v === undefined && optional) return "";
  if (typeof v !== "string" || (!optional && !v.trim())) throw new ManifestError(`${what} must be text`);
  return v;
}

function list<T>(v: unknown, what: string, each: (item: unknown, at: string) => T): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ManifestError(`${what} must be a list`);
  return v.map((item, i) => each(item, `${what}[${i}]`));
}

function object(v: unknown, what: string): Json {
  if (!isObject(v)) throw new ManifestError(`${what} must be an object`);
  return v;
}

const relativeFile = (v: unknown, what: string, typescript = false) => {
  const file = text(v, what);
  const kinds = typescript ? /\.(js|ts|json)$/ : /\.(js|json)$/;
  if (!kinds.test(file) || file.startsWith("/") || file.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new ManifestError(`${what} must be a file in the extension's folder, like "index.js"`);
  }
  return file;
};

/** What something needs from a device: `{ "keyboard": true, "width": "medium", "pointer": "fine" }`, any of them. */
function requires(v: unknown, at: string): { requires?: Requires } {
  if (v === undefined) return {};
  const o = object(v, at);
  const out: Requires = {};
  for (const [k, value] of Object.entries(o)) {
    if (k === "keyboard" && value === true) out.keyboard = true;
    else if (k === "width" && WIDTH_CLASSES.includes(value as WidthClass)) out.width = value as WidthClass;
    else if (k === "pointer" && value === "fine") out.pointer = "fine";
    else throw new ManifestError(`${at}.${k} isn't something a device has: "keyboard": true, "width": one of ${WIDTH_CLASSES.join(", ")}, or "pointer": "fine"`);
  }
  return Object.keys(out).length ? { requires: out } : {};
}

const SETTING_TYPES = new Set(["boolean", "integer", "number", "string", "array", "object"]);

function setting(v: unknown, at: string): SettingSchema {
  const s = object(v, at);
  if (!SETTING_TYPES.has(s.type as string)) throw new ManifestError(`${at}.type must be one of ${[...SETTING_TYPES].join(", ")}`);
  return s as unknown as SettingSchema;
}

function contributions(v: unknown, id: string): Contributions {
  const c = v === undefined ? {} : object(v, "contributes");
  const container = (item: unknown, at: string): ViewContainerContribution => {
    const o = object(item, at);
    return { id: text(o.id, `${at}.id`), title: text(o.title, `${at}.title`), ...(typeof o.icon === "string" ? { icon: o.icon } : {}) };
  };
  const menus: Contributions["menus"] = {};
  for (const [menu, items] of Object.entries(c.menus === undefined ? {} : object(c.menus, "contributes.menus"))) {
    if (!["commandBar", "tabMenu", "editorContext", "quickOpen"].includes(menu)) throw new ManifestError(`contributes.menus.${menu} isn't a menu (commandBar, tabMenu, editorContext, quickOpen)`);
    menus[menu as MenuId] = list(items, `contributes.menus.${menu}`, (item, at) => ({ command: text(object(item, at).command, `${at}.command`) }));
  }
  let configuration: ConfigurationContribution | null = null;
  if (c.configuration !== undefined) {
    const conf = object(c.configuration, "contributes.configuration");
    const properties: Record<string, SettingSchema> = {};
    for (const [key, schema] of Object.entries(object(conf.properties ?? {}, "contributes.configuration.properties"))) {
      // An extension's settings are named for it, so two extensions can't claim the same one.
      if (!key.startsWith(`${id}.`)) throw new ManifestError(`Setting "${key}" must start with "${id}."`);
      properties[key] = setting(schema, `contributes.configuration.properties["${key}"]`);
    }
    configuration = { title: text(conf.title, "contributes.configuration.title", true), properties };
  }
  const containers = c.viewsContainers === undefined ? {} : object(c.viewsContainers, "contributes.viewsContainers");
  const views: Record<string, ViewContribution[]> = {};
  for (const [container, items] of Object.entries(c.views === undefined ? {} : object(c.views, "contributes.views"))) {
    views[container] = list(items, `contributes.views.${container}`, (item, at) => {
      const o = object(item, at);
      return { id: text(o.id, `${at}.id`), name: text(o.name, `${at}.name`), ...requires(o.requires, `${at}.requires`) };
    });
  }
  return {
    commands: list(c.commands, "contributes.commands", (item, at) => {
      const o = object(item, at);
      return { command: text(o.command, `${at}.command`), title: text(o.title, `${at}.title`), ...requires(o.requires, `${at}.requires`) };
    }),
    keybindings: list(c.keybindings, "contributes.keybindings", (item, at) => {
      const o = object(item, at);
      const command = text(o.command, `${at}.command`);
      if (typeof o.key === "string" && o.key) return { key: o.key, command };
      if (typeof o.vim === "string" && o.vim) return { vim: o.vim, command, ...(o.operator === true ? { operator: true as const } : {}) };
      throw new ManifestError(`${at} needs a "key" or a "vim" sequence`);
    }),
    menus,
    configuration,
    viewsContainers: {
      activitybar: list(containers.activitybar, "contributes.viewsContainers.activitybar", container),
      panel: list(containers.panel, "contributes.viewsContainers.panel", container),
    },
    views,
    statusBarItems: list(c.statusBarItems, "contributes.statusBarItems", (item, at) => {
      const o = object(item, at);
      return {
        id: text(o.id, `${at}.id`),
        alignment: o.alignment === "left" ? "left" : "right",
        priority: typeof o.priority === "number" ? o.priority : 0,
        ...(typeof o.command === "string" ? { command: o.command } : {}),
      };
    }),
    layout: list(c.layout, "contributes.layout", (item, at) => {
      const o = object(item, at);
      return { id: text(o.id, `${at}.id`), title: text(o.title, `${at}.title`), ...requires(o.requires, `${at}.requires`) };
    }),
    dataSources: list(c.dataSources, "contributes.dataSources", (item, at) => {
      const o = object(item, at);
      if (o.kind !== "calendar" && o.kind !== "contacts") throw new ManifestError(`${at}.kind must be calendar or contacts`);
      return { id: text(o.id, `${at}.id`), kind: o.kind, title: text(o.title, `${at}.title`), ...(typeof o.description === "string" ? { description: o.description } : {}) };
    }),
    embeds: list(c.embeds, "contributes.embeds", (item, at) => {
      const o = object(item, at);
      const language = text(o.language, `${at}.language`);
      if (!/^[a-z][a-z0-9-]*$/.test(language)) throw new ManifestError(`${at}.language must be lowercase letters, digits and dashes`);
      const body = typeof o.body === "string" ? o.body : undefined;
      const syntax = o.syntax === undefined ? (body === undefined ? "leaf" : "fence") : (o.syntax as EmbedSyntax);
      if (!EMBED_SYNTAXES.includes(syntax)) throw new ManifestError(`${at}.syntax must be one of ${EMBED_SYNTAXES.join(", ")}`);
      const args: Record<string, EmbedArgument> = {};
      for (const [key, value] of Object.entries(o.arguments === undefined ? {} : object(o.arguments, `${at}.arguments`))) {
        const a = object(value, `${at}.arguments.${key}`);
        if (!ARGUMENT_TYPES.includes(a.type as string)) throw new ManifestError(`${at}.arguments.${key}.type must be one of ${ARGUMENT_TYPES.join(", ")}`);
        const strings = (field: string) => (a[field] === undefined ? undefined : list(a[field], `${at}.arguments.${key}.${field}`, (v, w) => text(v, w)));
        args[key] = {
          type: a.type as EmbedArgument["type"],
          description: text(a.description, `${at}.arguments.${key}.description`, true),
          ...(a.default !== undefined ? { default: String(a.default) } : {}),
          ...(typeof a.label === "string" ? { label: a.label } : {}),
          ...(strings("enum") ? { enum: strings("enum") } : {}),
          ...(strings("presets") ? { presets: strings("presets") } : {}),
          ...(a.hidden === true ? { hidden: true } : {}),
        };
      }
      return { language, title: text(o.title, `${at}.title`), description: text(o.description, `${at}.description`, true), syntax, arguments: args, ...(body !== undefined ? { body } : {}), ...requires(o.requires, `${at}.requires`) };
    }),
    urlEmbeds: list(c.urlEmbeds, "contributes.urlEmbeds", (item, at) => {
      const o = object(item, at);
      const pattern = text(o.pattern, `${at}.pattern`);
      try {
        new RegExp(pattern);
      } catch {
        throw new ManifestError(`${at}.pattern isn't a regular expression`);
      }
      const title = text(o.title, `${at}.title`);
      const frameHosts = list(o.frameHosts, `${at}.frameHosts`, (h, a) => {
        const host = text(h, a);
        // It goes into the page's policy: a host name, and nothing else.
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) throw new ManifestError(`${a} isn't a host name, like www.youtube-nocookie.com`);
        return host;
      });
      return { id: typeof o.id === "string" && o.id ? o.id : title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), pattern, title, frameHosts };
    }),
  };
}

/**
 * An extension.json's manifest, or what's wrong with it. The folder names the extension; an "id" in the
 * file must match. Only built-ins, which the app's build compiles, may be written in TypeScript.
 */
export function parseManifest(source: string | unknown, folderId: string, opts: { builtIn?: boolean } = {}): ExtensionManifest | string {
  let data: unknown = source;
  if (typeof source === "string") {
    try {
      data = JSON.parse(source);
    } catch (err) {
      return `extension.json isn't valid JSON: ${(err as Error).message}`;
    }
  }
  try {
    const m = object(data, "extension.json");
    if (m.id !== undefined && m.id !== folderId) throw new ManifestError(`extension.json says "id": ${JSON.stringify(m.id)}, but its folder is ${folderId}`);
    if (!EXTENSION_ID.test(folderId)) throw new ManifestError(`"${folderId}" can't be an extension's id: letters, digits, dots, dashes and underscores`);
    const main = m.main === undefined ? "index.js" : relativeFile(m.main, '"main"', opts.builtIn);
    const files = list(m.files, '"files"', (f, at) => relativeFile(f, at, opts.builtIn));
    const activationEvents = list(m.activationEvents, '"activationEvents"', (e, at) => {
      const event = text(e, at);
      if (event !== "onStartup" && !/^on(Command|View|Embed|UrlEmbed):\S+$/.test(event)) throw new ManifestError(`${at} isn't an activation event (onStartup, onCommand:…, onView:…, onEmbed:…)`);
      return event as ActivationEvent;
    });
    const permissions: Permissions = {};
    for (const [kind, request] of Object.entries(m.permissions === undefined ? {} : object(m.permissions, '"permissions"'))) {
      const at = `permissions["${kind}"]`;
      if (!PERMISSION_KINDS.includes(kind as PermissionKind)) throw new ManifestError(`${at} isn't a permission (${PERMISSION_KINDS.join(", ")})`);
      const r = object(request, at);
      const why = text(r.why, `${at}.why`);
      const strings = (field: string) => list(r[field], `${at}.${field}`, (v, a) => text(v, a));
      const out: PermissionRequest = { why };
      if (kind === "network") {
        out.hosts = strings("hosts");
        // "*" is any host: declared plainly, so asking for it says so.
        const bad = out.hosts.find((h) => h !== "*" && !HOST.test(h));
        if (!out.hosts.length || bad) throw new ManifestError(`${at}.hosts must name hosts, like "api.weather.gov" or "*.example.com", or be "*" for any${bad ? `; "${bad}" isn't one` : ""}`);
      }
      if (kind === "files:read" || kind === "files:write") {
        out.paths = strings("paths");
        if (!out.paths.length) throw new ManifestError(`${at}.paths must name the files it may touch, like "Journal/**"`);
      }
      if (kind === "settings:write") {
        out.keys = strings("keys");
        if (!out.keys.length) throw new ManifestError(`${at}.keys must name the settings it may change`);
      }
      permissions[kind as PermissionKind] = out;
    }
    const publisher = text(m.publisher, '"publisher"', true);
    return {
      id: folderId,
      name: text(m.name, '"name"', true) || folderId,
      version: text(m.version, '"version"', true) || "0.0.0",
      description: text(m.description, '"description"', true),
      ...(publisher ? { publisher } : {}),
      main,
      files: files.includes(main) ? files : [main, ...files],
      activationEvents: activationEvents.length ? activationEvents : ["onStartup"],
      permissions,
      ...requires(m.requires, '"requires"'),
      contributes: contributions(m.contributes, folderId),
    };
  } catch (err) {
    if (err instanceof ManifestError) return err.message;
    throw err;
  }
}

/** The extension.json text for a manifest, as Customize writes it into the workspace. */
export const manifestText = (m: ExtensionManifest) => `${JSON.stringify(m, null, 2)}\n`;
