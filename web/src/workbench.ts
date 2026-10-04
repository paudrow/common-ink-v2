// The windows on screen: the layout (layout.ts) drawn as split groups of tabs, with an editor per tab.
// A doc open in several tabs has one Session, and an edit in one tab is copied to the others. The
// layout is saved as workspace JSON a moment after it changes.
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { isNote, type DocPath } from "../../worker/src/docs.ts";
import { api } from "./api.ts";
import { createState, fromServer, replaceText, synced } from "./editor.ts";
import { Jumps, type Spot } from "./jumps.ts";
import * as L from "./layout.ts";
import { Session, type SaveStatus } from "./session.ts";

const PAUSE_MS = 1000;
const RETRY_MS = 5000;
const LAYOUT_SAVE_MS = 1500;

interface OpenDoc {
  path: DocPath;
  session: Session;
  views: Set<EditorView>;
  timer: number;
  /** Whether the server has it yet. A doc opened by name starts out unsaved. */
  exists: boolean;
}

export interface WorkbenchEvents {
  /** The focused tab's save status, or a message about it. */
  status(status: SaveStatus | null, message?: string): void;
  mode(mode: string): void;
  /** What the focused tab shows changed. */
  focus(path: DocPath | null): void;
  /** A doc was saved for the first time, so lists of docs are out of date. */
  created(path: DocPath): void;
}

const key = (group: L.GroupId, path: DocPath) => `${group}\n${path}`;
const label = (path: DocPath) => (isNote(path) ? path.replace(/\.md$/, "") : path);

export class Workbench {
  layout: L.Layout = L.emptyLayout();
  private docs = new Map<DocPath, OpenDoc>();
  private views = new Map<string, EditorView>();
  private groupEls = new Map<L.GroupId, HTMLElement>();
  private jumps = new Map<L.GroupId, Jumps>();
  private layoutRevision = 0;
  private layoutTimer = 0;
  private shownView: EditorView | null = null;

  constructor(
    private host: HTMLElement,
    private on: WorkbenchEvents,
  ) {}

  /** Load the saved layout and its docs, then show `first` if asked. */
  async start(first?: DocPath | null): Promise<void> {
    const saved = await api.read(L.LAYOUT_PATH);
    this.layoutRevision = saved.revision;
    let layout = (saved.text && L.parseLayout(safeJson(saved.text))) || L.emptyLayout();
    await Promise.all([...new Set(L.groups(layout).flatMap((g) => g.tabs))].map((p) => this.load(p)));
    if (first) {
      await this.load(first);
      layout = L.showInTab(layout, first);
    }
    this.setLayout(layout, { save: false });
  }

  get focusedGroup(): L.Group {
    return L.focused(this.layout);
  }

  get focusedPath(): DocPath | null {
    return L.activeDoc(this.focusedGroup);
  }

  get focusedView(): EditorView | null {
    const path = this.focusedPath;
    return path ? (this.views.get(key(this.layout.focus, path)) ?? null) : null;
  }

  get focusedSession(): Session | null {
    const path = this.focusedPath;
    return path ? (this.docs.get(path)?.session ?? null) : null;
  }

  isOpen(path: DocPath): boolean {
    return this.docs.has(path);
  }

  /** Every doc that isn't saved, for the page closing. */
  unsaved() {
    return [...this.docs.values()].map((d) => d.session.unsaved).filter((u) => u !== null);
  }

  /**
   * Show a doc in the focused group: in place of the tab on show, as Vim's `:e` does, or in a new tab.
   * The doc on show is saved first; if it can't be, it stays.
   */
  async open(path: DocPath, how: { newTab?: boolean; pos?: number; jump?: boolean } = {}): Promise<void> {
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

  /** Close the focused group's tab on show (`:q`). A doc that can't be saved stays open. */
  async closeTab(id = this.layout.focus, index?: number): Promise<void> {
    const group = L.groups(this.layout).find((g) => g.id === id);
    if (!group) return;
    const at = index ?? group.active;
    const path = group.tabs[at];
    if (path && !(await this.saveToLeave(path))) return;
    this.setLayout(L.closeTab(this.layout, id, at));
  }

  /** Close the focused group and its tabs (Vim's Ctrl-W c), saving each first. */
  async closeGroup(): Promise<void> {
    const group = this.focusedGroup;
    for (const path of group.tabs) if (!(await this.saveToLeave(path))) return;
    if (L.groups(this.layout).length === 1) this.setLayout({ ...this.layout, root: { ...group, tabs: [], active: 0 } });
    else this.setLayout(group.tabs.reduce((l) => L.closeTab(l, group.id, 0), this.layout));
  }

  split(where: "right" | "down", path?: DocPath): void {
    this.setLayout(L.split(this.layout, where, path));
  }

  change(fn: (layout: L.Layout) => L.Layout): void {
    this.setLayout(fn(this.layout));
  }

  /** Back or forward through the docs this group has shown (Ctrl-O and Ctrl-I past Vim's own jumps). */
  async step(by: "back" | "forward"): Promise<void> {
    const from = this.here();
    if (!from || !(await this.saveToLeave(from.path))) return;
    const to = this.jumpsFor(this.layout.focus)[by](from);
    if (to) await this.open(to.path, { pos: to.pos, jump: false });
  }

  async reload(): Promise<void> {
    const path = this.focusedPath;
    const doc = path && this.docs.get(path);
    if (!doc) return;
    doc.session.reload(await api.read(doc.path));
  }

  /** Take in what changed on the server for these docs, where nothing is waiting to be saved. */
  async refreshFromServer(paths: DocPath[]): Promise<void> {
    await Promise.all(
      paths.map(async (path) => {
        const doc = this.docs.get(path);
        if (doc && !doc.session.dirty) doc.session.reload(await api.read(path));
      }),
    );
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

  private async saveToLeave(path: DocPath): Promise<boolean> {
    const doc = this.docs.get(path);
    if (!doc) return true;
    clearTimeout(doc.timer);
    await doc.session.save();
    if (!doc.session.dirty) return true;
    this.on.status(doc.session.status, `${label(path)} isn't saved, so it's still open. :w tries again; :e! loads the saved version.`);
    return false;
  }

  /** Fetch a doc and start its session, unless it's open already. */
  async load(path: DocPath): Promise<OpenDoc> {
    const open = this.docs.get(path);
    if (open) return open;
    const fetched = await api.read(path);
    const again = this.docs.get(path);
    if (again) return again;
    const doc: OpenDoc = {
      path,
      views: new Set(),
      timer: 0,
      exists: fetched.revision > 0,
      session: new Session(
        fetched,
        {
          text: () => this.primary(doc)?.state.doc.toString() ?? fetched.text,
          replace: (text) => {
            const view = this.primary(doc);
            if (view) replaceText(view, text);
          },
        },
        api.write,
        (status) => this.statusChanged(doc, status),
      ),
    };
    this.docs.set(path, doc);
    return doc;
  }

  private primary(doc: OpenDoc): EditorView | undefined {
    return doc.views.values().next().value;
  }

  private statusChanged(doc: OpenDoc, status: SaveStatus) {
    if (status === "offline") {
      clearTimeout(doc.timer);
      doc.timer = window.setTimeout(() => void doc.session.save(), RETRY_MS);
    }
    if (status === "saved" && !doc.exists && doc.session.revision > 0) {
      doc.exists = true;
      this.on.created(doc.path);
    }
    this.renderTabs();
    if (doc.path === this.focusedPath) this.on.status(status);
  }

  private viewUpdate(doc: OpenDoc, view: EditorView, u: ViewUpdate) {
    if (!u.docChanged) return;
    const copied = u.transactions.some((tr) => tr.annotation(synced));
    if (copied) return;
    for (const other of doc.views) {
      if (other !== view) other.dispatch({ changes: u.changes, annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
    }
    if (u.transactions.some((tr) => tr.annotation(fromServer))) return;
    doc.session.edited();
    clearTimeout(doc.timer);
    doc.timer = window.setTimeout(() => void doc.session.save(), PAUSE_MS);
  }

  private makeView(group: L.GroupId, doc: OpenDoc): EditorView {
    const text = this.primary(doc)?.state.doc.toString() ?? doc.session.savedText;
    const view: EditorView = new EditorView({
      state: createState(
        text,
        (u) => this.viewUpdate(doc, view, u),
        () => void doc.session.save(),
      ),
    });
    // CodeMirror's own styles fix the editor's display and position, so each sits in a box of ours.
    const box = document.createElement("div");
    box.className = "tab-editor";
    box.dataset.group = group;
    box.append(view.dom);
    doc.views.add(view);
    this.views.set(key(group, doc.path), view);
    getCM(view)?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
      if (view === this.focusedView) this.on.mode([e.mode, e.subMode].filter(Boolean).join(" ").toUpperCase());
    });
    return view;
  }

  private dropView(k: string, view: EditorView) {
    this.views.delete(k);
    for (const doc of this.docs.values()) doc.views.delete(view);
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
      if (result.status === "conflict" && result.doc) result = await api.write(L.LAYOUT_PATH, text, result.doc.revision);
      if (result.doc) this.layoutRevision = result.doc.revision;
    } catch {
      // Offline: the next change tries again.
    }
  }

  private render() {
    const wanted = new Set<string>();
    for (const g of L.groups(this.layout)) for (const p of g.tabs) wanted.add(key(g.id, p));
    for (const [k, view] of this.views) if (!wanted.has(k)) this.dropView(k, view);
    for (const [path, doc] of this.docs) if (!doc.views.size && !L.groups(this.layout).some((g) => g.tabs.includes(path))) this.docs.delete(path);
    for (const id of this.groupEls.keys()) if (!L.groups(this.layout).some((g) => g.id === id)) this.groupEls.delete(id);
    this.host.replaceChildren(this.renderNode(this.layout.root));
    this.renderTabs();
    this.afterFocus();
  }

  private renderNode(node: L.Node): HTMLElement {
    if (node.kind === "split") {
      const el = document.createElement("div");
      el.className = `split ${node.dir}`;
      el.append(...node.children.map((c) => this.renderNode(c)));
      return el;
    }
    let el = this.groupEls.get(node.id);
    if (!el) {
      el = document.createElement("section");
      el.className = "group";
      const tabs = document.createElement("div");
      tabs.className = "tabs";
      tabs.setAttribute("role", "tablist");
      const editors = document.createElement("div");
      editors.className = "editors";
      el.append(tabs, editors);
      const id = node.id;
      el.addEventListener("focusin", () => {
        if (this.layout.focus !== id) this.setLayout(L.focusGroup(this.layout, id));
      });
      this.groupEls.set(id, el);
    }
    const editors = el.querySelector<HTMLElement>(".editors")!;
    editors.replaceChildren(
      ...node.tabs.map((path, i) => {
        const doc = this.docs.get(path)!;
        const view = this.views.get(key(node.id, path)) ?? this.makeView(node.id, doc);
        const box = view.dom.parentElement!;
        box.hidden = i !== node.active;
        return box;
      }),
    );
    if (!node.tabs.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No note open. ⌘P opens one.";
      editors.append(empty);
    }
    return el;
  }

  private renderTabs() {
    for (const g of L.groups(this.layout)) {
      const el = this.groupEls.get(g.id);
      if (!el) continue;
      el.classList.toggle("focused", g.id === this.layout.focus);
      el.querySelector(".tabs")!.replaceChildren(
        ...g.tabs.map((path, i) => {
          const tab = document.createElement("div");
          tab.className = "tab";
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-selected", String(i === g.active));
          tab.title = path;
          const name = document.createElement("button");
          name.className = "name";
          name.textContent = label(path);
          const status = this.docs.get(path)?.session.status;
          if (status && status !== "saved") name.dataset.status = status;
          name.addEventListener("click", () => this.setLayout(L.selectTab(this.layout, g.id, i)));
          name.addEventListener("auxclick", (e) => e.button === 1 && void this.closeTab(g.id, i));
          const close = document.createElement("button");
          close.className = "close";
          close.textContent = "×";
          close.setAttribute("aria-label", `Close ${label(path)}`);
          close.addEventListener("click", () => void this.closeTab(g.id, i));
          tab.append(name, close);
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
    if (view && !view.hasFocus && !document.querySelector("#command-bar:not([hidden])")) view.focus();
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
 * Vim's jump list is global and holds positions in the editor that had focus before; in a shorter doc
 * the next G or gg throws on them. Each editor starts a fresh jump list, keeping registers and searches.
 */
function freshVimJumps() {
  const kept = { ...Vim.getVimGlobalState_() };
  Vim.resetVimGlobalState_();
  const fresh = Vim.getVimGlobalState_();
  Object.assign(fresh, kept, { jumpList: fresh.jumpList });
}
