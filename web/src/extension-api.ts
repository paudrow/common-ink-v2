// The extension API (ADR 0006). An extension's manifest (extension.json) declares what it adds:
// commands, keybindings, menus, settings and views. Its code, started on one of its activation
// events, gets a context with the handlers' side: what a command does, how a view draws, what the
// command bar lists. Built-in features use exactly this API; see docs/extensions.md for writing one.
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SourceStatus } from "../../worker/src/data-sources.ts";
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Change, FilePath, FileSummary, Revision, WorkspaceFile, WriteResult } from "../../worker/src/files.ts";
import type { Contact, Event } from "../../worker/src/sources.ts";
import type { UploadDone } from "./api.ts";
import type { Item, Provider } from "./commandbar.ts";

export type { Item, Provider };

/** How a view draws. Called when the view shows, and again when it's refreshed. */
export interface ViewRenderer {
  render(el: HTMLElement): void | Promise<void>;
}

/** A view made from its id, such as a note at an old revision ("version:12:Plan.md"). */
export interface MadeView extends ViewRenderer {
  title: string;
}

export interface ExtensionContext {
  /** This extension, as its manifest says. */
  extension: ExtensionManifest;
  /** The signed-in person's email, if a person is signed in. */
  me: string | undefined;
  settings: {
    /** A setting's value in effect now: the app's, or any extension's. */
    get<T = unknown>(key: string): T;
  };
  commands: {
    /** What a command the manifest declares does. */
    register(id: string, run: () => unknown): void;
    run(id: string): boolean;
    /** Every command, with its title. */
    all(): Array<{ id: string; title: string }>;
    /** A command's shortcut as shown (⌘P, Ctrl+P), from the keybindings in effect, if it has one. */
    shortcut(id: string): string | undefined;
  };
  commandBar: {
    provide(provider: Provider): void;
    open(text?: string): void;
  };
  views: {
    /** How a view the manifest declares draws. */
    register(id: string, renderer: ViewRenderer): void;
    /** Views whose ids start with `prefix`, made from the id when one opens (and after a reload). */
    provide(prefix: string, make: (id: string) => MadeView | null): void;
    /** Show a view in the side panel, or hide it if it's showing. */
    toggle(id: string): void;
    /** Show a view in the side panel (drawing it again if it's showing already). */
    show(id: string): void;
    /** The view the side panel shows, if any. */
    shown(): string | null;
    /** Draw a view again, wherever it's showing. */
    refresh(id: string): void;
    /** Open a view in the focused window, in place of the tab on show or in a new tab. */
    open(id: string, how?: { newTab?: boolean }): void;
  };
  /** What changes mean, in words, for history: each extension describes the changes it knows about. */
  changes: {
    /** Add a describer: a few words for a change ("Completed 'Pay rent'"), or null if it isn't one this extension knows. */
    describe(describer: (change: Change) => string | null): void;
    /** What the describers say about a change, or null if none of them knows it. */
    summary(change: Change): string | null;
  };
  /** Note editors. Trusted extensions that declare the "editor" permission only. */
  editor: {
    /** A CodeMirror extension for every note's editor. Add it while activating. */
    extend(extension: Extension): void;
    /** The focused note's editor, if a note has focus. */
    focused(): EditorView | null;
  };
  files: {
    /** Every file, as last listed. */
    list(): FileSummary[];
    /** Every file, asked of the server now. */
    fetchList(): Promise<FileSummary[]>;
    read(path: FilePath): Promise<WorkspaceFile>;
    write(path: FilePath, text: string, base: Revision): Promise<WriteResult>;
    /** Upload a file (an image, a PDF…); its address goes in notes as /uploads/<name>. Throws if it can't be uploaded. */
    upload(name: string, data: Blob): Promise<UploadDone>;
  };
  /** Data sources: outside data shown but not stored as files. They answer for the signed-in person. */
  sources: {
    /** "google" when connected, "fixtures" for sample data (Previews), "none" when not connected yet. */
    status(): Promise<SourceStatus>;
    events(from: Date, to: Date): Promise<Event[]>;
    contacts(query?: string): Promise<Contact[]>;
    /** Go to Google to connect calendar and contacts, then come back. */
    connect(): void;
  };
  workbench: {
    /** Open a file in place of the tab on show, or in a new tab, optionally at a line (0-based). */
    open(path: FilePath, how?: { newTab?: boolean; line?: number }): Promise<void>;
    /** Open a file picked from the command bar, the way the command that opened the bar asked (here, a tab, a split). */
    openPicked(path: FilePath): void;
    focusedPath(): FilePath | null;
    /** Take in server changes to these files, where nothing's waiting to be saved. */
    refreshFromServer(paths: FilePath[]): Promise<void>;
    /** A short message over the focused window, with buttons. */
    notice(message: string, actions?: Array<{ label: string; run(): unknown }>): void;
  };
  /** Helpers the built-ins use, so a copy of one runs as a workspace extension with nothing to import. */
  util: {
    /** The items that fuzzily match `query`, best first. */
    fuzzyFilter<T>(query: string, items: readonly T[], text: (item: T) => string): T[];
    /** The note a name like "Projects/Plan" means, or null if it can't be one. */
    notePathFor(name: string): FilePath | null;
    /** A file's name as people see it: "Projects/Plan", "User settings". */
    label(path: FilePath): string;
  };
  events: {
    /** After a file's text on the server changes, from here or anywhere else. */
    onSaved(fn: (path: FilePath) => void): void;
    /** After the focused tab changes. */
    onFocus(fn: (path: FilePath | null) => void): void;
  };
}

/** An extension's code: its main module's default export. */
export interface ExtensionModule {
  activate(ctx: ExtensionContext): void | Promise<void>;
}
