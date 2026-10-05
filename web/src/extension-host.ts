// Finding, starting and keeping track of extensions: the built-ins, and workspace extensions, which are
// folders of files (.common-ink/extensions/<id>/extension.json and its code, ADR 0006). A workspace
// extension with a built-in's id runs in its place: that's how a built-in is customized. Each extension
// starts only when one of its activation events happens, through a context that catches what it
// throws, so one broken extension can't take the others down.
import { extensionFileOf, manifestPath, parseManifest, type ActivationEvent, type ExtensionManifest } from "../../worker/src/extensions.ts";
import type { FilePath, FileSummary, WorkspaceFile } from "../../worker/src/files.ts";
import type { ExtensionContext, ExtensionModule } from "./extension-api.ts";

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
  /** Where it was installed from, for a workspace extension installed from a URL (its installed.json). */
  installedFrom?: string;
  /** The catalog it was installed from, if it was. */
  catalog?: string;
}

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

/** The workspace extensions among the files: a folder with an extension.json. */
export function findWorkspaceExtensions(files: readonly FileSummary[]): WorkspaceExtension[] {
  const byId = new Map<string, FileSummary[]>();
  for (const f of files) {
    const at = extensionFileOf(f.path);
    if (at) byId.set(at.id, [...(byId.get(at.id) ?? []), f]);
  }
  return [...byId].flatMap(([id, folder]) => {
    if (!folder.some((f) => f.path === manifestPath(id))) return [];
    return [{ id, manifestPath: manifestPath(id), files: folder.map((f) => f.path), version: folder.map((f) => `${f.path}@${f.revision}`).sort().join(",") }];
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
  contributes: { commands: [], keybindings: [], menus: {}, configuration: null, viewsContainers: { activitybar: [], panel: [] }, views: {}, statusBarItems: [], embeds: [], urlEmbeds: [] },
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
}

/** Every extension, and starting them as their activation events happen. */
export class ExtensionHost {
  records: ExtensionRecord[] = [];
  private modules = new Map<string, () => Promise<ExtensionModule>>();
  private activations = new Map<string, Promise<void>>();

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
    const records: ExtensionRecord[] = [];
    for (const b of builtIns) {
      const copy = workspace.get(b.manifest.id);
      // The workspace's copy runs instead, below; in safe mode the built-in runs as it shipped.
      if (copy && !safe) continue;
      records.push({ id: b.manifest.id, tier: "page", manifest: b.manifest, builtIn: b, workspace: copy, state: disabled.includes(b.manifest.id) ? "off" : "inactive" });
      this.modules.set(b.manifest.id, () => b.load());
    }
    for (const w of workspace.values()) {
      const builtIn = builtIns.find((b) => b.manifest.id === w.id);
      if (safe && builtIn) continue;
      // extension.json is only data, so it's read even in safe mode, for the extension's name.
      const manifest = parseManifest((await read(w.manifestPath)).text, w.id);
      // A workspace extension runs sandboxed unless you trust it.
      const tier: Tier = trusted.includes(w.id) ? "page" : "sandbox";
      const record: ExtensionRecord = { id: w.id, tier, manifest: typeof manifest === "string" ? brokenManifest(w.id, builtIn?.manifest.name) : manifest, builtIn, workspace: w, state: "inactive" };
      if (w.files.includes(installedPath(w.id))) Object.assign(record, installedFrom((await read(installedPath(w.id))).text));
      records.push(record);
      if (typeof manifest === "string") [record.state, record.error, record.broken] = ["failed", manifest, true];
      else if (safe) record.state = "safe";
      else if (disabled.includes(w.id)) record.state = "off";
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
          await module.activate(this.o.context(record, failed));
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
 * Each extension's state as far as a reload is concerned: on or off, and which version of its files. When
 * this differs from what it was at start, the extension needs a reload to match.
 */
export function extensionStates(builtIns: readonly BuiltIn[], files: readonly FileSummary[], disabled: readonly string[], safe: boolean): Map<string, string> {
  const states = new Map<string, string>();
  for (const b of builtIns) states.set(b.manifest.id, `${!disabled.includes(b.manifest.id)}`);
  if (safe) return states;
  for (const w of findWorkspaceExtensions(files)) states.set(w.id, `${!disabled.includes(w.id)}:${w.version}`);
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
