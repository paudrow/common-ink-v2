// The windows on screen: the layout (layout.ts) drawn as split groups of tabs. A file's tab holds an
// editor; a view's tab holds whatever its plugin draws. A file open in several tabs has one Session,
// and an edit in one tab is copied to the others. Tabs and notes drag into windows (dnd.ts), the
// borders between windows drag to resize them, and the layout is saved as a JSON file a moment after
// it changes.
import { EditorSelection, Transaction, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { isNote, type FilePath } from "../../worker/src/files.ts";
import type { Offline } from "./offline.ts";
import { docLabel } from "./describe.ts";
import { DEFAULTS, isReadOnly, type Settings } from "../../worker/src/settings.ts";
import { createState, fromServer, reconfigure, replaceText, synced } from "./editor.ts";
import { Jumps, type Spot } from "./jumps.ts";
import { dragged, dropZone, endDrag, startDrag, tabIndexAt, type Dragged, type Zone } from "./dnd.ts";
import * as L from "./layout.ts";
import { syncTabs } from "./tabbar.ts";
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
  /** What the editor starts with: the file, or this browser's unsent edit to it. */
  startText: string;
}

/** Something a plugin draws in a window's tab, such as History. */
export interface View {
  id: string;
  title: string;
  render(el: HTMLElement): void | Promise<void>;
}

export interface WorkbenchEvents {
  /** The focused tab's save status, or a message about it. */
  status(status: SaveStatus | null, message?: string): void;
  mode(mode: string): void;
  /** What the focused tab shows changed. */
  focus(path: FilePath | null): void;
  /** A file was saved for the first time, so lists of files are out of date. */
  created(path: FilePath): void;
  /** A file's text on the server changed. */
  saved(path: FilePath): void;
  /** How a command's shortcut is shown (⌘P, Ctrl+P), if it has one: from the keybindings in effect. */
  shortcut(command: string): string | undefined;
  /** A tab was right-clicked (or its menu key pressed): it's selected, and its menu goes at x, y. */
  tabMenu(x: number, y: number): void;
}

const key = (group: L.GroupId, item: L.Openable) => `${group}\n${L.openableKey(item)}`;
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
  private jumps = new Map<L.GroupId, Jumps>();
  private layoutRevision = 0;
  private layoutTimer = 0;
  /** A layout save is on its way, so news of it coming back isn't someone else's change. */
  private layoutSaving = false;
  private shownView: EditorView | null = null;
  private settings: Settings = DEFAULTS;
  /** Plugins' editor extensions, for every note's editor. */
  readonly noteExtensions: Extension[] = [];
  /** The arrangement of windows on screen, to tell when it has to be rebuilt. */
  private shape = "";

  constructor(
    private host: HTMLElement,
    private on: WorkbenchEvents,
    /** Files from the server, or as last seen while it can't be reached. */
    private net: Offline,
  ) {}

  /** Load the saved layout and its files, then show `first` if asked. */
  /**
   * Load the saved layout and its files, then show `first` (the file the address names): its tab if
   * the layout has one, or a preview tab if the file exists. A file that doesn't exist isn't opened;
   * it comes back as `missing`, for the app to say so.
   */
  async start(first?: FilePath | null): Promise<{ missing?: FilePath }> {
    const saved = await this.net.read(L.LAYOUT_PATH);
    this.layoutRevision = saved.revision;
    let layout = (saved.text && L.parseLayout(safeJson(saved.text))) || L.emptyLayout();
    await Promise.all([...new Set(L.groups(layout).flatMap((g) => g.tabs.flatMap((t) => ("file" in t ? [t.file] : []))))].map((p) => this.load(p)));
    let missing: FilePath | undefined;
    if (first) {
      const open = L.groups(layout).find((g) => g.tabs.some((t) => "file" in t && t.file === first));
      if (open) layout = L.selectTab(layout, open.id, open.tabs.findIndex((t) => "file" in t && t.file === first));
      else if ((await this.load(first)).exists) layout = L.showInTab(layout, first);
      else missing = first;
    }
    this.setLayout(layout, { save: false });
    return { missing };
  }

  /** A message in the focused window, with buttons, until its tabs change. */
  notice(message: string, actions: Array<{ label: string; run: () => unknown }> = []): void {
    const editors = this.groupEls.get(this.layout.focus)?.querySelector<HTMLElement>(".editors");
    if (!editors) return;
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

  /** Every file that isn't saved, for the page closing. */
  unsaved() {
    return [...this.files.values()].map((d) => d.session.unsaved).filter((u) => u !== null);
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
    if (from && from.path !== path && how.jump !== false) this.jumpsFor(this.layout.focus).visit(from, path);
    this.setLayout(layout);
    const view = this.focusedView;
    if (view && how.line !== undefined) how.pos = view.state.doc.line(Math.min(how.line + 1, view.state.doc.lines)).from;
    if (view && how.pos !== undefined) {
      view.dispatch({ selection: EditorSelection.cursor(Math.min(how.pos, view.state.doc.length)), scrollIntoView: true });
    }
  }

  /** Show a plugin's view in the focused group, in place of the tab on show or in a new tab. */
  openView(id: string, how: { newTab?: boolean } = {}): void {
    const item = { view: id };
    this.setLayout(how.newTab ? L.insertTab(this.layout, item) : L.showInTab(this.layout, item));
  }

  /** Views that can open in windows. Plugins register them. */
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
    for (const [k, box] of this.viewBoxes) if (k.endsWith(`\nview:${id}`) && !box.hidden) void this.viewFor(id)?.render(box);
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

  change(fn: (layout: L.Layout) => L.Layout): void {
    this.setLayout(fn(this.layout));
  }

  /** Back or forward through the files this group has shown (Ctrl-O and Ctrl-I past Vim's own jumps). */
  async step(by: "back" | "forward"): Promise<void> {
    const from = this.here();
    if (!from || !(await this.saveToLeave(from.path))) return;
    const to = this.jumpsFor(this.layout.focus)[by](from);
    if (to) await this.open(to.path, { pos: to.pos, jump: false });
  }

  async reload(): Promise<void> {
    const path = this.focusedPath;
    const file = path && this.files.get(path);
    if (!file) return;
    file.session.reload(await this.net.read(file.path));
    await this.net.release(file.path);
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
    if (path === L.LAYOUT_PATH) {
      if (revision <= this.layoutRevision || this.layoutSaving) return false;
      const saved = await this.net.read(L.LAYOUT_PATH);
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

  /** Use new settings in every editor, open now or later. */
  applySettings(settings: Settings): void {
    this.settings = settings;
    for (const view of this.views.values()) reconfigure(view, settings);
    // Empty windows list shortcuts, which settings may have rebound.
    for (const el of this.groupEls.values()) el.querySelector(".window-empty")?.replaceWith(this.emptyHint());
  }

  focus(): void {
    this.focusedView?.focus();
  }

  private here(): Spot | null {
    const path = this.focusedPath;
    const view = this.focusedView;
    return path && view ? { path, pos: view.state.selection.main.head } : null;
  }

  private jumpsFor(id: L.GroupId): Jumps {
    let jumps = this.jumps.get(id);
    if (!jumps) this.jumps.set(id, (jumps = new Jumps(this.here() ?? { path: L.LAYOUT_PATH, pos: 0 })));
    return jumps;
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
    // An edit this browser couldn't send before: it picks up where it left off, on its old base.
    const held = await this.net.unsentFor(path);
    const again = this.files.get(path);
    if (again) return again;
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
          text: () => this.primary(file)?.state.doc.toString() ?? startText,
          replace: (text, remote) => {
            const view = this.primary(file);
            if (view) replaceText(view, text, remote);
          },
        },
        (path, text, base) => this.net.write(path, text, base),
        (status) => this.statusChanged(file, status),
      ),
    };
    this.files.set(path, file);
    if (held && !held.conflict) file.timer = window.setTimeout(() => void file.session.save(), 0);
    if (held?.conflict) this.on.status("conflict", `${label(path)} has an unsent edit that clashes with the server's. :w tries again; :e! loads the server's version.`);
    return file;
  }

  private primary(file: OpenFile): EditorView | undefined {
    return file.views.values().next().value;
  }

  private statusChanged(file: OpenFile, status: SaveStatus) {
    if (status === "offline") {
      clearTimeout(file.timer);
      file.timer = window.setTimeout(() => void file.session.save(), RETRY_MS);
      // Held until it reaches the server, so closing the page doesn't lose it.
      const unsent = file.session.unsaved;
      if (unsent) void this.net.hold(unsent);
    }
    if (status === "saved" && !file.session.dirty) void this.net.release(file.path);
    if (status === "saved" && !file.exists && file.session.revision > 0) {
      file.exists = true;
      this.on.created(file.path);
    }
    if (status === "saved") this.on.saved(file.path);
    this.renderTabs();
    if (file.path === this.focusedPath) this.on.status(status);
  }

  private viewUpdate(file: OpenFile, view: EditorView, u: ViewUpdate) {
    if (!u.docChanged) return;
    const copied = u.transactions.some((tr) => tr.annotation(synced));
    if (copied) return;
    for (const other of file.views) {
      if (other !== view) other.dispatch({ changes: u.changes, annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
    }
    if (u.transactions.some((tr) => tr.annotation(fromServer))) return;
    file.session.edited();
    // Editing a file keeps its preview tabs open.
    if (L.groups(this.layout).some((g) => g.tabs.some((t) => t.preview && "file" in t && t.file === file.path))) this.setLayout(L.keepFile(this.layout, file.path));
    clearTimeout(file.timer);
    file.timer = window.setTimeout(() => void file.session.save(), this.settings["editor.saveDelay"]);
  }

  private makeEditor(group: L.GroupId, file: OpenFile): EditorView {
    const text = this.primary(file)?.state.doc.toString() ?? file.startText;
    const view: EditorView = new EditorView({
      state: createState(text, {
        json: !isNote(file.path),
        extensions: isNote(file.path) ? this.noteExtensions : [],
        readOnly: isReadOnly(file.path),
        settings: this.settings,
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
    getCM(view)?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
      if (view === this.focusedView) this.on.mode([e.mode, e.subMode].filter(Boolean).join(" ").toUpperCase());
    });
    return view;
  }

  private dropView(k: string, view: EditorView) {
    this.views.delete(k);
    for (const file of this.files.values()) file.views.delete(view);
    view.destroy();
  }

  private setLayout(layout: L.Layout, { save = true } = {}) {
    this.layout = layout;
    this.render();
    if (save) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = window.setTimeout(() => void this.saveLayout(), LAYOUT_SAVE_MS);
    }
  }

  /** Last write wins: the layout is where you left it, not something to merge. */
  private async saveLayout() {
    const text = `${JSON.stringify(this.layout, null, 2)}\n`;
    this.layoutSaving = true;
    try {
      let result = await this.net.write(L.LAYOUT_PATH, text, this.layoutRevision);
      if (result.status === "conflict" && result.file) result = await this.net.write(L.LAYOUT_PATH, text, result.file.revision);
      if (result.file) this.layoutRevision = result.file.revision;
    } catch {
      // Offline: the next change tries again.
    } finally {
      this.layoutSaving = false;
    }
  }

  private render() {
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
    this.renderTabs();
    this.afterFocus();
  }

  /** Bring the windows up to date in place: split sizes, and each window's contents. */
  private refreshNode(node: L.Node, el: HTMLElement) {
    if (node.kind === "group") return this.fillGroup(node);
    const children = [...el.children].filter((c) => !c.classList.contains("resizer")) as HTMLElement[];
    node.children.forEach((c, i) => {
      children[i].style.flex = `${node.sizes[i]} 1 0`;
      this.refreshNode(c, children[i]);
    });
  }

  private renderNode(node: L.Node, path: number[] = []): HTMLElement {
    if (node.kind === "split") {
      const el = document.createElement("div");
      el.className = `split ${node.dir}`;
      node.children.forEach((c, i) => {
        if (i > 0) el.append(this.resizer(el, path, i));
        const child = this.renderNode(c, [...path, i]);
        child.style.flex = `${node.sizes[i]} 1 0`;
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
      if (showing && box.hidden && "view" in tab) void this.viewFor(tab.view)?.render(box);
      box.hidden = !showing;
      return box;
    });
    const wanted = [...(node.tabs.length ? [] : [this.emptyHint()]), ...boxes, el.querySelector<HTMLElement>(".drop")!];
    const same = wanted.length === editors.children.length && wanted.every((n, i) => editors.children[i] === n);
    if (!same) editors.replaceChildren(...wanted);
    return el;
  }

  private editorBox(group: L.GroupId, path: FilePath): HTMLElement {
    const view = this.views.get(key(group, L.fileTab(path))) ?? this.makeEditor(group, this.files.get(path)!);
    return view.dom.parentElement!;
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
      if (!this.viewFor(id)) box.textContent = `Nothing to show: no plugin draws "${id}". Is it turned off in settings?`;
      this.viewBoxes.set(k, box);
    }
    return box;
  }

  /** A window: its tab bar, its tabs' contents, and the overlay that shows where a drop will land. */
  private makeGroup(id: L.GroupId): HTMLElement {
    const el = document.createElement("section");
    el.className = "group";
    const tabs = document.createElement("div");
    tabs.className = "tabs";
    tabs.setAttribute("role", "tablist");
    const marker = document.createElement("div");
    marker.className = "insert";
    marker.hidden = true;
    const editors = document.createElement("div");
    editors.className = "editors";
    const drop = document.createElement("div");
    drop.className = "drop";
    drop.hidden = true;
    editors.append(drop);
    el.append(tabs, marker, editors);
    el.addEventListener("focusin", () => {
      if (this.layout.focus !== id) this.setLayout(L.focusGroup(this.layout, id));
    });
    const hide = () => {
      drop.hidden = true;
      marker.hidden = true;
    };
    const target = (e: DragEvent): { zone: Zone | null; index: number } => {
      const tabEls = [...tabs.querySelectorAll<HTMLElement>(".tab")];
      if (tabs.contains(e.target as Node) || e.target === tabs) {
        return { zone: null, index: tabIndexAt(tabEls.map((t) => t.getBoundingClientRect()), e.clientX) };
      }
      return { zone: dropZone(editors.getBoundingClientRect(), e.clientX, e.clientY), index: -1 };
    };
    el.addEventListener("dragover", (e) => {
      const what = dragged(e);
      if (!what) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = what.from ? "move" : "copy";
      const { zone, index } = target(e);
      if (zone) {
        drop.hidden = false;
        drop.dataset.zone = zone;
        marker.hidden = true;
      } else {
        drop.hidden = true;
        const tabEls = [...tabs.querySelectorAll<HTMLElement>(".tab")];
        const bar = tabs.getBoundingClientRect();
        const at = tabEls[index]?.getBoundingClientRect().left ?? (tabEls.at(-1)?.getBoundingClientRect().right ?? bar.left);
        marker.hidden = false;
        marker.style.left = `${at - el.getBoundingClientRect().left - 1}px`;
      }
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node)) hide();
    });
    el.addEventListener("drop", (e) => {
      const what = dragged(e);
      hide();
      if (!what) return;
      e.preventDefault();
      const { zone, index } = target(e);
      void this.dropped(what, id, zone, index);
    });
    this.groupEls.set(id, el);
    return el;
  }

  /** Something dropped on a window: a tab moves; anything else opens there. */
  private async dropped(what: Dragged, group: L.GroupId, zone: Zone | null, index: number) {
    endDrag();
    if ("file" in what.item) await this.load(what.item.file);
    if (what.from) {
      const to = zone === null ? { group, index } : zone === "center" ? { group } : { group, side: zone };
      this.setLayout(L.moveTab(this.layout, what.from, to));
    } else if (zone === null) this.setLayout(L.insertTab(this.layout, what.item, group, index));
    else if (zone === "center") this.setLayout(L.insertTab(this.layout, what.item, group));
    else this.setLayout(L.splitAt(this.layout, group, zone, what.item));
  }

  /** The border between two windows: drag it to share their space differently. */
  private resizer(container: HTMLElement, path: number[], index: number): HTMLElement {
    const at = (): L.Split => path.reduce<L.Node>((n, i) => (n as L.Split).children[i], this.layout.root) as L.Split;
    const dir = at().dir;
    const el = document.createElement("div");
    el.className = `resizer ${dir}`;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", dir === "row" ? "vertical" : "horizontal");
    el.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      // The split as it is now: sizes may have changed since this border was drawn.
      const split = at();
      el.setPointerCapture(down.pointerId);
      const box = container.getBoundingClientRect();
      const total = split.dir === "row" ? box.width : box.height;
      const children = [...container.children].filter((c) => !c.classList.contains("resizer")) as HTMLElement[];
      const start = split.dir === "row" ? down.clientX : down.clientY;
      const pair = split.sizes[index - 1] + split.sizes[index];
      let sizes = split.sizes;
      const move = (e: PointerEvent) => {
        const moved = ((split.dir === "row" ? e.clientX : e.clientY) - start) / total;
        const before = Math.min(Math.max(0.1, split.sizes[index - 1] + moved), pair - 0.1);
        sizes = split.sizes.map((s, i) => (i === index - 1 ? before : i === index ? pair - before : s));
        sizes.forEach((s, i) => (children[i].style.flex = `${s} 1 0`));
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        this.setLayout(L.resizeSplit(this.layout, path, sizes));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    return el;
  }

  /** An empty window: what to do, centered, with the shortcuts as they're bound now. */
  private emptyHint(): HTMLElement {
    const hint = document.createElement("div");
    hint.className = "window-empty";
    const title = document.createElement("p");
    title.textContent = "No note open";
    const list = document.createElement("dl");
    for (const [label, command] of [
      ["Open note", "quickOpen"],
      ["All commands", "commandBar"],
      ["Split right", "window.splitRight"],
    ]) {
      const key = this.on.shortcut(command);
      if (!key) continue;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = key;
      list.append(dt, dd);
    }
    const drag = document.createElement("p");
    drag.className = "drag";
    drag.textContent = "or drag a note here";
    hint.append(title, list, drag);
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

  /** Whether a tab's file has nothing waiting to be saved (views always count as saved). */
  isSaved(tab: L.Tab): boolean {
    return !("file" in tab) || !this.files.get(tab.file)?.session.dirty;
  }

  private tabLabel(tab: L.Openable): string {
    return "file" in tab ? label(tab.file) : (this.viewFor(tab.view)?.title ?? tab.view);
  }

  private renderTabs() {
    for (const g of L.groups(this.layout)) {
      const el = this.groupEls.get(g.id);
      if (!el) continue;
      el.classList.toggle("focused", g.id === this.layout.focus);
      syncTabs(
        el.querySelector<HTMLElement>(".tabs")!,
        g.tabs.map((item, i) => {
          const status = "file" in item ? this.files.get(item.file)?.session.status : undefined;
          return {
            key: L.openableKey(item),
            label: this.tabLabel(item),
            title: "file" in item ? item.file : this.tabLabel(item),
            selected: i === g.active,
            preview: !!item.preview,
            status: status && status !== "saved" ? status : undefined,
          };
        }),
        this.tabActions(g.id),
      );
    }
  }

  /** What a tab's clicks, drags and menu do. Tabs are found by key when the event happens, so a tab that moved still acts on itself. */
  private tabActions(group: L.GroupId) {
    const index = (key: string) => L.groups(this.layout).find((g) => g.id === group)?.tabs.findIndex((t) => L.openableKey(t) === key) ?? -1;
    const withIndex = (fn: (i: number) => void) => (key: string) => {
      const i = index(key);
      if (i >= 0) fn(i);
    };
    return {
      select: withIndex((i) => {
        const g = L.groups(this.layout).find((x) => x.id === group);
        if (g && (g.active !== i || this.layout.focus !== group)) this.setLayout(L.selectTab(this.layout, group, i));
        else this.afterFocus();
      }),
      close: withIndex((i) => void this.closeTab(group, i)),
      keep: withIndex((i) => this.setLayout(L.keepTab(this.layout, group, i))),
      menu: (key: string, x: number, y: number) =>
        withIndex((i) => {
          this.setLayout(L.selectTab(this.layout, group, i));
          this.on.tabMenu(x, y);
        })(key),
      dragStart: (key: string, e: DragEvent) =>
        withIndex((i) => {
          const tab = L.groups(this.layout).find((g) => g.id === group)!.tabs[i];
          startDrag(e, { item: L.openableOf(tab), from: { group, index: i } }, this.tabLabel(tab));
        })(key),
      dragEnd: endDrag,
    };
  }

  /** After the layout changes: focus the right editor, and give it a fresh Vim jump list if it's a different one. */
  private afterFocus() {
    const view = this.focusedView;
    if (view !== this.shownView) {
      freshVimJumps();
      this.shownView = view;
      this.on.mode("NORMAL");
    }
    this.on.focus(this.focusedPath);
    this.on.status(this.focusedSession?.status ?? null);
    if (document.querySelector("#command-bar:not([hidden])")) return;
    if (view && !view.hasFocus) view.focus();
    else if (!view) this.groupEls.get(this.layout.focus)?.querySelector<HTMLElement>(".tab-view:not([hidden])")?.focus();
  }
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

/**
 * Vim's jump list is global and holds positions in the editor that had focus before; in a shorter file
 * the next G or gg throws on them. Each editor starts a fresh jump list, keeping registers and searches.
 */
function freshVimJumps() {
  const kept = { ...Vim.getVimGlobalState_() };
  Vim.resetVimGlobalState_();
  const fresh = Vim.getVimGlobalState_();
  Object.assign(fresh, kept, { jumpList: fresh.jumpList });
}
