// The extension API (ADR 0006). An extension's manifest (extension.json) declares what it adds:
// commands, keybindings, menus, settings and views. Its code, started on one of its activation
// events, gets a context with the handlers' side: what a command does, how a view draws, what the
// command bar lists. Built-in features use exactly this API; see docs/extensions.md for writing one.
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownExtension } from "@lezer/markdown";
import type { EditResult, SourceState, SourceStatus } from "../../worker/src/data-sources.ts";
import type { Calendar, Occurrence, Scope } from "../../worker/src/calendar.ts";
import type { EventFound } from "../../worker/src/operations.ts";
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Change, FilePath, FileSummary, Revision, WorkspaceFile, WriteResult } from "../../worker/src/files.ts";
import type { Contact } from "../../worker/src/sources.ts";
import type { Sandboxed } from "../../worker/src/settings.ts";
export type { Sandboxed };
import type { UploadDone } from "./api.ts";
import type { Item, Provider } from "./commandbar.ts";
import type { Embed } from "./embeds.ts";
import type { MediaHandle, MediaKind, MediaSpec } from "./media.ts";
import type { LinkCard } from "../../worker/src/link-card.ts";
import type { GroupId, Layout, Openable, Tab } from "./layout.ts";
import type { Urgency, WorkbenchChrome } from "./workbench.ts";

export type { Embed, Item, Provider };
export type { MediaHandle, MediaSpec };

/** A session as the controls see it: what it is, whether it plays, and the note it's in. */
export interface MediaInfo {
  id: number;
  title: string;
  kind: MediaKind;
  playing: boolean;
  /** The note it plays in, if it's in one. */
  note: FilePath | null;
}

/** How a trusted extension draws a view straight into the page. Called when it shows, and again when it's refreshed. */
export interface ViewRenderer {
  render(el: HTMLElement): void | Promise<void>;
}

/** A webview: a sandboxed frame an extension writes HTML into, in the app's colours, with messages both ways. */
export interface WebviewHandle {
  /** The page's HTML. Setting it replaces the page. Its scripts get `commonInk.post()` and `commonInk.onMessage()`. */
  html: string;
  post(message: unknown): Promise<void>;
  onMessage(fn: (message: unknown) => void): void;
}

/** How a view draws as a webview, in any extension. Called once when the view first shows; the webview lives on. */
export interface WebviewViewProvider {
  resolve(webview: WebviewHandle): void | Promise<void>;
}

/** How an embed draws: as a webview (`resolve`), in a frame with Stop; or, for trusted extensions, in the page (`render`). Called each time it shows. */
/**
 * How an embed draws: in a webview it resolves (sandboxed extensions, and trusted ones that like), or
 * straight into the page (trusted ones). `update`, if it's there, takes new arguments or body for an
 * embed it already drew (its markdown changed, or its settings were saved), so it isn't drawn again:
 * a frame isn't reloaded. Without it, the embed is drawn again.
 */
export type EmbedProvider =
  | { resolve(webview: WebviewHandle, embed: Embed): void | Promise<void>; update?(webview: WebviewHandle, embed: Embed): void }
  | { render(el: HTMLElement, embed: Embed): void; update?(el: HTMLElement, embed: Embed): void };

/** What a brokered fetch gets back: the text, cut off past 1 MB. */
export interface FetchResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

/** A view made from its id, such as a note at an old revision ("version:12:Plan.md"). */
export interface MadeView extends ViewRenderer {
  title: string;
}

/** An event's fields as an edit gives them (create_event and update_event take the same): null or "" clears one. */
export interface EventInput {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string | null;
  calendar?: string;
  location?: string | null;
  description?: string | null;
  /** A rule as tasks write it (weekly, 1st-tue) or RRULE lines; null stops a series repeating. */
  recurrence?: string | string[] | null;
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
    /** Run a command. `by` runs one a sandboxed extension's contribution names (its key, its menu item) for that extension, so an app-only command refuses. */
    run(id: string, by?: Sandboxed): boolean;
    /** Every command, with its title. */
    all(): Array<{ id: string; title: string }>;
    /** A command's shortcut as shown (⌘P, Ctrl+P), from the keybindings in effect, if it has one. */
    shortcut(id: string): string | undefined;
    /** Every keybinding in effect: keys, and the Vim sequences extensions declare (the Vim extension maps those). */
    keybindings(): Array<{ command: string; key?: string; vim?: string; operator?: true; by?: Sandboxed }>;
    /** The commands extensions add to a menu ("tabMenu", "commandBar", "editorContext", or "quickOpen", which ⌘P lists with files), with their titles. */
    menu(menu: "commandBar" | "tabMenu" | "editorContext" | "quickOpen"): Array<{ command: string; title: string; by?: Sandboxed }>;
  };
  /**
   * The layout of windows and tabs: the core's model (layout.ts), changed with common-ink/layout's
   * helpers. Trusted extensions only; `chrome` needs the "editor" permission.
   */
  layout: {
    /** The layout now: the tree of splits and windows, each window's tabs, and which window has focus. */
    get(): Layout;
    /** Change the arrangement. Files the change brings in are loaded as they show. */
    change(fn: (layout: Layout) => Layout): void;
    /** Close a window's tab, saving its file first; one that can't be saved stays open. */
    close(group: GroupId, index: number): Promise<void>;
    /** Close the focused window's tabs that `which` picks, saving each file first. */
    closeTabs(which: (tab: Tab, index: number, saved: boolean) => boolean): Promise<void>;
    /** Whether a tab has nothing waiting to be saved. */
    isSaved(tab: Tab): boolean;
    /** What a tab shows as its title. */
    title(tab: Openable): string;
    /** Draw the windows' chrome: tab bars, drop targets, borders, empty windows. One extension draws it (the Workbench extension). */
    chrome(chrome: WorkbenchChrome): void;
  };
  /** The status bar items the manifest declares (contributes.statusBarItems). */
  statusBar: {
    /** Show `text` in one of them, or hide it with "". */
    set(id: string, text: string, tooltip?: string): void;
  };
  commandBar: {
    provide(provider: Provider): void;
    open(text?: string): void;
  };
  views: {
    /** How a view the manifest declares draws: as a webview (`resolve`), or, for trusted extensions, in the page (`render`). */
    register(id: string, renderer: ViewRenderer | WebviewViewProvider): void;
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
  /** Embeds: markdown in notes (`::timer{duration=25m}`, `:::kanban` … `:::`, or a fenced block), drawn by the extension that declares them. */
  embeds: {
    /** How an embed language the manifest declares draws. */
    register(language: string, provider: EmbedProvider): void;
  };
  /** Links alone on their own line, drawn as embeds (contributes.urlEmbeds). Trusted extensions with the "editor" permission. */
  urlEmbeds: {
    /** How a URL embed the manifest declares draws, in the page: `match` is its pattern's match (groups included). */
    register(id: string, provider: { render(el: HTMLElement, link: { url: string; match: string[] }): void }): void;
  };
  /**
   * The extension's state, kept in .common-ink/extensions/<id>/state.json as a change by it in history,
   * so it's synced, and survives reloads. Its own; no permission needed.
   */
  state: {
    get(): Promise<unknown>;
    set(value: unknown): Promise<void>;
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
    /** A CodeMirror extension for every note's editor, or with `everywhere`, every editor (settings and code too). Add it while activating. */
    extend(extension: Extension, where?: { everywhere?: boolean }): void;
    /** Add to the markdown language notes are parsed with: a @lezer/markdown extension (new syntax, or how code blocks parse). */
    markdown(extension: MarkdownExtension): void;
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
  /** The clipboard, with the clipboard:read and clipboard:write permissions. */
  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };
  /** System notifications, with the notifications permission. */
  notifications: {
    show(title: string, body?: string): Promise<void>;
  };
  /**
   * What plays (a video, a track, background sound), with the media permission. The mini player, the
   * status bar and the keyboard's media keys control the one played last; a video playing in an embed
   * floats while its note is out of sight ("media.whenHidden").
   */
  media: {
    /** Something that plays. `el` is where it's drawn, if it's in a note's embed. */
    session(spec: MediaSpec): MediaHandle;
    /** What the controls act on: the one played last, while it plays (or keeps its place, like noise). */
    current(): MediaInfo | null;
    /** Call `fn` when anything starts, stops, or changes. */
    onChange(fn: () => void): void;
    /** Play, pause, or stop a session by id. */
    play(id: number): void;
    pause(id: number): void;
    stop(id: number): void;
    /** Show the note a session plays in, scrolled to it. */
    reveal(id: number): void;
  };
  /** The network, through the Worker: only hosts the manifest declares and you've allowed. */
  net: {
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResponse>;
    /** A link's card: its page's title, description, site and picture (as a data: URL), fetched the same way. */
    card(url: string): Promise<LinkCard>;
  };
  /**
   * Data sources (ADR 0007): records from outside the workspace, such as calendar events, kept apart
   * from notes. Reading them asks for data:calendar:read (or data:contacts:read), and changing them
   * for data:calendar:write.
   */
  data: {
    /** Each source's state: connected or not, its last sync, its errors, what it holds, and what's waiting to reach it. */
    status(): Promise<SourceStatus>;
    /** Go to Google to connect calendar and contacts, then come back here. */
    connect(): void;
    /** Bring the calendar's own changes in now (at most twice a minute), after sending edits waiting for it; how it stands after. */
    sync(force?: boolean): Promise<SourceState>;
    calendar: {
      calendars(): Promise<Calendar[]>;
      /** Every time events happen between two times, in your time zone; a series comes once per occurrence. */
      events(from: Date, to: Date, calendars?: string[]): Promise<Occurrence[]>;
      /** One event by its address, as stored or worked out from its series. */
      event(address: string): Promise<EventFound | null>;
      /** Add an event: wall times ("2026-10-05T09:00") or days for all day, as create_event takes them. */
      create(event: EventInput & { title: string; start: string }): Promise<EditResult>;
      /** Change an event; for an occurrence of a series, `scope` says which ones ("this" by default). */
      update(address: string, change: EventInput, scope?: Scope): Promise<EditResult>;
      remove(address: string, scope?: Scope): Promise<EditResult>;
      /** After any record changes, from here, sync, an agent or another tab. */
      onChange(fn: () => void): void;
    };
    contacts: {
      search(query?: string): Promise<Contact[]>;
    };
  };
  workbench: {
    /** Open a file in place of the tab on show, or in a new tab, optionally at a line (0-based). */
    open(path: FilePath, how?: { newTab?: boolean; line?: number }): Promise<void>;
    /** Open a file picked from the command bar, the way the command that opened the bar asked (here, a tab, a split). */
    openPicked(path: FilePath): void;
    focusedPath(): FilePath | null;
    /** Whether the focused file has changes that aren't saved yet. */
    hasUnsavedChanges(): boolean;
    /** Split the focused window, showing `path` in the new one (or what the focused one shows). */
    split(direction: "left" | "right" | "up" | "down", path?: FilePath): Promise<void>;
    /** The focused window's tabs: which one is active (0 is first), and how many. */
    tabs(): { active: number; count: number };
    /** Move the active tab `by` places in its window. */
    moveTab(by: number): void;
    /** Take in server changes to these files, where nothing's waiting to be saved. */
    refreshFromServer(paths: FilePath[]): Promise<void>;
    /** A short message over the focused window, with buttons. An alert (something refused, or gone wrong) isn't replaced by news that comes after it. */
    notice(message: string, actions?: Array<{ label: string; run(): unknown }>, urgency?: Urgency): void;
    /** Whether there's a place to go back (-1) or forward (1) to: what Go back and Go forward would do. */
    canGo(by: -1 | 1): boolean;
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
  /** Other extensions. */
  extensions: {
    /**
     * The API another extension offers (what its activate returned), starting it if it hasn't
     * started. Undefined if it's off, sandboxed, failed or not there: the caller does without.
     */
    api<T>(id: string): Promise<T | undefined>;
  };
  events: {
    /** After a file's text on the server changes, from here or anywhere else. */
    onSaved(fn: (path: FilePath) => void): void;
    /** After the focused tab changes. */
    onFocus(fn: (path: FilePath | null) => void): void;
  };
}

/** An extension's code: its main module's default export. What activate returns is the API it offers other extensions (ctx.extensions.api). */
export interface ExtensionModule {
  activate(ctx: ExtensionContext): unknown;
}
