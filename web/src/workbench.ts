// The windows on screen: the layout model (layout.ts) drawn as split windows of tabs. A file's tab holds
// an editor; a view's tab holds whatever its extension draws. A file open in several tabs has one
// Session, and an edit in one tab is copied to the others. The layout is saved as a JSON file a moment
// after it changes. This is the core of it (ADR 0006): on its own it draws each window's tab on show,
// and nothing else. The chrome (tab bars, dragging, the borders that resize windows, what an empty
// window says) is drawn by an extension, the default Workbench extension, through setChrome.
import { Compartment, EditorSelection, Transaction, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { isExtensionScript, isNote, merge, type FilePath, type Revision, type WriteResult } from "../../worker/src/files.ts";
import type { Offline, Unsent } from "./offline.ts";
import { keptWhen } from "./conflict.ts";
import { docLabel } from "./describe.ts";
import { DEFAULTS, isReadOnly, type Settings } from "../../worker/src/settings.ts";
import { createState, forgetHistory, fromServer, reconfigure, replaceText, synced } from "./editor.ts";
import { Navigation, NEAR_LINES, type Place, type Visit } from "./navigation.ts";
import * as L from "./layout.ts";
import { layoutProblems } from "./layout-problems.ts";
import { checkInvariant } from "./invariants.ts";
import { drawSafely } from "./boundary.ts";
import { Session, type SaveStatus } from "./session.ts";

const RETRY_MS = 5000;
const LAYOUT_SAVE_MS = 1500;

interface OpenFile {
  path: FilePath;
  session: Session;
  views: Set<EditorView>;
  timer: number;
  /** Whether the server has it yet. A file opened by name starts out unsaved. */
  exists: boolean;
  /**
   * The file's text while no editor shows it: at first the file, or this browser's unsent edit to it;
   * then what its last editor showed when it went, for a save still to come or the next editor.
   */
  startText: string;
  /** When the edit it opened with was kept, if that edit clashed: one that never reached the server. */
  keptAt?: number;
  /** An edit held offline that it opened with, before the server could say whether it has it. */
  unchecked?: Unsent;
}

/** Something an extension draws in a window's tab, such as History. */
export interface View {
  id: string;
  title: string;
  render(el: HTMLElement): void | Promise<void>;
}

/** A window's tab, as its chrome shows it. */
export interface TabInfo {
  /** Stable for as long as the tab shows the same thing (layout.openableKey). */
  key: string;
  label: string;
  title: string;
  selected: boolean;
  preview: boolean;
  /** A save status other than saved. */
  status?: string;
}

/**
 * What draws around the windows: an extension's (the Workbench extension's). Each part is optional;
 * without one, the core's plain version stands in, or nothing does.
 */
export interface WorkbenchChrome {
  /** A window was made (a `section.group` holding `.editors`): add a tab bar, drop targets. Elements the chrome adds in `.editors` need the class `chrome`. */
  window?(el: HTMLElement, group: L.GroupId): void;
  /** A window's tabs, or their titles or save status, changed. */
  tabs?(el: HTMLElement, group: L.GroupId, tabs: TabInfo[]): void;
  /** The border between two windows of the split at `path` (child indexes from the root), before child `index`. */
  divider?(container: HTMLElement, path: number[], index: number): HTMLElement;
  /** What an empty window shows. */
  empty?(): HTMLElement;
}

export interface WorkbenchEvents {
  /** The focused tab's save status, or a message about it. */
  status(status: SaveStatus | null, message?: string): void;
  /** What the focused tab shows changed. */
  focus(path: FilePath | null): void;
  /** A file was saved for the first time, so lists of files are out of date. */
  created(path: FilePath): void;
  /** A file's text on the server changed. */
  saved(path: FilePath): void;
  /** How a command's shortcut is shown (⌘P, Ctrl+P), if it has one: from the keybindings in effect. */
  shortcut(command: string): string | undefined;
  /** Where you are changed: a jump to a new place ("push"), or where you are, updated ("replace"). */
  navigated?(how: "push" | "replace", visit: Visit): void;
}

const key = (group: L.GroupId, item: L.Openable) => `${group}\n${L.openableKey(item)}`;

/** Where extensions' CodeMirror extensions go in each editor, so ones added later reach editors already open. */
const extensionSlot = new Compartment();
const label = docLabel;

export class Workbench {
  layout: L.Layout = L.emptyLayout();
  private files = new Map<FilePath, OpenFile>();
  /** Each tab's editor, by group and file. */
  private views = new Map<string, EditorView>();
  /** Each view tab's box, by group and view. */
  private viewBoxes = new Map<string, HTMLElement>();
  private registered = new Map<string, View>();
  /** Views made on demand from their id, such as a file at an old revision. */
  private providers: Array<{ prefix: string; make(id: string): View | null }> = [];
  private groupEls = new Map<L.GroupId, HTMLElement>();
  /** Going back to a place: what that changes isn't a jump of its own. */
  private returning = false;
  private layoutRevision = 0;
  private pendingNotice: [string, Array<{ label: string; run: () => unknown }>] | null = null;
  /** Whether start() has loaded the layout: until then, the live socket's news of it is start's to read. */
  private started = false;
  /** Editor extensions for one file's editors, such as help in a settings file. */
  extensionsFor: (path: FilePath) => Extension[] = () => [];
  private layoutTimer = 0;
  /** A layout save is on its way, so news of it coming back isn't someone else's change. */
  private layoutSaving = false;
  private settings: Settings = DEFAULTS;
  /** Extensions' CodeMirror extensions, for every note's editor. */
  private noteExtensions: Extension[] = [];
  /** Extensions' CodeMirror extensions for every editor, notes and settings and code alike (Vim keys). */
  private allExtensions: Extension[] = [];
  /** The arrangement of windows on screen, to tell when it has to be rebuilt. */
  private shape = "";
  private chrome: WorkbenchChrome | null = null;
  /** Where this device's layout is kept (devices/<id>/layout.json), or the workspace's where there's no device file. */
  layoutPath: FilePath = L.LAYOUT_PATH;
  /** The layout a device starts from when it has none of its own yet. */
  firstLayout: () => Promise<L.Layout | null> = async () => null;
  /** Which parts of the layout show on this device: tabs, and windows side by side. What doesn't is put away, and kept. */
  parts: () => Parts = () => ({ tabs: true, splits: true });
  /** Whether a note that opens takes focus, so you can type at once. */
  focusOnOpen: () => boolean = () => true;
  private shown: Parts = { tabs: true, splits: true };

  constructor(
    private host: HTMLElement,
    private on: WorkbenchEvents,
    /** Files from the server, or as last seen while it can't be reached. */
    private net: Offline,
    /** Where you've been, across every window (navigation.ts): kept by the app, across reloads. */
    readonly navigation = new Navigation(),
  ) {}

  /** Load the saved layout and its files, then show `first` if asked. */
  /**
   * Load the saved layout and its files, then show `first` (the file the address names): its tab if
   * the layout has one, or a preview tab if the file exists. A file that doesn't exist isn't opened;
   * it comes back as `missing`, for the app to say so.
   */
  async start(first?: FilePath | null): Promise<{ missing?: FilePath }> {
    const saved = await this.net.read(this.layoutPath);
    this.layoutRevision = saved.revision;
    let layout = (saved.text && L.parseLayout(safeJson(saved.text))) || (saved.revision === 0 && (await this.firstLayout())) || L.emptyLayout();
    await Promise.all([...new Set(L.groups(layout).flatMap((g) => g.tabs.flatMap((t) => ("file" in t ? [t.file] : []))))].map((p) => this.load(p)));
    let missing: FilePath | undefined;
    if (first) {
      const open = L.groups(layout).find((g) => g.tabs.some((t) => "file" in t && t.file === first));
      if (open) layout = L.selectTab(layout, open.id, open.tabs.findIndex((t) => "file" in t && t.file === first));
      else if ((await this.load(first)).exists) layout = L.showInTab(layout, first);
      else missing = first;
    }
    this.setLayout(layout, { save: false });
    // Where the page opened is the first place (or, after a reload, where you were, brought up to date).
    this.arrive(false);
    this.started = true;
    if (this.pendingNotice) this.notice(...this.pendingNotice);
    this.pendingNotice = null;
    return { missing };
  }

  /** Draw the windows with this chrome from now on (the Workbench extension's), rebuilding them. */
  setChrome(chrome: WorkbenchChrome | null): void {
    this.chrome = chrome;
    this.groupEls.clear();
    this.shape = "";
    if (this.started) this.render();
  }

  /** A message in the focused window, with buttons, until its tabs change. */
  notice(message: string, actions: Array<{ label: string; run: () => unknown }> = []): void {
    const editors = this.groupEls.get(this.layout.focus)?.querySelector<HTMLElement>(".editors");
    // Before there's a window to show it in (an extension starting with the app, say): show it once there is.
    if (!editors) return void (this.pendingNotice = [message, actions]);
    const box = document.createElement("div");
    box.className = "notice";
    box.setAttribute("role", "status");
    const p = document.createElement("p");
    p.textContent = message;
    box.append(p);
    for (const a of actions) {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.addEventListener("click", () => {
        box.remove();
        void a.run();
      });
      box.append(b);
    }
    editors.querySelector(".notice")?.remove();
    editors.prepend(box);
  }

  get focusedGroup(): L.Group {
    return L.focused(this.layout);
  }

  get focusedPath(): FilePath | null {
    return L.activeFile(this.focusedGroup);
  }

  get focusedView(): EditorView | null {
    const path = this.focusedPath;
    return path ? (this.views.get(key(this.layout.focus, L.fileTab(path))) ?? null) : null;
  }

  get focusedSession(): Session | null {
    const path = this.focusedPath;
    return path ? (this.files.get(path)?.session ?? null) : null;
  }

  isOpen(path: FilePath): boolean {
    return this.files.has(path);
  }

  /** When a note's clashing edit was kept, if it's one it opened with that never reached the server. */
  keptAt(path: FilePath): number | undefined {
    return this.files.get(path)?.keptAt;
  }

  /** Every file that isn't saved, for the page closing to send. Not one that clashes: it's held, to settle. */
  unsaved() {
    return [...this.files.values()].flatMap((d) => (d.session.status === "conflict" || !d.session.unsaved ? [] : [d.session.unsaved]));
  }

  /** What's still to reach the server, with why: open files not yet saved, and the layout while its save waits. */
  pending(): Array<{ path: FilePath; status: SaveStatus | "waiting" }> {
    const files = [...this.files.values()].filter((f) => f.session.dirty || f.session.status === "saving").map((f) => ({ path: f.path, status: f.session.status }));
    return this.layoutTimer || this.layoutSaving ? [...files, { path: this.layoutPath, status: "waiting" }] : files;
  }

  /**
   * Show a file in the focused group: in place of the tab on show, as Vim's `:e` does, or in a new tab.
   * The file on show is saved first; if it can't be, it stays.
   */
  async open(path: FilePath, how: { newTab?: boolean; pos?: number; line?: number; jump?: boolean } = {}): Promise<void> {
    const from = this.here();
    // The preview tab is the one a newly opened file replaces: save what it shows first.
    const preview = this.focusedGroup.tabs.find((t) => t.preview);
    const replaced = preview && "file" in preview ? preview.file : null;
    if (!how.newTab && replaced && replaced !== path && !(await this.saveToLeave(replaced))) return;
    await this.load(path);
    const layout = how.newTab ? L.openTab(this.layout, path) : L.showInTab(this.layout, path);
    this.setLayout(layout);
    const view = this.focusedView;
    if (view && how.line !== undefined) how.pos = view.state.doc.line(Math.min(how.line + 1, view.state.doc.lines)).from;
    if (view && how.pos !== undefined) {
      view.dispatch({ selection: EditorSelection.cursor(Math.min(how.pos, view.state.doc.length)), scrollIntoView: true });
    }
    // Opening a file is a jump: a place of its own to come back to, after the one it was opened from.
    if (from?.file !== path || how.pos !== undefined) this.arrive(how.jump !== false);
  }

  /** Show this editor's tab, focused, and scroll to `pos` in it (a floating video's Back to note). */
  reveal(view: EditorView, pos: number | null): void {
    const at = [...this.views].find(([, v]) => v === view)?.[0];
    if (!at) return;
    const [id, item] = at.split("\n");
    const group = L.groups(this.layout).find((g) => g.id === id);
    const index = group?.tabs.findIndex((t) => L.openableKey(t) === item) ?? -1;
    if (!group || index < 0) return;
    this.change((l) => L.selectTab(l, group.id, index));
    view.focus();
    // Once its tab shows: scrolled while hidden, the editor would keep the scroll for later, and do it on the next scroll of yours.
    if (pos !== null) requestAnimationFrame(() => view.dispatch({ effects: EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: "center" }) }));
  }

  /** Focus the window this editor is in, as focus coming into it does (an embed's box is outside it, in the layer). */
  focusView(view: EditorView): void {
    const at = [...this.views].find(([, v]) => v === view)?.[0];
    const id = at?.split("\n")[0];
    if (id && this.layout.focus !== id) this.setLayout(L.focusGroup(this.layout, id));
  }

  /** Show an extension's view in the focused group, in place of the tab on show or in a new tab. */
  openView(id: string, how: { newTab?: boolean } = {}): void {
    const item = { view: id };
    this.setLayout(how.newTab ? L.insertTab(this.layout, item) : L.showInTab(this.layout, item));
  }

  /** Views that can open in windows. Extensions register them. */
  registerView(view: View): void {
    this.registered.set(view.id, view);
  }

  /** Views whose ids start with `prefix`, made from the id when one opens (and after a reload). */
  provideViews(prefix: string, make: (id: string) => View | null): void {
    this.providers.push({ prefix, make });
  }

  private viewFor(id: string): View | undefined {
    const known = this.registered.get(id);
    if (known) return known;
    const made = this.providers.find((p) => id.startsWith(p.prefix))?.make(id);
    if (made) this.registered.set(id, made);
    return made ?? undefined;
  }

  /** Draw a view again, wherever it's showing. */
  refreshView(id: string): void {
    for (const [k, box] of this.viewBoxes) if (k.endsWith(`\nview:${id}`) && !box.hidden) this.drawView(id, box);
  }

  /** Close a tab (`:q` closes the focused one). A file that can't be saved stays open. */
  async closeTab(id = this.layout.focus, index?: number): Promise<void> {
    const group = L.groups(this.layout).find((g) => g.id === id);
    if (!group) return;
    const at = index ?? group.active;
    const tab = group.tabs[at];
    if (tab && "file" in tab && !(await this.saveToLeave(tab.file))) return;
    this.setLayout(L.closeTab(this.layout, id, at));
  }

  /** Close the focused group and its tabs (Vim's Ctrl-W c), saving each first. */
  async closeGroup(): Promise<void> {
    const group = this.focusedGroup;
    for (const tab of group.tabs) if ("file" in tab && !(await this.saveToLeave(tab.file))) return;
    if (L.groups(this.layout).length === 1) this.setLayout({ ...this.layout, root: { ...group, tabs: [], active: 0 } });
    else this.setLayout(group.tabs.reduce((l) => L.closeTab(l, group.id, 0), this.layout));
  }

  split(where: L.Direction, path?: FilePath): void {
    this.setLayout(L.split(this.layout, where, path));
  }

  /** Change the arrangement. A change that changes nothing (selecting the tab on show) only focuses it. */
  change(fn: (layout: L.Layout) => L.Layout): void {
    const next = fn(this.layout);
    if (JSON.stringify(next) === JSON.stringify(this.layout)) this.afterFocus();
    else this.setLayout(next);
  }

  /**
   * Go back to a place you were (by its id, from the browser's history or the app's own Back and
   * Forward): its window, if it's still there, or else the one focused; its file, in its tab, or its
   * preview tab again, or a new one; and its cursor. False if it's no longer kept.
   */
  async goTo(id: number): Promise<boolean> {
    const visit = this.navigation.goTo(id);
    if (!visit) return false;
    const from = this.focusedPath;
    if (from && from !== visit.file && !(await this.saveToLeave(from))) return true;
    const window = L.groups(this.layout).some((g) => g.id === visit.window) ? visit.window : this.layout.focus;
    let layout = L.focusGroup(this.layout, window);
    const group = L.groups(layout).find((g) => g.id === window)!;
    const tab = group.tabs.findIndex((t) => "file" in t && t.file === visit.file);
    if (tab >= 0) layout = L.selectTab(layout, window, tab);
    else {
      await this.load(visit.file);
      layout = visit.preview ? L.showInTab(layout, visit.file, window) : L.openTab(layout, visit.file, window);
    }
    this.returning = true;
    try {
      this.setLayout(layout);
      const view = this.focusedView;
      if (view) view.dispatch({ selection: EditorSelection.cursor(Math.min(visit.pos, view.state.doc.length)), scrollIntoView: true });
    } finally {
      this.returning = false;
    }
    return true;
  }

  /** Back (-1) or forward (1) a place, here in the app; the browser's own Back goes through goTo. */
  async go(by: -1 | 1): Promise<boolean> {
    const to = this.navigation.step(by);
    return !!to && this.goTo(to.id);
  }

  async reload(): Promise<void> {
    const path = this.focusedPath;
    const file = path && this.files.get(path);
    if (!file) return;
    file.session.reload(await this.net.read(file.path));
    await this.net.letGoOwn(file.path);
  }

  /** Take in what changed on the server for these files, where nothing is waiting to be saved. */
  async refreshFromServer(paths: FilePath[]): Promise<void> {
    await Promise.all(
      paths.map(async (path) => {
        const file = this.files.get(path);
        if (file && !file.session.dirty) file.session.reload(await this.net.read(path));
      }),
    );
  }

  /**
   * Someone else changed a file (an agent, another tab or device). An open file takes in the new
   * version, merged with any typing not yet saved; the layout takes in the new arrangement. Returns
   * whether the file is open here.
   */
  async remoteChange(path: FilePath, revision: number): Promise<boolean> {
    if (path === this.layoutPath) {
      if (!this.started || revision <= this.layoutRevision || this.layoutSaving) return false;
      const saved = await this.net.read(this.layoutPath);
      const layout = L.parseLayout(safeJson(saved.text));
      this.layoutRevision = saved.revision;
      if (layout) this.setLayout(layout, { save: false });
      return false;
    }
    const file = this.files.get(path);
    if (!file || revision <= file.session.revision) return !!file;
    await file.session.absorb(await this.net.read(path));
    return true;
  }

  save(explicit = false): Promise<void> | undefined {
    return this.focusedSession?.save(explicit);
  }

  /** Add an extension's CodeMirror extension to every note's editor (or with `everywhere`, every editor), open now or later. */
  extend(extension: Extension, everywhere = false): void {
    if (everywhere) this.allExtensions = [...this.allExtensions, extension];
    else this.noteExtensions = [...this.noteExtensions, extension];
    for (const file of this.files.values()) for (const view of file.views) view.dispatch({ effects: extensionSlot.reconfigure(this.extensionsOf(file.path)) });
  }

  private extensionsOf(path: FilePath): Extension[] {
    return [...this.allExtensions, ...(isNote(path) ? this.noteExtensions : [])];
  }

  /** Use new settings in every editor, open now or later. */
  applySettings(settings: Settings): void {
    this.settings = settings;
    for (const view of this.views.values()) reconfigure(view, settings);
    // Tab bars may draw by settings (the Workbench extension's back and forward arrows).
    this.renderTabs();
    // Empty windows list shortcuts, which settings may have rebound.
    for (const el of this.groupEls.values()) el.querySelector(".window-empty")?.replaceWith(this.emptyState());
  }

  focus(): void {
    this.focusedView?.focus();
  }

  /** Where you are: the focused window, its file on show, and the cursor in it. */
  private here(): Place | null {
    const file = this.focusedPath;
    const view = this.focusedView;
    if (!file || !view) return null;
    const pos = view.state.selection.main.head;
    const tab = this.focusedGroup.tabs[this.focusedGroup.active];
    return { window: this.layout.focus, file, pos, line: view.state.doc.lineAt(pos).number, ...(tab?.preview ? { preview: true } : {}) };
  }

  /** You're somewhere: a new place if it's a jump (and not a return to one), or else where you are, updated. */
  private arrive(jump: boolean): void {
    const place = this.here();
    if (!place) return;
    const { how, visit } = this.navigation.arrive(place, jump && !this.returning);
    this.on.navigated?.(how, visit);
    // Somewhere new to go back to: tab bars that show back and forward say so.
    if (how === "push") this.renderTabs();
  }

  private async saveToLeave(path: FilePath): Promise<boolean> {
    const file = this.files.get(path);
    if (!file) return true;
    clearTimeout(file.timer);
    await file.session.save();
    if (!file.session.dirty) return true;
    this.on.status(file.session.status, `${label(path)} isn't saved, so it's still open. :w tries again; :e! loads the saved version.`);
    return false;
  }

  /** Fetch a file and start its session, unless it's open already. */
  async load(path: FilePath): Promise<OpenFile> {
    const open = this.files.get(path);
    if (open) return open;
    const fetched = await this.net.read(path);
    // An edit kept in this browser that the server doesn't have: it picks up where it left off, on its
    // old base, or shows as a clash when the note has moved on since.
    const kept = await this.net.keptEdit(fetched);
    const again = this.files.get(path);
    if (again) return again;
    const held = kept?.edit;
    const startText = held?.text ?? fetched.text;
    const file: OpenFile = {
      path,
      views: new Set(),
      timer: 0,
      exists: fetched.revision > 0,
      startText,
      session: new Session(
        held ? { ...fetched, revision: held.base } : fetched,
        {
          text: () => this.primary(file)?.state.doc.toString() ?? file.startText,
          replace: (text, remote) => {
            const view = this.primary(file);
            if (view) replaceText(view, text, remote);
            else file.startText = text;
          },
        },
        (path, text, base, edit) => (file.unchecked ? this.firstSend(file, file.unchecked, path, text, base, edit) : this.net.write(path, text, base, edit)),
        (status) => this.statusChanged(file, status),
        kept?.clash ? "conflict" : "saved",
        held?.edit ? { id: held.edit, text: held.text } : null,
      ),
    };
    this.files.set(path, file);
    if (held && !kept.clash) file.timer = window.setTimeout(() => void file.session.save(), 0);
    if (kept?.clash) file.keptAt = held?.time ?? Date.now();
    if (kept && !kept.checked) file.unchecked = kept.edit;
    if (path === this.focusedPath) this.on.status(file.session.status, this.saying(file));
    return file;
  }

  /**
   * The first save of a note opened offline with a held edit, once the server can be asked, goes by
   * keptEdit's rule: on the server's latest revision, it's sent; there already, what's been typed
   * since goes onto the note as it is now; and a note that's moved on without it is a clash.
   */
  private async firstSend(file: OpenFile, held: Unsent, path: FilePath, text: string, base: Revision, edit: string): Promise<WriteResult> {
    const latest = await this.net.latest(path);
    const verdict = await this.net.verdict(held, latest, true);
    file.unchecked = undefined;
    if (verdict === "send") return this.net.write(path, text, base, edit);
    if (verdict === "clash") {
      file.keptAt = held.time ?? Date.now();
      return { status: "conflict", file: latest };
    }
    const typed = text === held.text ? latest.text : merge(text, held.text, latest.text);
    if (typed === null) return { status: "conflict", file: latest };
    return typed === latest.text ? { status: "saved", file: latest } : this.net.write(path, typed, latest.revision);
  }

  /** What the status bar says of a file's save, when it isn't the usual: an edit it opened with that never got there. */
  private saying(file: OpenFile): string | undefined {
    if (file.session.status === "conflict" && file.keptAt !== undefined) return `Unsaved edit from ${keptWhen(file.keptAt)}: the note changed since. Restore or discard it.`;
  }

  private primary(file: OpenFile): EditorView | undefined {
    return file.views.values().next().value;
  }

  /** Keep an edit that clashes with the server's in this browser, as it is now, so a reload doesn't lose it. */
  private holdClash(file: OpenFile) {
    const unsent = file.session.unsaved;
    if (unsent) void this.net.hold({ ...unsent, conflict: true });
  }

  private statusChanged(file: OpenFile, status: SaveStatus) {
    if (status === "conflict") this.holdClash(file);
    if (status === "offline") {
      clearTimeout(file.timer);
      file.timer = window.setTimeout(() => void file.session.save(), RETRY_MS);
      // Held until it reaches the server, so closing the page doesn't lose it.
      const unsent = file.session.unsaved;
      if (unsent) void this.net.hold(unsent);
    }
    if (status === "saved") file.keptAt = undefined;
    if (status === "saved" && !file.session.dirty) void this.net.letGoOwn(file.path);
    if (status === "saved" && !file.exists && file.session.revision > 0) {
      file.exists = true;
      this.on.created(file.path);
    }
    if (status === "saved") this.on.saved(file.path);
    this.renderTabs();
    if (file.path === this.focusedPath) this.on.status(status, this.saying(file));
  }

  private viewUpdate(file: OpenFile, view: EditorView, u: ViewUpdate) {
    // The cursor moved in the editor you're in: far, it's a jump (Vim's G, a search); near, you're still here.
    if (u.selectionSet && view === this.focusedView) {
      const lineOf = (state: typeof u.state) => state.doc.lineAt(state.selection.main.head).number;
      this.arrive(!u.docChanged && Math.abs(lineOf(u.state) - lineOf(u.startState)) > NEAR_LINES);
    }
    if (!u.docChanged) return;
    const copied = u.transactions.some((tr) => tr.annotation(synced));
    if (copied) return;
    for (const other of file.views) {
      if (other !== view) other.dispatch({ changes: u.changes, annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
    }
    if (u.transactions.some((tr) => tr.annotation(fromServer))) return;
    const clashed = file.session.status === "conflict";
    file.session.edited();
    if (file.session.status === "conflict") this.holdClash(file);
    const draft = file.session.unsaved;
    // Back to the text it's based on (an undo, say): what was kept of an edit since, as a draft or held
    // offline, is no edit now.
    if (draft) void this.net.keepDraft(draft);
    else void this.net.letGoOwn(file.path);
    // A clash undone: the note takes in the server's latest, which it held off while it clashed.
    if (clashed && file.session.status !== "conflict") {
      // Its undo and redo steps are of text theirs has replaced: they'd land in the wrong places.
      queueMicrotask(() => file.views.forEach(forgetHistory));
      const takeTheirs = (): void =>
        void this.net.latest(file.path).then(
          (latest) => file.session.absorb(latest),
          // Offline: theirs is taken in once the page is back online.
          () => addEventListener("online", takeTheirs, { once: true }),
        );
      takeTheirs();
    }
    // Editing a file keeps its preview tabs open.
    if (L.groups(this.layout).some((g) => g.tabs.some((t) => t.preview && "file" in t && t.file === file.path))) this.setLayout(L.keepFile(this.layout, file.path));
    clearTimeout(file.timer);
    file.timer = window.setTimeout(() => void file.session.save(), this.settings["editor.saveDelay"]);
  }

  private makeEditor(group: L.GroupId, file: OpenFile): EditorView {
    const text = this.primary(file)?.state.doc.toString() ?? file.startText;
    const view: EditorView = new EditorView({
      state: createState(text, {
        path: file.path,
        json: file.path.endsWith(".json"),
        code: isExtensionScript(file.path),
        readOnly: isReadOnly(file.path),
        settings: this.settings,
        extensions: [extensionSlot.of(this.extensionsOf(file.path)), ...this.extensionsFor(file.path)],
        onUpdate: (u) => this.viewUpdate(file, view, u),
        onBlur: () => void file.session.save(),
      }),
    });
    // CodeMirror's own styles fix the editor's display and position, so each sits in a box of ours.
    const box = document.createElement("div");
    box.className = "tab-editor";
    box.dataset.group = group;
    box.append(view.dom);
    file.views.add(view);
    this.views.set(key(group, L.fileTab(file.path)), view);
    return view;
  }

  private dropView(k: string, view: EditorView) {
    this.views.delete(k);
    // A save can still come once it's gone (its blur saves): it sends what this showed, not the text the file opened with.
    for (const file of this.files.values()) if (file.views.delete(view) && !file.views.size) file.startText = view.state.doc.toString();
    view.destroy();
  }

  private setLayout(layout: L.Layout, { save = true } = {}) {
    checkInvariant("layout", () => layoutProblems(layout));
    const was = this.layout.focus;
    this.layout = layout;
    this.render();
    // Going to another window is a jump.
    if (layout.focus !== was) this.arrive(true);
    if (save) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = window.setTimeout(() => void this.saveLayout(), LAYOUT_SAVE_MS);
    }
  }

  /** Last write wins: the layout is where you left it, not something to merge. */
  private async saveLayout() {
    this.layoutTimer = 0;
    const text = `${JSON.stringify(this.layout, null, 2)}\n`;
    this.layoutSaving = true;
    try {
      let result = await this.net.write(this.layoutPath, text, this.layoutRevision);
      if (result.status === "conflict" && result.file) result = await this.net.write(this.layoutPath, text, result.file.revision);
      if (result.file) this.layoutRevision = result.file.revision;
    } catch {
      // Offline: the next change tries again.
    } finally {
      this.layoutSaving = false;
    }
  }

  /**
   * The device changed: show or put away tabs and windows side by side, as it now has room for. The
   * layout itself doesn't change, and isn't saved: what's put away comes back when there's room.
   */
  refreshParts(): void {
    const parts = this.parts();
    if (parts.tabs === this.shown.tabs && parts.splits === this.shown.splits) return;
    if (this.started) this.render();
  }

  /** What this device's layout keeps that doesn't show: windows, when they can't be side by side, and tabs, when there's no room for them. */
  kept(): { windows: number; tabs: number } {
    const groups = L.groups(this.layout);
    const windows = this.shown.splits ? 0 : groups.length - 1;
    const tabs = this.shown.tabs ? 0 : (this.shown.splits ? groups : [this.focusedGroup]).reduce((n, g) => n + Math.max(0, g.tabs.length - 1), 0);
    return { windows, tabs };
  }

  private render() {
    this.shown = this.parts();
    // What doesn't fit is hidden, not taken out (style.css): its editors and frames keep running.
    this.host.toggleAttribute("data-no-tabs", !this.shown.tabs);
    this.host.toggleAttribute("data-no-splits", !this.shown.splits);
    const wanted = new Set<string>();
    for (const g of L.groups(this.layout)) for (const t of g.tabs) wanted.add(key(g.id, t));
    for (const [k, view] of this.views) if (!wanted.has(k)) this.dropView(k, view);
    for (const k of this.viewBoxes.keys()) if (!wanted.has(k)) this.viewBoxes.delete(k);
    const shown = new Set(L.groups(this.layout).flatMap((g) => g.tabs.flatMap((t) => ("file" in t ? [t.file] : []))));
    for (const [path, file] of this.files) if (!file.views.size && !shown.has(path)) this.files.delete(path);
    for (const id of this.groupEls.keys()) if (!L.groups(this.layout).some((g) => g.id === id)) this.groupEls.delete(id);
    // Rebuild the windows only when their arrangement changes. Otherwise update them where they are:
    // moving a focused editor's node would blur it (and save) in the middle of a click.
    const shape = shapeOf(this.layout.root);
    if (shape !== this.shape || !this.host.firstElementChild) {
      this.shape = shape;
      this.host.replaceChildren(this.renderNode(this.layout.root));
    } else this.refreshNode(this.layout.root, this.host.firstElementChild as HTMLElement);
    // The root fills the area. A window that was in a split keeps its element, and with it the share
    // of the split it had: that only sizes a split's children (style.css), and it's cleared besides.
    (this.host.firstElementChild as HTMLElement).style.removeProperty("--share");
    this.renderTabs();
    this.afterFocus();
  }

  /** Bring the windows up to date in place: split sizes, and each window's contents. */
  private refreshNode(node: L.Node, el: HTMLElement) {
    if (node.kind === "group") return this.fillGroup(node);
    const children = [...el.children].filter((c) => !c.hasAttribute("data-divider")) as HTMLElement[];
    node.children.forEach((c, i) => {
      children[i].style.setProperty("--share", String(node.sizes[i]));
      this.refreshNode(c, children[i]);
    });
  }

  private renderNode(node: L.Node, path: number[] = []): HTMLElement {
    if (node.kind === "split") {
      const el = document.createElement("div");
      el.className = `split ${node.dir}`;
      node.children.forEach((c, i) => {
        const divider = i > 0 && this.chrome?.divider?.(el, path, i);
        if (divider) {
          divider.dataset.divider = "";
          el.append(divider);
        }
        const child = this.renderNode(c, [...path, i]);
        child.style.setProperty("--share", String(node.sizes[i]));
        el.append(child);
      });
      return el;
    }
    return this.fillGroup(node);
  }

  /** A window's tabs' contents, the one on show visible; nodes move only when the tabs change. */
  private fillGroup(node: L.Group): HTMLElement {
    const el = this.groupEls.get(node.id) ?? this.makeGroup(node.id);
    const editors = el.querySelector<HTMLElement>(".editors")!;
    const boxes = node.tabs.map((tab, i) => {
      const box = "file" in tab ? this.editorBox(node.id, tab.file) : this.viewBox(node.id, tab.view);
      const showing = i === node.active;
      if (showing && box.hidden && "view" in tab) this.drawView(tab.view, box);
      box.hidden = !showing;
      return box;
    });
    // The chrome's own parts (a drop overlay) stay, after the tabs' boxes.
    const chrome = [...editors.children].filter((c) => c.classList.contains("chrome")) as HTMLElement[];
    const empty = node.tabs.length ? [] : [editors.querySelector<HTMLElement>(":scope > .window-empty") ?? this.emptyState()];
    // Only what's new goes in, and only what's gone comes out: a box already there is never moved,
    // which would blur a focused editor and reload any frame in it. Order doesn't matter: one shows.
    const wanted = new Set<Node>([...empty, ...boxes]);
    for (const c of [...editors.children]) if (!wanted.has(c) && !chrome.includes(c as HTMLElement)) c.remove();
    for (const n of wanted) if (n.parentNode !== editors) editors.insertBefore(n, chrome[0] ?? null);
    return el;
  }

  private editorBox(group: L.GroupId, path: FilePath): HTMLElement {
    const file = this.files.get(path);
    if (!file) {
      // A change to the layout (a drop, say) brought in a file not loaded yet: draw it once it is.
      void this.load(path).then(() => this.render());
      const box = document.createElement("div");
      box.className = "tab-editor";
      return box;
    }
    const view = this.views.get(key(group, L.fileTab(path))) ?? this.makeEditor(group, file);
    return view.dom.parentElement!;
  }

  /** Draw a view somewhere outside the windows (the phone's sheet of views about the note). */
  drawInto(id: string, box: HTMLElement): void {
    this.drawView(id, box);
  }

  /** Draw a view in its box; one that throws says so there, and the windows carry on. */
  private drawView(id: string, box: HTMLElement) {
    const view = this.viewFor(id);
    if (view) drawSafely(box, view.title, () => view.render(box));
  }

  private viewBox(group: L.GroupId, id: string): HTMLElement {
    const k = key(group, { view: id });
    let box = this.viewBoxes.get(k);
    if (!box) {
      box = document.createElement("div");
      box.className = "tab-editor tab-view";
      // Hidden until shown, so the first showing draws it.
      box.hidden = true;
      box.tabIndex = -1;
      if (!this.viewFor(id)) box.textContent = `Nothing to show: no extension draws "${id}". Is it turned off? See the Extensions view.`;
      this.viewBoxes.set(k, box);
    }
    return box;
  }

  /** A window: its tabs' contents, and whatever the chrome adds (a tab bar, drop targets). */
  private makeGroup(id: L.GroupId): HTMLElement {
    const el = document.createElement("section");
    el.className = "group";
    const editors = document.createElement("div");
    editors.className = "editors";
    el.append(editors);
    el.addEventListener("focusin", () => {
      if (this.layout.focus !== id) this.setLayout(L.focusGroup(this.layout, id));
    });
    this.groupEls.set(id, el);
    this.chrome?.window?.(el, id);
    return el;
  }

  /** An empty window: the chrome's, or a line saying how to open something. */
  private emptyState(): HTMLElement {
    const made = this.chrome?.empty?.();
    if (made) {
      made.classList.add("window-empty");
      return made;
    }
    const hint = document.createElement("div");
    hint.className = "window-empty";
    const p = document.createElement("p");
    const bar = this.on.shortcut("quickOpen");
    p.textContent = bar ? `No note open. ${bar} opens one.` : "No note open.";
    hint.append(p);
    return hint;
  }

  /** Close the focused group's tabs that `which` picks, saving each file first; one that can't be saved stays open. */
  async closeTabs(which: (tab: L.Tab, index: number, saved: boolean) => boolean): Promise<void> {
    const group = this.focusedGroup;
    const closing: number[] = [];
    for (const [i, tab] of group.tabs.entries()) {
      const saved = !("file" in tab) || !this.files.get(tab.file)?.session.dirty;
      if (!which(tab, i, saved)) continue;
      if ("file" in tab && !(await this.saveToLeave(tab.file))) continue;
      closing.push(i);
    }
    this.setLayout(L.closeTabs(this.layout, group.id, (_, i) => closing.includes(i)));
  }

  /** Close every tab of these files, wherever they are, dropping anything unsaved: they're being deleted. */
  forget(paths: FilePath[]): void {
    for (const path of paths) clearTimeout(this.files.get(path)?.timer);
    let layout = this.layout;
    for (const g of L.groups(layout)) layout = L.closeTabs(layout, g.id, (t) => "file" in t && paths.includes(t.file));
    this.setLayout(layout);
    for (const path of paths) this.files.delete(path);
  }

  /** Whether a tab's file has nothing waiting to be saved (views always count as saved). */
  isSaved(tab: L.Tab): boolean {
    return !("file" in tab) || !this.files.get(tab.file)?.session.dirty;
  }

  /** What a tab shows as its title: a file's name, or a view's title. */
  title(tab: L.Openable): string {
    return "file" in tab ? label(tab.file) : (this.viewFor(tab.view)?.title ?? tab.view);
  }

  /** A window's tabs, as its chrome shows them. */
  tabs(group: L.GroupId): TabInfo[] {
    const g = L.groups(this.layout).find((x) => x.id === group);
    return (g?.tabs ?? []).map((item, i) => {
      const status = "file" in item ? this.files.get(item.file)?.session.status : undefined;
      return {
        key: L.openableKey(item),
        label: this.title(item),
        title: "file" in item ? item.file : this.title(item),
        selected: i === g!.active,
        preview: !!item.preview,
        status: status && status !== "saved" ? status : undefined,
      };
    });
  }

  private renderTabs() {
    for (const g of L.groups(this.layout)) {
      const el = this.groupEls.get(g.id);
      if (!el) continue;
      el.classList.toggle("focused", g.id === this.layout.focus);
      this.chrome?.tabs?.(el, g.id, this.tabs(g.id));
    }
  }

  /** After the layout changes: focus the right editor. */
  private afterFocus() {
    const view = this.focusedView;
    this.on.focus(this.focusedPath);
    const file = this.focusedPath ? this.files.get(this.focusedPath) : undefined;
    this.on.status(file?.session.status ?? null, file && this.saying(file));
    if (document.querySelector("#command-bar:not([hidden])")) return;
    // On a touch screen with no keyboard, a note opens to read: focus would bring the on-screen keyboard up. A tap edits.
    if (view && !this.focusOnOpen()) return;
    if (view && !view.hasFocus) view.focus();
    else if (!view) this.groupEls.get(this.layout.focus)?.querySelector<HTMLElement>(".tab-view:not([hidden])")?.focus();
  }
}

export interface Parts {
  tabs: boolean;
  splits: boolean;
}

/** The arrangement of splits and windows, without sizes or tabs. */
function shapeOf(node: L.Node): string {
  return node.kind === "group" ? node.id : `${node.dir}(${node.children.map(shapeOf).join(",")})`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
