// Finding, starting and keeping track of plugins: the built-ins, and workspace plugins, which are files
// (`.common-ink/plugins/<id>/plugin.json` and `index.js`, ADR 0005). A workspace plugin with a built-in's
// id runs in its place: that's how a built-in is customized. Each plugin starts through a context that
// notes what it adds and catches what it throws, so one broken plugin can't take the others down.
import type { FilePath, FileSummary, WorkspaceFile } from "../../worker/src/files.ts";
import type { PluginContext, PluginManifest, PluginModule } from "./plugins.ts";

/** A plugin that ships with Common Ink, with its source to show (and copy, if it's self-contained). */
export interface BuiltIn extends PluginManifest {
  module: PluginModule;
  source: string;
  /** Where the source lives in the repository, for showing. */
  file: string;
}

/** What a plugin added when it started. */
export interface Contributions {
  commands: string[];
  views: string[];
  commandBar: string[];
  keybindings: string[];
  /** What it adds to note editors. */
  editor: string[];
}

export type PluginState =
  /** Running. */
  | "on"
  /** Turned off in settings. */
  | "off"
  /** Its code threw while loading or starting. */
  | "failed"
  /** A workspace plugin, not loaded because this is safe mode. */
  | "safe";

export interface PluginEntry {
  manifest: PluginManifest;
  /** The built-in with this id, if there is one. With `workspace` too, the built-in is customized. */
  builtIn?: BuiltIn;
  /** The workspace plugin with this id, if there is one. */
  workspace?: WorkspacePlugin;
  state: PluginState;
  /** What went wrong, last: loading, starting, or a command or view it added. */
  error?: string;
  /** Null when it didn't start, so what it adds isn't known. */
  contributions: Contributions | null;
}

export interface WorkspacePlugin {
  id: string;
  manifestPath: FilePath;
  scriptPath: FilePath;
  /** Changes to either file change this, for telling when a reload would load something new. */
  version: string;
}

const DIR = ".common-ink/plugins/";
const MANIFEST = /^\.common-ink\/plugins\/([a-zA-Z0-9][\w.-]*)\/plugin\.json$/;

export const pluginPaths = (id: string) => ({ manifestPath: `${DIR}${id}/plugin.json` as FilePath, scriptPath: `${DIR}${id}/index.js` as FilePath });

/** The workspace plugins among the files: a folder with a plugin.json. Its index.js may be missing. */
export function findWorkspacePlugins(files: readonly FileSummary[]): WorkspacePlugin[] {
  const revisions = new Map(files.map((f) => [f.path, f.revision]));
  return files.flatMap((f) => {
    const id = MANIFEST.exec(f.path)?.[1];
    if (!id) return [];
    const paths = pluginPaths(id);
    return [{ id, ...paths, version: `${f.revision}:${revisions.get(paths.scriptPath) ?? 0}` }];
  });
}

/** A plugin.json's manifest, or what's wrong with it. The folder names the plugin; an "id" in the file must match. */
export function parseManifest(text: string, id: string): PluginManifest | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return `plugin.json isn't valid JSON: ${(err as Error).message}`;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return "plugin.json must be a JSON object";
  const m = data as Record<string, unknown>;
  if (m.id !== undefined && m.id !== id) return `plugin.json says "id": ${JSON.stringify(m.id)}, but its folder is ${id}`;
  if (m.name !== undefined && typeof m.name !== "string") return '"name" must be a string';
  if (m.description !== undefined && typeof m.description !== "string") return '"description" must be a string';
  return { id, name: (m.name as string | undefined) || id, description: (m.description as string | undefined) ?? "" };
}

/** The text of a new workspace plugin's plugin.json. */
export const manifestText = (m: PluginManifest) => `${JSON.stringify({ id: m.id, name: m.name, description: m.description }, null, 2)}\n`;

/** Whether a source runs on its own as a workspace plugin: nothing to import from the app. */
export const isSelfContained = (source: string) => !/^\s*import\s(?!type\b)/m.test(source);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A context that notes what a plugin adds and catches what its commands, views and listeners throw,
 * calling `failed` instead of letting it reach the app.
 */
export function recording(ctx: PluginContext, adds: Contributions, failed: (err: unknown) => void): PluginContext {
  // Errors, thrown or from a returned promise, stop here.
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => R, fallback?: R) =>
    (...args: A): R => {
      try {
        const out = fn(...args);
        if (out instanceof Promise) return out.catch((err) => failed(err)) as R;
        return out;
      } catch (err) {
        failed(err);
        return fallback as R;
      }
    };
  return {
    ...ctx,
    commands: {
      ...ctx.commands,
      register: (...commands) => {
        adds.commands.push(...commands.map((c) => c.title));
        ctx.commands.register(...commands.map((c) => ({ ...c, run: guard(() => c.run()) })));
      },
    },
    keybindings: {
      add: (...bindings) => {
        adds.keybindings.push(...bindings.map((b) => `${b.key} → ${b.command ?? "nothing"}`));
        ctx.keybindings.add(...bindings);
      },
    },
    editor: {
      extend: (extension) => {
        adds.editor.push("decorations or behavior in note editors");
        ctx.editor.extend(extension);
      },
    },
    commandBar: {
      ...ctx.commandBar,
      provide: (p) => {
        adds.commandBar.push(p.prefix === "" ? "names (no prefix)" : p.prefix);
        ctx.commandBar.provide({ ...p, items: guard((q: string) => p.items(q), []) });
      },
    },
    panels: {
      ...ctx.panels,
      register: (p) => {
        adds.views.push(p.title);
        ctx.panels.register({ ...p, render: guard((el: HTMLElement) => p.render(el)) });
      },
    },
    workbench: {
      ...ctx.workbench,
      provideViews: (prefix, make) => {
        adds.views.push(`${prefix}…`);
        ctx.workbench.provideViews(prefix, (id) => {
          const view = guard(make, null)(id);
          return view && { ...view, render: guard((el: HTMLElement) => view.render(el)) };
        });
      },
    },
    events: {
      onSaved: (fn) => ctx.events.onSaved(guard(fn)),
      onFocus: (fn) => ctx.events.onFocus(guard(fn)),
    },
  };
}

/** A context where everything is accepted and nothing happens, for finding out what a plugin would add. */
const inert: PluginContext = new Proxy(function () {}, { get: () => inert, apply: () => undefined }) as unknown as PluginContext;

/** What a plugin would add, found by starting it where nothing it does takes effect. For built-ins that are off. */
export function dryRun(module: PluginModule): Contributions | null {
  const adds: Contributions = { commands: [], views: [], commandBar: [], keybindings: [], editor: [] };
  try {
    module.activate(recording(inert, adds, () => {}));
    return adds;
  } catch {
    return null;
  }
}

export interface StartOptions {
  builtIns: readonly BuiltIn[];
  files: readonly FileSummary[];
  read(path: FilePath): Promise<WorkspaceFile>;
  /** Load a workspace plugin's index.js (from the Worker, so `script-src 'self'` allows it). */
  load(plugin: WorkspacePlugin): Promise<unknown>;
  ctx: PluginContext;
  disabled: readonly string[];
  /** Safe mode: only built-ins start. */
  safe: boolean;
  /** Something about a plugin changed after it started, such as a command that threw. */
  changed(): void;
}

/** Start the plugins: built-ins first, then workspace plugins, each on its own. */
export async function startPlugins(o: StartOptions): Promise<PluginEntry[]> {
  const workspace = new Map(findWorkspacePlugins(o.files).map((w) => [w.id, w]));
  const entries: PluginEntry[] = [];

  const start = (entry: PluginEntry, module: PluginModule) => {
    const adds: Contributions = { commands: [], views: [], commandBar: [], keybindings: [], editor: [] };
    const failed = (err: unknown) => {
      console.error(`Plugin ${entry.manifest.id}:`, err);
      entry.error = message(err);
      o.changed();
    };
    try {
      module.activate(recording(o.ctx, adds, failed));
      entry.state = "on";
    } catch (err) {
      console.error(`Plugin ${entry.manifest.id} didn't start:`, err);
      entry.state = "failed";
      entry.error = message(err);
    }
    entry.contributions = adds;
  };

  for (const b of o.builtIns) {
    const copy = workspace.get(b.id);
    if (copy && !o.safe) continue; // The workspace's copy runs instead, below.
    const entry: PluginEntry = { manifest: b, builtIn: b, workspace: copy, state: "off", contributions: null };
    entries.push(entry);
    if (o.disabled.includes(b.id)) entry.contributions = dryRun(b.module);
    else start(entry, b.module);
  }

  for (const w of workspace.values()) {
    const builtIn = o.builtIns.find((b) => b.id === w.id);
    if (o.safe && builtIn) continue; // Listed above, as the built-in that runs instead.
    const entry: PluginEntry = { manifest: { id: w.id, name: builtIn?.name ?? w.id, description: builtIn?.description ?? "" }, builtIn, workspace: w, state: "off", contributions: null };
    entries.push(entry);
    // plugin.json is only data, so it's read even in safe mode, for the plugin's name.
    const manifest = parseManifest((await o.read(w.manifestPath)).text, w.id);
    if (o.safe) {
      if (typeof manifest !== "string") entry.manifest = manifest;
      entry.state = "safe";
      continue;
    }
    if (typeof manifest === "string") {
      [entry.state, entry.error] = ["failed", manifest];
      continue;
    }
    entry.manifest = manifest;
    if (o.disabled.includes(w.id)) continue;
    let loaded: { default?: PluginModule };
    try {
      loaded = (await o.load(w)) as { default?: PluginModule };
    } catch (err) {
      [entry.state, entry.error] = ["failed", `index.js didn't load: ${message(err)}`];
      continue;
    }
    if (typeof loaded?.default?.activate !== "function") {
      [entry.state, entry.error] = ["failed", "index.js must export default { activate(ctx) { … } }"];
      continue;
    }
    start(entry, loaded.default);
  }
  return entries;
}

/**
 * Each plugin's state as far as a reload is concerned: on or off, and which version of its files. When
 * this differs from what it was at start, the plugin needs a reload to match.
 */
export function pluginStates(builtIns: readonly BuiltIn[], files: readonly FileSummary[], disabled: readonly string[], safe: boolean): Map<string, string> {
  const states = new Map<string, string>();
  for (const b of builtIns) states.set(b.id, `${!disabled.includes(b.id)}`);
  if (safe) return states;
  for (const w of findWorkspacePlugins(files)) states.set(w.id, `${!disabled.includes(w.id)}:${w.version}`);
  return states;
}

/** The plugins whose state differs between two `pluginStates`. */
export function changedPlugins(atStart: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set([...atStart.keys(), ...now.keys()]);
  return new Set([...ids].filter((id) => atStart.get(id) !== now.get(id)));
}
