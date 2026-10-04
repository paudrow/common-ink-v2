// The plugin API. Built-in features use exactly this (ADR 0004): the command bar's providers and the
// history panel are plugins, and settings can turn any plugin off ("plugins.disabled"). See
// docs/plugins.md for writing one.
import type { EditorView } from "@codemirror/view";
import type { WorkspaceFile, FilePath, FileSummary, Revision, WriteResult } from "../../worker/src/files.ts";
import type { Settings } from "../../worker/src/settings.ts";
import type { Item, Provider } from "./commandbar.ts";
import type { Command } from "./commands.ts";

export type { Command, Item, Provider };

/** A view in the side panel, such as History. One panel shows at a time. */
export interface Panel {
  id: string;
  title: string;
  /** Draw into `el`. Called when the panel opens and when `refresh` is asked for. */
  render(el: HTMLElement): void | Promise<void>;
}

export interface PluginContext {
  /** The signed-in person's email, if a person is signed in. */
  me: string | undefined;
  settings(): Settings;
  commands: {
    register(...commands: Command[]): void;
    run(id: string): boolean;
    all(): Command[];
  };
  commandBar: {
    provide(provider: Provider): void;
    open(text?: string): void;
  };
  panels: {
    register(panel: Panel): void;
    /** Show a panel, or hide it if it's showing. */
    toggle(id: string): void;
    /** Show a panel (drawing it again if it's showing already). */
    show(id: string): void;
    /** The panel showing, if any. */
    shown(): string | null;
    /** Draw a panel again if it's showing. */
    refresh(id: string): void;
  };
  files: {
    /** Every file, as last listed. */
    list(): FileSummary[];
    read(path: FilePath): Promise<WorkspaceFile>;
    write(path: FilePath, text: string, base: Revision): Promise<WriteResult>;
  };
  workbench: {
    /** Open a file in place of the tab on show, or in a new tab. */
    open(path: FilePath, how?: { newTab?: boolean }): Promise<void>;
    /** Open a file picked from the command bar, the way the command that opened the bar asked (here, a tab, a split). */
    openPicked(path: FilePath): void;
    focusedPath(): FilePath | null;
    focusedView(): EditorView | null;
    /** Take in server changes to these files, where nothing's waiting to be saved. */
    refreshFromServer(paths: FilePath[]): Promise<void>;
    label(path: FilePath): string;
  };
  events: {
    /** After a file's text on the server changes from this app. */
    onSaved(fn: (path: FilePath) => void): void;
    /** After the focused tab changes. */
    onFocus(fn: (path: FilePath | null) => void): void;
  };
}

export interface Plugin {
  /** Settings name plugins by id, as in "plugins.disabled": ["history"]. */
  id: string;
  description: string;
  activate(ctx: PluginContext): void;
}

/** Activate every plugin that settings haven't turned off. Returns the ids that are active. */
export function activate(plugins: readonly Plugin[], ctx: PluginContext, disabled: readonly string[]): string[] {
  const active: string[] = [];
  for (const plugin of plugins) {
    if (disabled.includes(plugin.id)) continue;
    try {
      plugin.activate(ctx);
      active.push(plugin.id);
    } catch (err) {
      console.error(`Plugin ${plugin.id} didn't start:`, err);
    }
  }
  return active;
}
