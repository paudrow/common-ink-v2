// Finding, starting and keeping track of extensions: the built-ins, and workspace extensions, which are
// folders of files (.common-ink/extensions/<id>/extension.json and its code, ADR 0006). A workspace
// extension with a built-in's id runs in its place: that's how a built-in is customized. Each extension
// starts only when one of its activation events happens, through a context that catches what it
// throws, so one broken extension can't take the others down.
import { extensionFileOf, manifestPath, parseManifest, STATE_FILE, type ActivationEvent, type Contributions, type ExtensionManifest } from "../../worker/src/extensions.ts";
import type { FilePath, FileSummary, WorkspaceFile } from "../../worker/src/files.ts";
import { DEFAULT_KEYBINDINGS } from "../../worker/src/settings.ts";
import type { ExtensionContext, ExtensionModule } from "./extension-api.ts";
import { chord } from "./keys.ts";

/** An extension that ships with Common Ink, with its source to show, and the JavaScript to copy. */
export interface BuiltIn {
  manifest: ExtensionManifest;
  /** Its code, loaded the first time it's needed. */
  load(): Promise<ExtensionModule>;
  /** Its files' names, as in its folder. */
  files: string[];
  /** A file's text, loaded when it's shown. */
  source(file: string): Promise<string>;
  /** Its files as Customize copies them into the workspace: JavaScript, with extension.json saying so. Loaded when it's customized. */
  copy(): Promise<Record<string, string>>;
  /** Where its folder is in the repository, for showing. */
  folder: string;
}

/** A workspace extension's folder: its manifest, and every file in it. */
export interface WorkspaceExtension {
  id: string;
  manifestPath: FilePath;
  files: FilePath[];
  /** Any change to any of its files changes this, for telling when a reload would load something new. */
  version: string;
}

export type ExtensionState =
  /** On, and waiting for one of its activation events. */
  | "inactive"
  /** Running. */
  | "active"
  /** Turned off in settings. */
  | "off"
  /** On in settings, but off on this device: it needs something the device hasn't, or you turned it off here. */
  | "unmet"
  /** Its manifest is wrong, or its code threw while loading or starting. */
  | "failed"
  /** A workspace extension, not loaded because this is safe mode. */
  | "safe";

/** Where an extension's code runs: in the app's page (built-ins, and ones you trust), or in a sandbox. */
export type Tier = "page" | "sandbox";

export interface ExtensionRecord {
  id: string;
  tier: Tier;
  /** The manifest in effect: a workspace copy's, when it runs in place of the built-in. */
  manifest: ExtensionManifest;
  /** The built-in with this id, if there is one. With `workspace` too, the built-in is customized. */
  builtIn?: BuiltIn;
  /** The workspace extension with this id, if there is one. */
  workspace?: WorkspaceExtension;
  state: ExtensionState;
  /** What went wrong, last: its manifest, loading, starting, or a command or view it added. */
  error?: string;
  /** Its extension.json couldn't be read, so `manifest` is a stand-in. */
  broken?: true;
  /** The workspace has a customized copy you don't trust, so the built-in runs as it shipped until you trust the copy. */
  untrustedCopy?: true;
  /** Where it was installed from, for a workspace extension installed from a URL (its installed.json). */
  installedFrom?: string;
  /** The catalog it was installed from, if it was. */
  catalog?: string;
  /** What its activate returned: the API it offers other extensions (page extensions only). */
  exports?: unknown;
}

/** Whether the code that runs is the built-in as it shipped: not customized, or customized by a copy you don't trust. */
export const runsShipped = (r: ExtensionRecord) => !!r.builtIn && (!r.workspace || !!r.untrustedCopy);

/** The file Install from URL leaves in an extension's folder, saying where it came from. */
export const installedPath = (id: string) => `.common-ink/extensions/${id}/installed.json` as FilePath;

/** Where an installed.json says an extension came from: an address, and a catalog if it was one's. */
function installedFrom(text: string): { installedFrom?: string; catalog?: string } {
  try {
    const { from, catalog } = JSON.parse(text) as { from?: unknown; catalog?: unknown };
    return { ...(typeof from === "string" ? { installedFrom: from } : {}), ...(typeof catalog === "string" ? { catalog } : {}) };
  } catch {
    return {};
  }
}

/**
 * Extensions taken out of the Catalog. A copy installed from it no longer runs or shows: Word count
 * gave way to Words, built in. One of the same id you wrote yourself isn't touched.
 */
const RETIRED = new Set(["word-count"]);
const retired = (id: string, from: { catalog?: string }) => RETIRED.has(id) && from.catalog === "Common Ink";

/** The workspace extensions among the files: a folder with an extension.json. */
export function findWorkspaceExtensions(files: readonly FileSummary[]): WorkspaceExtension[] {
  const byId = new Map<string, FileSummary[]>();
  for (const f of files) {
    const at = extensionFileOf(f.path);
    // Its state changes as it runs; that's not a change to the extension.
    if (at && at.file !== STATE_FILE) byId.set(at.id, [...(byId.get(at.id) ?? []), f]);
  }
  return [...byId].flatMap(([id, folder]) => {
    if (!folder.some((f) => f.path === manifestPath(id))) return [];
    return [{ id, manifestPath: manifestPath(id), files: folder.map((f) => f.path), version: folder.map((f) => `${f.path}@${f.revision}`).sort().join(",") }];
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a sandboxed extension can't take, because the app, a built-in or a trusted extension has it. */
export interface Claimed {
  /**
   * Names the app and the built-ins use, in every spelling `spellings` gives: the first word of each of
   * their commands and views ("settings" for settings.user), the built-ins' ids, and their search types
   * and embeds. A sandboxed extension can't be named with one, or add anything named in one.
   */
  names: ReadonlySet<string>;
  /** Key presses taken, as `chord`s on a Mac ("mac:meta-s") and elsewhere ("other:ctrl-s"). */
  keys: ReadonlySet<string>;
}

/** An extension's own names for what it adds: its id, and its id in camelCase ("word-count" and "wordCount"). */
export const namesOf = (id: string) => [...new Set([id, id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())])];

/** A name as names are compared: in any case, with and without its dashes read as camelCase. */
const spellings = (name: string) => [...new Set([name.toLowerCase(), name.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase()).toLowerCase()])];

/** Whether a name is a claimed one, inside one ("lists.indent" in "lists"), or holds one, in any spelling. */
function clashes(name: string, claimed: ReadonlySet<string>): boolean {
  return spellings(name).some((n) => [...claimed].some((c) => n === c || n.startsWith(`${c}.`) || c.startsWith(`${n}.`)));
}

/** The names the app and built-ins use, for `Claimed.names`: `ids` are the app's own commands and views. */
function claimedNames(ids: readonly string[], builtIns: readonly ExtensionManifest[]): Set<string> {
  const firstWord = (id: string) => id.split(".")[0];
  const names = [
    "note",
    ...ids.map(firstWord),
    ...builtIns.flatMap((m) => [
      m.id,
      ...m.contributes.commands.map((c) => firstWord(c.command)),
      ...Object.values(m.contributes.views).flat().map((v) => firstWord(v.id)),
      ...m.contributes.search.types.map((t) => t.type),
      ...m.contributes.embeds.map((e) => e.language),
      ...m.contributes.statusBarItems.map((i) => i.id),
    ]),
  ];
  return new Set(names.flatMap(spellings));
}

/** The presses a key is on a Mac and elsewhere, for `Claimed.keys`; none for a key with a word that isn't a modifier. */
const pressesOf = (key: string) => ([true, false] as const).flatMap((mac) => {
  const c = chord(key, mac);
  return c === null ? [] : [`${mac ? "mac" : "other"}:${c}`];
});

/**
 * The keys Vim takes in normal, insert and visual mode, as shortcuts are written. A sandboxed extension
 * can't bind them, Vim on or not, since you can turn it on on any device (off a Mac, that's Mod with any
 * of these too).
 */
const VIM_KEYS = [..."abcdefghijklmnopqrstuvwxyz", "[", "]", "^", "\\", "6", "@"].map((k) => `Ctrl-${k}`);

/** A built-in's Vim sequence that starts with a Ctrl key ("<C-w>h"), as that key ("Ctrl-w"). */
const vimCtrl = (sequence: string) => /^<C-(.)>/.exec(sequence)?.[1];

/** Whether a sandboxed extension may bind a key: one with ⌘, Ctrl or Alt, so not typing, that's nothing claimed on either platform. */
function freeKey(key: string, claimed: ReadonlySet<string>): boolean {
  const presses = pressesOf(key);
  return presses.length === 2 && presses.every((p) => /^\w+:(meta|ctrl|alt)-/.test(p) && !claimed.has(p));
}

interface Own {
  /** Whether an id is under the extension's own names and clashes with nothing claimed. */
  name(id: string): boolean;
  /** Its commands, as kept. */
  commands: ReadonlySet<string>;
  claimed: Claimed;
  /** Its names, lowercased, as search filter keys may start with them. */
  words: readonly string[];
}

/**
 * What a sandboxed extension keeps of each kind of contribution. A kind that isn't here can't be kept: a
 * new kind of contribution has to say here what a sandboxed extension may have of it before one gets any.
 */
const CONFINE: { [K in keyof Contributions]-?: (c: Contributions, own: Own) => Contributions[K] } = {
  commands: (c, own) => c.commands.filter((x) => own.commands.has(x.command)),
  // Keys only, not Vim sequences: every sequence is Vim's to begin with, or one it's partway through.
  keybindings: (c, own) => c.keybindings.filter((k) => "key" in k && own.commands.has(k.command) && freeKey(k.key, own.claimed.keys)),
  menus: (c, own) => Object.fromEntries(Object.entries(c.menus).map(([id, items]) => [id, (items ?? []).filter((i) => own.commands.has(i.command))])),
  // Its settings are named for it already (parseManifest).
  configuration: (c) => c.configuration,
  viewsContainers: (c, own) => ({ activitybar: c.viewsContainers.activitybar.filter((v) => own.name(v.id)), panel: c.viewsContainers.panel.filter((v) => own.name(v.id)) }),
  views: (c, own) => Object.fromEntries(Object.entries(c.views).map(([where, list]) => [where, list.filter((v) => own.name(v.id))])),
  statusBarItems: (c, own) => c.statusBarItems.filter((i) => !clashes(i.id, own.claimed.names)).map((i) => (i.command === undefined || own.commands.has(i.command) ? i : { ...i, command: undefined })),
  embeds: (c, own) => c.embeds.filter((e) => !clashes(e.language, own.claimed.names)),
  // Drawn in the page, which only a trusted extension may do.
  urlEmbeds: () => [],
  layout: () => [],
  dataSources: (c) => c.dataSources,
  // Not a kind of result the app or a built-in answers for (notes, tasks, events): their results are theirs.
  // Filter keys named for it ("word-count:", "word-count-done:"), so a word you search for (meeting:) stays a word.
  search: (c, own) => ({
    types: c.search.types.filter((t) => !clashes(t.type, own.claimed.names)),
    filters: c.search.filters.filter((f) => own.words.some((w) => f.filter === w || f.filter.startsWith(`${w}-`))),
  }),
};

/**
 * What a sandboxed extension may add, of what its manifest declares: commands named under its own id
 * (its id, or its id in camelCase: "word-count." or "wordCount."), views named the same way, and keys,
 * status items and menu entries for those commands only; nothing named with a name the app or a
 * built-in uses, and no key they or a trusted extension bind. Anything else would let it stand in for
 * the app's own commands, which act as you.
 */
export function confined(m: ExtensionManifest, claimed: Claimed): ExtensionManifest {
  const names = namesOf(m.id);
  const name = (id: string) => names.some((n) => id === n || id.startsWith(`${n}.`)) && !clashes(id, claimed.names);
  const commands = new Set(m.contributes.commands.filter((x) => name(x.command) && x.command.includes(".")).map((x) => x.command));
  const own: Own = { name, commands, claimed, words: names.map((n) => n.toLowerCase()) };
  const contributes = Object.fromEntries(Object.entries(CONFINE).map(([kind, keep]) => [kind, (keep as (c: Contributions, own: Own) => unknown)(m.contributes, own)])) as unknown as Contributions;
  return { ...m, contributes };
}

/**
 * Whether a sandboxed extension may take queries starting with `prefix` in the command bar: one that
 * starts with its own name, as a word ("word-count " or "wordCount:"). Search's "", commands' ">" and
 * every other provider's stay theirs.
 */
export function ownPrefix(id: string, prefix: string): boolean {
  const p = prefix.toLowerCase();
  return namesOf(id).some((n) => p.startsWith(n.toLowerCase()) && !/[\w.-]/.test(p.charAt(n.length)));
}

/** Why a sandboxed extension can't run under its folder's name, if it can't: the app or a built-in uses it. */
export function reservedName(id: string, claimed: Claimed): string | null {
  if (!clashes(id, claimed.names)) return null;
  return `"${id}" is a name the app or a built-in extension uses for its own commands and views, so an extension in a folder named that can't run sandboxed. Rename its folder.`;
}

/** A manifest for a folder whose extension.json can't be read, so it can still be listed and fixed. */
const brokenManifest = (id: string, name = id): ExtensionManifest => ({
  id,
  name,
  version: "",
  description: "",
  main: "index.js",
  files: [],
  activationEvents: [],
  permissions: {},
  contributes: { commands: [], keybindings: [], menus: {}, configuration: null, viewsContainers: { activitybar: [], panel: [] }, views: {}, statusBarItems: [], embeds: [], urlEmbeds: [], dataSources: [], layout: [], search: { types: [], filters: [] } },
});

export interface HostOptions {
  /** The context an extension's code gets in the page. Its errors are reported through `failed`. */
  context(record: ExtensionRecord, failed: (err: unknown) => void): ExtensionContext;
  /** Load a trusted workspace extension's main module (from the Worker, so `script-src 'self'` allows it). */
  load(extension: WorkspaceExtension, main: string): Promise<unknown>;
  /** Start a sandboxed extension in its own host frame, reporting later errors through `failed`. Resolves once it's activated. */
  sandbox(record: ExtensionRecord, failed: (err: unknown) => void): Promise<void>;
  /** Something about an extension changed after it started, such as a command that threw. */
  changed(): void;
  /** The app's own commands and views, and the keys its editor takes on a Mac or elsewhere: no sandboxed extension may have them. */
  app?(): { ids: readonly string[]; keys(mac: boolean): readonly string[] };
}

/** Every extension, and starting them as their activation events happen. */
export class ExtensionHost {
  records: ExtensionRecord[] = [];
  /** Copies of retired Catalog extensions found at the last load, for the app to clear away. */
  retired: WorkspaceExtension[] = [];
  private modules = new Map<string, () => Promise<ExtensionModule>>();
  private activations = new Map<string, Promise<void>>();
  /** What the app, the built-ins and trusted extensions have, which a sandboxed extension can't take. */
  private claimed: Claimed = { names: new Set(), keys: new Set() };

  constructor(private o: HostOptions) {}

  /** Read every extension's manifest. Built-ins first, then workspace extensions; none of their code runs yet. */
  async load(
    builtIns: readonly BuiltIn[],
    files: readonly FileSummary[],
    read: (path: FilePath) => Promise<WorkspaceFile>,
    disabled: readonly string[],
    safe: boolean,
    trusted: readonly string[] = [],
  ): Promise<void> {
    const workspace = new Map(findWorkspaceExtensions(files).map((w) => [w.id, w]));
    this.retired = [];
    const manifests = new Map<string, ExtensionManifest | string>();
    for (const w of workspace.values()) {
      // extension.json is only data, so it's read even in safe mode, for the extension's name.
      if (!(safe && builtIns.some((b) => b.manifest.id === w.id))) manifests.set(w.id, parseManifest((await read(w.manifestPath)).text, w.id));
    }
    const app = this.o.app?.() ?? { ids: [], keys: () => [] };
    const keyed = [...builtIns.map((b) => b.manifest), ...[...manifests].flatMap(([id, m]) => (typeof m !== "string" && trusted.includes(id) ? [m] : []))];
    const keys = [
      ...DEFAULT_KEYBINDINGS.map((k) => k.key),
      ...keyed.flatMap((m) => m.contributes.keybindings.flatMap((k) => ("key" in k ? [k.key] : vimCtrl(k.vim) ? [`Ctrl-${vimCtrl(k.vim)}`] : []))),
      ...VIM_KEYS,
    ];
    this.claimed = {
      names: claimedNames(app.ids, builtIns.map((b) => b.manifest)),
      keys: new Set([...keys.flatMap(pressesOf), ...([true, false] as const).flatMap((mac) => app.keys(mac).flatMap((k) => pressesOf(k).filter((p) => p.startsWith(mac ? "mac:" : "other:"))))]),
    };
    const records: ExtensionRecord[] = [];
    for (const b of builtIns) {
      const copy = workspace.get(b.manifest.id);
      // The workspace's copy runs instead, below, if you trust it. In safe mode, or until you trust it, the built-in runs as it shipped.
      const untrusted = !!copy && !trusted.includes(b.manifest.id);
      if (copy && !safe && !untrusted) continue;
      records.push({ id: b.manifest.id, tier: "page", manifest: b.manifest, builtIn: b, workspace: copy, state: disabled.includes(b.manifest.id) ? "off" : "inactive", ...(untrusted && !safe ? { untrustedCopy: true as const } : {}) });
      this.modules.set(b.manifest.id, () => b.load());
    }
    for (const w of workspace.values()) {
      const from = w.files.includes(installedPath(w.id)) ? installedFrom((await read(installedPath(w.id))).text) : {};
      if (retired(w.id, from)) {
        this.retired.push(w);
        continue;
      }
      const builtIn = builtIns.find((b) => b.manifest.id === w.id);
      if (builtIn && (safe || !trusted.includes(w.id))) continue;
      const manifest = manifests.get(w.id)!;
      // A workspace extension runs sandboxed unless you trust it.
      const tier: Tier = trusted.includes(w.id) ? "page" : "sandbox";
      const parsed = typeof manifest === "string" ? brokenManifest(w.id, builtIn?.manifest.name) : manifest;
      const record: ExtensionRecord = { id: w.id, tier, manifest: tier === "sandbox" ? confined(parsed, this.claimed) : parsed, builtIn, workspace: w, state: "inactive", ...from };
      records.push(record);
      const reserved = tier === "sandbox" ? reservedName(w.id, this.claimed) : null;
      if (typeof manifest === "string") [record.state, record.error, record.broken] = ["failed", manifest, true];
      else if (safe) record.state = "safe";
      else if (disabled.includes(w.id)) record.state = "off";
      else if (reserved) [record.state, record.error] = ["failed", reserved];
      else {
        const main = manifest.main;
        this.modules.set(w.id, async () => {
          const loaded = (await this.o.load(w, main)) as { default?: ExtensionModule };
          if (typeof loaded?.default?.activate !== "function") throw new Error(`${main} must export default { activate(ctx) { … } }`);
          return loaded.default;
        });
      }
    }
    this.records = records;
  }

  /**
   * A sandboxed workspace extension installed or turned on while the app runs: its record, ready to start
   * on its activation events, or failed, if its name is one the app uses. Null for one that can't be put
   * in live: a built-in's id, a broken manifest, or one that's on already.
   */
  async add(w: WorkspaceExtension, read: (path: FilePath) => Promise<WorkspaceFile>): Promise<ExtensionRecord | null> {
    const existing = this.records.find((r) => r.id === w.id);
    if (existing?.builtIn || (existing && existing.state !== "off")) return null;
    const from = w.files.includes(installedPath(w.id)) ? installedFrom((await read(installedPath(w.id))).text) : {};
    if (retired(w.id, from)) return null;
    const manifest = parseManifest((await read(w.manifestPath)).text, w.id);
    if (typeof manifest === "string") return null;
    const record: ExtensionRecord = { id: w.id, tier: "sandbox", manifest: confined(manifest, this.claimed), workspace: w, state: "inactive", ...from };
    this.records = [...this.records.filter((r) => r.id !== w.id), record];
    const reserved = reservedName(w.id, this.claimed);
    if (reserved) {
      [record.state, record.error] = ["failed", reserved];
      return record;
    }
    const main = manifest.main;
    this.modules.set(w.id, async () => (await this.o.load(w, main)) as ExtensionModule);
    this.activations.delete(w.id);
    return record;
  }

  /** The manifests of the extensions that are on: what they add is in effect, whether or not their code has started. */
  on(): ExtensionManifest[] {
    return this.records.filter((r) => r.state === "inactive" || r.state === "active").map((r) => r.manifest);
  }

  /** Every installed extension's manifest, on or off, as far as it could be read. */
  installed(): ExtensionManifest[] {
    return this.records.filter((r) => !r.broken).map((r) => r.manifest);
  }

  /** The extension that declares a command, view or other contribution, by a test of its manifest. */
  owner(test: (m: ExtensionManifest) => boolean): ExtensionRecord | undefined {
    return this.records.find((r) => (r.state === "inactive" || r.state === "active") && test(r.manifest));
  }

  /** Start every extension that's waiting for this event. Resolves when they've all started (or failed). */
  async fire(event: ActivationEvent): Promise<void> {
    await Promise.all(this.records.filter((r) => r.state === "inactive" && r.manifest.activationEvents.includes(event)).map((r) => this.activate(r)));
  }

  /**
   * The API an extension offers others (what its activate returned), starting it first if it hasn't.
   * Undefined for one that's off, failed, sandboxed, not there, or offers none.
   */
  async api(id: string): Promise<unknown> {
    const record = this.records.find((r) => r.id === id && (r.state === "inactive" || r.state === "active"));
    if (!record || record.tier === "sandbox") return undefined;
    await this.activate(record);
    return record.state === "active" ? record.exports : undefined;
  }

  /** Start one extension, once. */
  activate(record: ExtensionRecord): Promise<void> {
    const started = this.activations.get(record.id);
    if (started) return started;
    const failed = (err: unknown) => {
      console.error(`Extension ${record.id}:`, err);
      record.error = message(err);
      this.o.changed();
    };
    const run = (async () => {
      try {
        if (record.tier === "sandbox") await this.o.sandbox(record, failed);
        else {
          const module = await this.modules.get(record.id)!();
          record.exports = await module.activate(this.o.context(record, failed));
        }
        record.state = "active";
      } catch (err) {
        console.error(`Extension ${record.id} didn't start:`, err);
        [record.state, record.error] = ["failed", message(err)];
      }
      this.o.changed();
    })();
    this.activations.set(record.id, run);
    return run;
  }
}

/** A function that reports what it throws, or rejects, instead of letting it reach the app. */
export function guarded<A extends unknown[], R>(fn: (...args: A) => R, failed: (err: unknown) => void, fallback?: R): (...args: A) => R {
  return (...args: A): R => {
    try {
      const out = fn(...args);
      if (out instanceof Promise) return out.catch((err) => failed(err)) as R;
      return out;
    } catch (err) {
      failed(err);
      return fallback as R;
    }
  };
}

/**
 * Each extension's state as far as a reload is concerned: on or off (everywhere, or here by your
 * override), and which version of its files. When this differs from what it was at start, the extension
 * needs a reload to match. What the device has isn't in it: an extension that becomes met goes in live.
 */
export function extensionStates(builtIns: readonly BuiltIn[], files: readonly FileSummary[], disabled: readonly string[], safe: boolean, offHere: readonly string[] = []): Map<string, string> {
  const states = new Map<string, string>();
  const on = (id: string) => !disabled.includes(id) && !offHere.includes(id);
  for (const b of builtIns) states.set(b.manifest.id, `${on(b.manifest.id)}`);
  if (safe) return states;
  for (const w of findWorkspaceExtensions(files)) states.set(w.id, `${on(w.id)}:${w.version}`);
  return states;
}

/** The extensions whose state differs between two `extensionStates`. */
export function changedExtensions(atStart: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set([...atStart.keys(), ...now.keys()]);
  return new Set([...ids].filter((id) => atStart.get(id) !== now.get(id)));
}

/**
 * What a module imports that an extension may not: anything but its own folder's files and the
 * libraries (library-names.ts). Type-only imports don't count; they're gone when it runs.
 */
export function forbiddenImports(source: string, libraries: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
    if (m[1]) continue;
    const from = m[3] ?? m[4];
    if (from.startsWith("./") || libraries.includes(from)) continue;
    out.push(from);
  }
  return out;
}
