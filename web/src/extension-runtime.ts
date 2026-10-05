// Extensions in the running app: what their manifests declare goes in at once (commands in the
// command bar, keybindings, menus, views, settings sections), and each extension's code starts the
// first time one of its activation events happens, such as its command running or its view showing.
import type { Change, FilePath, FileSummary } from "../../worker/src/files.ts";
import type { ExtensionManifest, MenuId } from "../../worker/src/extensions.ts";
import { settingsCatalog, type Keybinding, type Settings, type SettingsCatalog } from "../../worker/src/settings.ts";
import { api } from "./api.ts";
import type { CommandBar } from "./commandbar.ts";
import { keyFor, type Commands } from "./commands.ts";
import { docLabel } from "./describe.ts";
import type { ExtensionContext, ViewRenderer } from "./extension-api.ts";
import { ExtensionHost, guarded, type BuiltIn, type ExtensionRecord, type WorkspaceExtension } from "./extension-host.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { formatKeys } from "./keys.ts";
import { notePathFor } from "./links.ts";
import type { Offline } from "./offline.ts";
import type { Panels } from "./panels.ts";
import type { Workbench } from "./workbench.ts";

/** What of the app extensions reach, through their contexts. */
export interface RuntimeApp {
  me: string | undefined;
  commands: Commands;
  bar: CommandBar;
  panels: Panels;
  workbench: Workbench;
  offline: Offline;
  settings(): Settings;
  files(): FileSummary[];
  openFromBar(path: FilePath): void;
  /** The file focused last, for views that work on "the note on show" while they have focus. */
  lastFile(): FilePath | null;
  /** Map a Vim normal-mode sequence to a command. */
  vimKey(keys: string, command: string): void;
  onSaved: Array<(path: FilePath) => void>;
  onFocus: Array<(path: FilePath | null) => void>;
  /** An extension's state or error changed. */
  changed(): void;
}

export class ExtensionRuntime {
  readonly host: ExtensionHost;
  private handlers = new Map<string, () => unknown>();
  private renderers = new Map<string, ViewRenderer>();
  private describers: Array<(change: Change) => string | null> = [];

  constructor(private app: RuntimeApp) {
    this.host = new ExtensionHost({
      context: (record, failed) => this.context(record, failed),
      // From the Worker, so `script-src 'self'` allows it; the version makes each change a new address.
      load: (w: WorkspaceExtension, main: string) => import(/* @vite-ignore */ `/extensions/${w.id}/${main}?v=${encodeURIComponent(w.version)}`),
      changed: () => app.changed(),
    });
  }

  /** Read every extension's manifest. */
  load(builtIns: readonly BuiltIn[], files: readonly FileSummary[], disabled: readonly string[], safe: boolean): Promise<void> {
    return this.host.load(builtIns, files, (path) => this.app.offline.read(path), disabled, safe);
  }

  /** Every setting, the app's and installed extensions', on or off: they're all listed, so you can set one before turning it on. */
  catalog(): SettingsCatalog {
    return settingsCatalog(this.host.installed());
  }

  /** Keybindings extensions that are on declare, before the user's and the workspace's. */
  keybindings(): Keybinding[] {
    return this.host.on().flatMap((m) => m.contributes.keybindings.flatMap((k) => ("key" in k ? [{ key: k.key, command: k.command }] : [])));
  }

  /** Commands extensions add to a menu, with their titles. */
  menu(id: MenuId): Array<{ command: string; title: string }> {
    return this.host.on().flatMap((m) => (m.contributes.menus[id] ?? []).map((item) => ({ command: item.command, title: this.titleOf(m, item.command) })));
  }

  private titleOf(m: ExtensionManifest, command: string): string {
    return m.contributes.commands.find((c) => c.command === command)?.title ?? command;
  }

  /** Put in what the manifests of extensions that are on declare: commands, Vim sequences and views. No extension code runs. */
  declare(): void {
    for (const m of this.host.on()) {
      for (const c of m.contributes.commands) this.app.commands.register({ id: c.command, title: c.title, run: () => this.runCommand(c.command) });
      for (const k of m.contributes.keybindings) if ("vim" in k) this.app.vimKey(k.vim, k.command);
      for (const view of Object.values(m.contributes.views).flat()) {
        const declared = {
          id: view.id,
          title: view.name,
          render: async (el: HTMLElement) => {
            await this.activateFor(`onView:${view.id}`, (x) => Object.values(x.contributes.views).flat().some((v) => v.id === view.id));
            const renderer = this.renderers.get(view.id);
            if (renderer) await renderer.render(el);
            else el.textContent = `${m.name} didn't draw this view. Is it turned off, or did it fail to start? See the Extensions view.`;
          },
        };
        // A view shows in the side panel, and also opens in a window: drag its title there, or use its command.
        this.app.panels.register(declared);
        this.app.workbench.registerView(declared);
        this.app.commands.register({ id: `${view.id}.openInWindow`, title: `Open ${view.name} in a window`, run: () => this.app.workbench.openView(view.id, { newTab: true }) });
      }
    }
  }

  /** Start the extensions that start with the app. */
  start(): Promise<void> {
    return this.host.fire("onStartup");
  }

  /** What history's describers say about a change, or null. */
  summary(change: Change): string | null {
    return this.describers.map((d) => d(change)).find((s) => s) ?? null;
  }

  /** Start whichever extension declares something, by its activation event, then wait for it. */
  private async activateFor(event: `onView:${string}` | `onCommand:${string}`, declares: (m: ExtensionManifest) => boolean): Promise<void> {
    await this.host.fire(event);
    // Declaring it is enough to start it, whatever activation events it lists.
    const owner = this.host.owner(declares);
    if (owner && owner.state === "inactive") await this.host.activate(owner);
  }

  private async runCommand(id: string): Promise<unknown> {
    if (!this.handlers.has(id)) await this.activateFor(`onCommand:${id}`, (m) => m.contributes.commands.some((c) => c.command === id));
    const run = this.handlers.get(id);
    if (!run) this.app.workbench.notice(`The command "${id}" isn't available: its extension is off, or didn't start.`);
    return run?.();
  }

  /** The context an extension's code gets: everything it registers is checked against its manifest, and what it throws is reported. */
  private context(record: ExtensionRecord, failed: (err: unknown) => void): ExtensionContext {
    const m = record.manifest;
    const app = this.app;
    const guard = <A extends unknown[], R>(fn: (...args: A) => R, fallback?: R) => guarded(fn, failed, fallback);
    const declaresView = (id: string) => Object.values(m.contributes.views).flat().some((v) => v.id === id);
    const needsEditor = () => {
      if (!m.permissions.editor) throw new Error(`${m.id} needs the "editor" permission in its extension.json to change note editors`);
    };
    return {
      extension: m,
      me: app.me,
      settings: { get: <T>(key: string) => app.settings()[key] as T },
      commands: {
        register: (id, run) => {
          if (!m.contributes.commands.some((c) => c.command === id)) throw new Error(`Command "${id}" isn't declared in ${m.id}'s contributes.commands`);
          this.handlers.set(id, guard(run));
        },
        run: (id) => app.commands.run(id),
        all: () => app.commands.all().map((c) => ({ id: c.id, title: c.title })),
        shortcut: (id) => {
          const key = keyFor(id, app.settings().keybindings);
          return key && formatKeys(key);
        },
      },
      commandBar: {
        provide: (p) => app.bar.provide({ ...p, items: guard((q: string) => p.items(q), []) }),
        open: (text) => app.bar.open(text),
      },
      views: {
        register: (id, renderer) => {
          if (!declaresView(id)) throw new Error(`View "${id}" isn't declared in ${m.id}'s contributes.views`);
          this.renderers.set(id, { render: guard((el: HTMLElement) => renderer.render(el)) });
        },
        provide: (prefix, make) =>
          app.workbench.provideViews(prefix, (id) => {
            const view = guard(make, null)(id);
            return view && { id, title: view.title, render: guard((el: HTMLElement) => view.render(el)) };
          }),
        toggle: (id) => app.panels.toggle(id),
        show: (id) => app.panels.show(id),
        shown: () => app.panels.shown(),
        refresh: (id) => {
          app.panels.refresh(id);
          app.workbench.refreshView(id);
        },
        open: (id, how) => app.workbench.openView(id, how),
      },
      changes: {
        describe: (d) => void this.describers.push(guard(d, null)),
        summary: (change) => this.summary(change),
      },
      editor: {
        extend: (extension) => {
          needsEditor();
          app.workbench.noteExtensions.push(extension);
        },
        focused: () => {
          needsEditor();
          return app.workbench.focusedView;
        },
      },
      files: {
        list: () => app.files(),
        fetchList: () => app.offline.list(),
        read: (path) => app.offline.read(path),
        write: (path, text, base) => app.offline.write(path, text, base),
        upload: (name, data) => api.upload(name, data),
      },
      sources: {
        status: api.sources,
        events: api.events,
        contacts: api.contacts,
        connect: () => location.assign(`/auth/google?data=1&next=${encodeURIComponent(location.pathname + location.search)}`),
      },
      workbench: {
        open: (path, how) => app.workbench.open(path, how),
        openPicked: (path) => app.openFromBar(path),
        // With a view focused (History in a window, say), the file is the one focused last.
        focusedPath: () => app.workbench.focusedPath ?? app.lastFile(),
        refreshFromServer: (paths) => app.workbench.refreshFromServer(paths),
        notice: (message, actions) => app.workbench.notice(message, actions),
      },
      util: { fuzzyFilter, notePathFor: (name) => notePathFor(name), label: docLabel },
      events: {
        onSaved: (fn) => void app.onSaved.push(guard(fn)),
        onFocus: (fn) => void app.onFocus.push(guard(fn)),
      },
    };
  }
}
