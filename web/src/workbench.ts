// The windows on screen: the layout (layout.ts) drawn as split groups of tabs. A file's tab holds an
// editor; a view's tab holds whatever its plugin draws. A file open in several tabs has one Session,
// and an edit in one tab is copied to the others. Tabs and notes drag into windows (dnd.ts), the
// borders between windows drag to resize them, and the layout is saved as a JSON file a moment after
// it changes.
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { isNote, type FilePath } from "../../worker/src/files.ts";
import { api } from "./api.ts";
import { createState, fromServer, replaceText, synced } from "./editor.ts";
import { Jumps, type Spot } from "./jumps.ts";
import { dragged, dropZone, endDrag, startDrag, tabIndexAt, type Dragged, type Zone } from "./dnd.ts";
import * as L from "./layout.ts";
import { Session, type SaveStatus } from "./session.ts";

const PAUSE_MS = 1000;
const RETRY_MS = 5000;
const LAYOUT_SAVE_MS = 1500;

interface OpenFile {
  path: FilePath;
  session: Session;
  views: Set<EditorView>;
  timer: number;
  /** Whether the server has it yet. A file opened by name starts out unsaved. */
  exists: boolean;
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
}

const key = (group: L.GroupId, item: L.Openable) => `${group}\n${L.openableKey(item)}`;
const label = (path: FilePath) => (isNote(path) ? path.replace(/\.md$/, "") : path);

export class Workbench {
  layout: L.Layout = L.emptyLayout();
  private files = new Map<FilePath, OpenFile>();
  /** Each tab's editor, by group and file. */
  private views = new Map<string, EditorView>();
  /** Each view tab's box, by group and view. */
  private viewBoxes = new Map<string, HTMLElement>();
  private registered = new Map<string, View>();
  private groupEls = new Map<L.GroupId, HTMLElement>();
  private jumps = new Map<L.GroupId, Jumps>();
  private layoutRevision = 0;
  private layoutTimer = 0;
  private shownView: EditorView | null = null;

  constructor(
    private host: HTMLElement,
    private on: WorkbenchEvents,
  ) {}

  /** Load the saved layout and its files, then show `first` if asked. */
  async start(first?: FilePath | null): Promise<void> {
    const saved = await api.read(L.LAYOUT_PATH);
    this.layoutRevision = saved.revision;
    let layout = (saved.text && L.parseLayout(safeJson(saved.text))) || L.emptyLayout();
    await Promise.all([...new Set(L.groups(layout).flatMap((g) => g.tabs.flatMap((t) => ("file" in t ? [t.file] : []))))].map((p) => this.load(p)));
    if (first) {
      await this.load(first);
      layout = L.showInTab(layout, first);
    }
    this.setLayout(layout, { save: false });
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
  async open(path: FilePath, how: { newTab?: boolean; pos?: number; jump?: boolean } = {}): Promise<void> {
    const from = this.here();
    const leaving = this.focusedPath;
    if (!how.newTab && leaving && leaving !== path && !(await this.saveToLeave(leaving))) return;
    await this.load(path);
    const layout = how.newTab ? L.openTab(this.layout, path) : L.showInTab(this.layout, path);
    if (from && from.path !== path && how.jump !== false) this.jumpsFor(this.layout.focus).visit(from, path);
    this.setLayout(layout);
    if (how.pos !== undefined) {
      const view = this.focusedView!;
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

  /** Draw a view again, wherever it's showing. */
  refreshView(id: string): void {
    for (const [k, box] of this.viewBoxes) if (k.endsWith(`\nview:${id}`) && !box.hidden) void this.registered.get(id)?.render(box);
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
    file.session.reload(await api.read(file.path));
  }

  save(explicit = false): Promise<void> | undefined {
    return this.focusedSession?.save(explicit);
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
    const fetched = await api.read(path);
    const again = this.files.get(path);
    if (again) return again;
    const file: OpenFile = {
      path,
      views: new Set(),
      timer: 0,
      exists: fetched.revision > 0,
      session: new Session(
        fetched,
        {
          text: () => this.primary(file)?.state.doc.toString() ?? fetched.text,
          replace: (text) => {
            const view = this.primary(file);
            if (view) replaceText(view, text);
          },
        },
        api.write,
        (status) => this.statusChanged(file, status),
      ),
    };
    this.files.set(path, file);
    return file;
  }

  private primary(file: OpenFile): EditorView | undefined {
    return file.views.values().next().value;
  }

  private statusChanged(file: OpenFile, status: SaveStatus) {
    if (status === "offline") {
      clearTimeout(file.timer);
      file.timer = window.setTimeout(() => void file.session.save(), RETRY_MS);
    }
    if (status === "saved" && !file.exists && file.session.revision > 0) {
      file.exists = true;
      this.on.created(file.path);
    }
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
    clearTimeout(file.timer);
    file.timer = window.setTimeout(() => void file.session.save(), PAUSE_MS);
  }

  private makeEditor(group: L.GroupId, file: OpenFile): EditorView {
    const text = this.primary(file)?.state.doc.toString() ?? file.session.savedText;
    const view: EditorView = new EditorView({
      state: createState(
        text,
        (u) => this.viewUpdate(file, view, u),
        () => void file.session.save(),
      ),
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
    try {
      let result = await api.write(L.LAYOUT_PATH, text, this.layoutRevision);
      if (result.status === "conflict" && result.file) result = await api.write(L.LAYOUT_PATH, text, result.file.revision);
      if (result.file) this.layoutRevision = result.file.revision;
    } catch {
      // Offline: the next change tries again.
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
    this.host.replaceChildren(this.renderNode(this.layout.root));
    this.renderTabs();
    this.afterFocus();
  }

  private renderNode(node: L.Node, path: number[] = []): HTMLElement {
    if (node.kind === "split") {
      const el = document.createElement("div");
      el.className = `split ${node.dir}`;
      node.children.forEach((c, i) => {
        if (i > 0) el.append(this.resizer(el, node, path, i));
        const child = this.renderNode(c, [...path, i]);
        child.style.flex = `${node.sizes[i]} 1 0`;
        el.append(child);
      });
      return el;
    }
    let el = this.groupEls.get(node.id);
    if (!el) el = this.makeGroup(node.id);
    const editors = el.querySelector<HTMLElement>(".editors")!;
    editors.replaceChildren(
      ...node.tabs.map((tab, i) => {
        const box = "file" in tab ? this.editorBox(node.id, tab.file) : this.viewBox(node.id, tab.view);
        box.hidden = i !== node.active;
        if (!box.hidden && "view" in tab) void this.registered.get(tab.view)?.render(box);
        return box;
      }),
      el.querySelector(".drop")!,
    );
    if (!node.tabs.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No note open. ⌘P opens one, or drag one here.";
      editors.prepend(empty);
    }
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
      box.tabIndex = -1;
      if (!this.registered.has(id)) box.textContent = `Nothing to show: no plugin draws "${id}". Is it turned off in settings?`;
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
  private resizer(container: HTMLElement, split: L.Split, path: number[], index: number): HTMLElement {
    const el = document.createElement("div");
    el.className = `resizer ${split.dir}`;
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", split.dir === "row" ? "vertical" : "horizontal");
    el.addEventListener("pointerdown", (down) => {
      down.preventDefault();
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

  private tabLabel(tab: L.Openable): string {
    return "file" in tab ? label(tab.file) : (this.registered.get(tab.view)?.title ?? tab.view);
  }

  private renderTabs() {
    for (const g of L.groups(this.layout)) {
      const el = this.groupEls.get(g.id);
      if (!el) continue;
      el.classList.toggle("focused", g.id === this.layout.focus);
      el.querySelector(".tabs")!.replaceChildren(
        ...g.tabs.map((item, i) => {
          const name = this.tabLabel(item);
          const tab = document.createElement("div");
          tab.className = "tab";
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(i === g.active));
          tab.title = "file" in item ? item.file : name;
          tab.draggable = true;
          tab.addEventListener("dragstart", (e) => startDrag(e, { item, from: { group: g.id, index: i } }, name));
          tab.addEventListener("dragend", endDrag);
          const button = document.createElement("button");
          button.className = "name";
          button.textContent = name;
          const status = "file" in item ? this.files.get(item.file)?.session.status : undefined;
          if (status && status !== "saved") button.dataset.status = status;
          button.addEventListener("click", () => this.setLayout(L.selectTab(this.layout, g.id, i)));
          button.addEventListener("auxclick", (e) => e.button === 1 && void this.closeTab(g.id, i));
          const close = document.createElement("button");
          close.className = "close";
          close.textContent = "×";
          close.setAttribute("aria-label", `Close ${name}`);
          close.addEventListener("click", () => void this.closeTab(g.id, i));
          tab.append(button, close);
          return tab;
        }),
      );
    }
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
