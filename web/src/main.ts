// The app: a list of notes, the windows (workbench.ts) and the command bar. Everything it does is a
// command (commands.ts); keybindings, the command bar and Vim's ex commands run them.
import { getCM, Vim } from "@replit/codemirror-vim";
import { isNote, type FilePath, type FileSummary } from "../../worker/src/files.ts";
import { api } from "./api.ts";
import { CommandBar } from "./commandbar.ts";
import { combine, DEFAULT_SETTINGS, DEFAULTS, parseSettings, SETTINGS_TEMPLATE, userSettingsPath, WORKSPACE_SETTINGS, type Keybinding, type Settings } from "../../worker/src/settings.ts";
import { commandForKey, Commands, keyFor } from "./commands.ts";
import { docLabel } from "./describe.ts";
import { formatKeys, IS_MAC, learnLayout } from "./keys.ts";
import { endDrag, startDrag } from "./dnd.ts";
import { SEPARATOR, showMenu, type MenuItem } from "./menu.ts";
import * as L from "./layout.ts";
import { noteLinkAt, notePathFor } from "./links.ts";
import type { SaveStatus } from "./session.ts";
import { Panels } from "./panels.ts";
import { activate, type PluginContext } from "./plugins.ts";
import { commandsProviderPlugin, notesProviderPlugin } from "./plugins/command-bar.ts";
import { historyPlugin } from "./plugins/history.ts";
import { todosPlugin } from "./plugins/todos/index.ts";
import { Workbench } from "./workbench.ts";

/** The built-in plugins, in the order they start. */
const BUILT_IN = [notesProviderPlugin, commandsProviderPlugin, historyPlugin, todosPlugin];


const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const list = $<HTMLUListElement>("#notes ul");
const modeLine = $("#mode");
const saveLine = $("#save");
const problemsLine = $("#problems");

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
  conflict: "Not saved: this note changed in the same place elsewhere. :e! loads that version.",
  offline: "Not saved: can't reach the server. Trying again.",
};

let files: FileSummary[] = [];
let settings: Settings = DEFAULTS;
const pluginKeybindings: Keybinding[] = [];
let lastFile: FilePath | null = null;
const savedListeners: Array<(path: FilePath) => void> = [];
const focusListeners: Array<(path: FilePath | null) => void> = [];

const me = await fetch("/api/me")
  .then((r) => r.json())
  .then((who: { kind: string; email?: string }) => who.email)
  .catch(() => undefined);
const USER_SETTINGS = me ? userSettingsPath(me) : null;
const name = docLabel;

const workbench = new Workbench($("#workbench"), {
  status(status, message) {
    saveLine.textContent = message ?? (status ? SAVE_TEXT[status] : "");
    saveLine.dataset.status = status ?? "";
  },
  mode: (mode) => (modeLine.textContent = mode),
  focus(path) {
    if (path) window.history.replaceState(null, "", `?note=${encodeURIComponent(path)}`);
    if (path) lastFile = path;
    for (const fn of focusListeners) fn(path);
    document.title = path ? `${name(path)} · Common Ink` : "Common Ink";
    renderList();
  },
  created: () => void refreshList(),
  saved(path) {
    for (const fn of savedListeners) fn(path);
    if (path === WORKSPACE_SETTINGS || path === USER_SETTINGS) void loadSettings();
  },
  shortcut: (command) => {
    const key = keyFor(command, settings.keybindings);
    return key && formatKeys(key);
  },
  tabMenu: (x, y) => showMenu(x, y, tabMenuItems()),
});

/** The tab menu, for the focused window's tab on show: VSCode's items, each also a command. */
function tabMenuItems(): Array<MenuItem | null> {
  const g = L.focused(workbench.layout);
  const tab = g.tabs[g.active];
  const item = (command: string, label: string, disabled = false): MenuItem => {
    const key = keyFor(command, settings.keybindings);
    return { label, detail: key && formatKeys(key), disabled, run: () => commands.run(command) };
  };
  return [
    item("tab.close", "Close"),
    item("tab.closeOthers", "Close Others", g.tabs.length < 2),
    item("tab.closeRight", "Close to the Right", g.active >= g.tabs.length - 1),
    item("tab.closeLeft", "Close to the Left", g.active === 0),
    item("tab.closeSaved", "Close Saved", !g.tabs.some((t) => workbench.isSaved(t))),
    item("tab.closeAll", "Close All"),
    SEPARATOR,
    item("tab.keepOpen", "Keep Open", !tab?.preview),
    item("tab.copyPath", "Copy Path", !tab || !("file" in tab)),
    SEPARATOR,
    item("window.splitRight", "Split Right"),
    item("window.splitDown", "Split Down"),
  ];
}

/** Read user and workspace settings, apply them, and say what in them was ignored. */
async function loadSettings() {
  const [user, workspace] = await Promise.all([USER_SETTINGS ? api.read(USER_SETTINGS) : null, api.read(WORKSPACE_SETTINGS)]);
  const u = parseSettings(user?.text ?? "");
  const w = parseSettings(workspace.text);
  settings = combine(u.settings, w.settings, pluginKeybindings);
  workbench.applySettings(settings);
  const problems = [...u.problems.map((p) => `User settings: ${p}`), ...w.problems.map((p) => `Workspace settings: ${p}`)];
  problemsLine.textContent = problems.length ? `Settings: ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}` : "";
  problemsLine.title = problems.join("\n");
}

/** Open a settings file in a new tab, starting it from a template if there isn't one yet. */
async function openSettings(path: FilePath | null) {
  if (!path) return;
  if (path !== DEFAULT_SETTINGS && (await api.read(path)).revision === 0) await api.write(path, SETTINGS_TEMPLATE, 0);
  await workbench.open(path, { newTab: true });
}

async function refreshList() {
  files = await api.list();
  renderList();
}

function renderList() {
  const current = workbench.focusedPath;
  const notes = files.filter((d) => isNote(d.path));
  if (current && isNote(current) && !notes.some((n) => n.path === current)) notes.push({ path: current, revision: 0 });
  list.replaceChildren(
    ...notes.map((n) => {
      const a = document.createElement("a");
      a.href = `?note=${encodeURIComponent(n.path)}`;
      a.textContent = name(n.path);
      if (n.path === current) a.setAttribute("aria-current", "page");
      a.draggable = true;
      a.addEventListener("dragstart", (e) => startDrag(e, { item: L.fileTab(n.path) }, name(n.path)));
      a.addEventListener("dragend", endDrag);
      // Double-click opens it kept, not as the preview tab.
      a.addEventListener("dblclick", (e) => {
        e.preventDefault();
        void workbench.open(n.path, { newTab: true });
      });
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void workbench.open(n.path, { newTab: IS_MAC ? e.metaKey : e.ctrlKey });
      });
      const li = document.createElement("li");
      li.append(a);
      return li;
    }),
  );
}

/** Ctrl-O and Ctrl-I move through Vim's jumps in this note, then on to the previous or next note. */
function jumpOrStep(by: "back" | "forward") {
  const view = workbench.focusedView;
  const cm = view && getCM(view);
  const jumpList = Vim.getVimGlobalState_().jumpList;
  const offset = by === "back" ? -1 : 1;
  const cursor = cm?.getCursor();
  const pos = cm && jumpList.find(cm, offset);
  if (cm && pos && cursor && (pos.line !== cursor.line || pos.ch !== cursor.ch)) {
    jumpList.move(cm, offset);
    cm.setCursor(pos);
  } else void workbench.step(by);
}

function followLink() {
  const view = workbench.focusedView;
  const from = workbench.focusedPath;
  if (!view || !from) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const path = noteLinkAt(line.text, head - line.from, from);
  if (path) void workbench.open(path);
}

/** How the next pick in the command bar opens a note: in place of the tab on show, in a new tab, or in a new split. */
let openHow: "here" | "tab" | "right" | "down" = "here";

function openFromBar(path: FilePath) {
  const how = openHow;
  openHow = "here";
  if (how === "right" || how === "down") return void workbench.load(path).then(() => workbench.split(how, path));
  void workbench.open(path, { newTab: how === "tab" });
}

function pick(how: typeof openHow) {
  openHow = how;
  bar.open();
}

const commands = new Commands();
commands.register(
  { id: "quickOpen", title: "Open note…", run: () => pick("here") },
  {
    id: "commandBar",
    title: "Show all commands",
    run: () => {
      openHow = "here";
      bar.open(">");
    },
  },
  { id: "note.new", title: "New note…", run: () => pick("here") },
  { id: "note.save", title: "Save note", run: () => workbench.save(true) },
  { id: "note.reload", title: "Reload note from the server, discarding unsaved changes", run: () => workbench.reload() },
  { id: "note.followLink", title: "Follow link under cursor", run: followLink },
  { id: "go.back", title: "Go back", run: () => jumpOrStep("back") },
  { id: "go.forward", title: "Go forward", run: () => jumpOrStep("forward") },
  { id: "tab.open", title: "Open note in a new tab…", run: () => pick("tab") },
  { id: "tab.close", title: "Close tab", run: () => workbench.closeTab() },
  { id: "tab.closeOthers", title: "Close other tabs", run: () => workbench.closeTabs((_, i) => i !== L.focused(workbench.layout).active) },
  { id: "tab.closeRight", title: "Close tabs to the right", run: () => workbench.closeTabs((_, i) => i > L.focused(workbench.layout).active) },
  { id: "tab.closeLeft", title: "Close tabs to the left", run: () => workbench.closeTabs((_, i) => i < L.focused(workbench.layout).active) },
  { id: "tab.closeSaved", title: "Close saved tabs", run: () => workbench.closeTabs((_, __, saved) => saved) },
  { id: "tab.closeAll", title: "Close all tabs", run: () => workbench.closeTabs(() => true) },
  { id: "tab.keepOpen", title: "Keep tab open", run: () => workbench.change((l) => L.keepTab(l, l.focus, L.focused(l).active)) },
  {
    id: "tab.copyPath",
    title: "Copy path of tab",
    run: () => {
      const path = workbench.focusedPath;
      if (path) void navigator.clipboard.writeText(path);
    },
  },
  { id: "tab.next", title: "Next tab", run: () => workbench.change((l) => L.cycleTab(l, 1)) },
  { id: "tab.previous", title: "Previous tab", run: () => workbench.change((l) => L.cycleTab(l, -1)) },
  { id: "window.splitRight", title: "Split right", run: () => workbench.split("right") },
  { id: "window.splitDown", title: "Split down", run: () => workbench.split("down") },
  { id: "window.splitLeft", title: "Split left", run: () => workbench.split("left") },
  { id: "window.splitUp", title: "Split up", run: () => workbench.split("up") },
  { id: "window.openRight", title: "Open note in a split to the right…", run: () => pick("right") },
  { id: "window.openDown", title: "Open note in a split below…", run: () => pick("down") },
  { id: "window.close", title: "Close window", run: () => workbench.closeGroup() },
  { id: "window.only", title: "Close other windows", run: () => workbench.change(L.only) },
  { id: "window.next", title: "Focus next window", run: () => workbench.change((l) => L.cycleGroup(l, 1)) },
  { id: "window.left", title: "Focus window to the left", run: () => workbench.change((l) => L.focusDirection(l, "left")) },
  { id: "window.right", title: "Focus window to the right", run: () => workbench.change((l) => L.focusDirection(l, "right")) },
  { id: "window.up", title: "Focus window above", run: () => workbench.change((l) => L.focusDirection(l, "up")) },
  { id: "window.down", title: "Focus window below", run: () => workbench.change((l) => L.focusDirection(l, "down")) },
  { id: "settings.user", title: "Open user settings", run: () => openSettings(USER_SETTINGS) },
  { id: "settings.workspace", title: "Open workspace settings", run: () => openSettings(WORKSPACE_SETTINGS) },
  { id: "settings.defaults", title: "Open default settings (read-only)", run: () => openSettings(DEFAULT_SETTINGS) },
  { id: "tab.moveLeft", title: "Move tab to the window to the left", run: () => workbench.change((l) => L.moveTabDirection(l, "left")) },
  { id: "tab.moveRight", title: "Move tab to the window to the right", run: () => workbench.change((l) => L.moveTabDirection(l, "right")) },
  { id: "tab.moveUp", title: "Move tab to the window above", run: () => workbench.change((l) => L.moveTabDirection(l, "up")) },
  { id: "tab.moveDown", title: "Move tab to the window below", run: () => workbench.change((l) => L.moveTabDirection(l, "down")) },
  { id: "tab.moveEarlier", title: "Move tab earlier in its window", run: () => workbench.change((l) => L.shiftTab(l, -1)) },
  { id: "tab.moveLater", title: "Move tab later in its window", run: () => workbench.change((l) => L.shiftTab(l, 1)) },
  { id: "window.wider", title: "Make window wider", run: () => workbench.change((l) => L.resizeFocused(l, "row", 0.05)) },
  { id: "window.narrower", title: "Make window narrower", run: () => workbench.change((l) => L.resizeFocused(l, "row", -0.05)) },
  { id: "window.taller", title: "Make window taller", run: () => workbench.change((l) => L.resizeFocused(l, "column", 0.05)) },
  { id: "window.shorter", title: "Make window shorter", run: () => workbench.change((l) => L.resizeFocused(l, "column", -0.05)) },
  { id: "window.equalize", title: "Make windows the same size", run: () => workbench.change(L.equalize) },
);

const bar = new CommandBar();
const panels = new Panels($("#panel"));

const plugins: PluginContext = {
  me,
  settings: () => settings,
  commands: { register: (...c) => commands.register(...c), run: (id) => commands.run(id), all: () => commands.all() },
  keybindings: { add: (...b) => void pluginKeybindings.push(...b) },
  editor: { extend: (e) => void workbench.noteExtensions.push(e) },
  commandBar: { provide: (p) => bar.provide(p), open: (text) => bar.open(text) },
  panels: {
    // A panel is also a view that opens in a window: drag its title there, or use its command.
    register: (p) => {
      panels.register(p);
      workbench.registerView(p);
      commands.register({ id: `${p.id}.openInWindow`, title: `Open ${p.title} in a window`, run: () => workbench.openView(p.id, { newTab: true }) });
    },
    toggle: (id) => panels.toggle(id),
    show: (id) => panels.show(id),
    shown: () => panels.shown(),
    refresh: (id) => {
      panels.refresh(id);
      workbench.refreshView(id);
    },
  },
  files: { list: () => files, fetchList: api.list, read: api.read, write: (path, text, base) => api.write(path, text, base) },
  workbench: {
    open: (path, how) => workbench.open(path, how),
    openPicked: openFromBar,
    // With a view focused (History in a window, say), the file is the one focused last.
    focusedPath: () => workbench.focusedPath ?? lastFile,
    focusedView: () => workbench.focusedView,
    refreshFromServer: (paths) => workbench.refreshFromServer(paths),
    label: docLabel,
  },
  events: { onSaved: (fn) => void savedListeners.push(fn), onFocus: (fn) => void focusListeners.push(fn) },
};

window.addEventListener(
  "keydown",
  (e) => {
    const id = commandForKey(e, settings.keybindings);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    commands.run(id);
  },
  { capture: true },
);
window.addEventListener("focus", () => void learnLayout());
void learnLayout();

type ExParams = { argString?: string; input?: string };
const exArg = (params: ExParams) => (params.argString ?? "").trim();

/** An ex command that opens the note named in its argument, or does something else without one. */
function exOpen(name: string, prefix: string, withArg: (path: FilePath) => unknown, without: () => unknown) {
  Vim.defineEx(name, prefix, (_cm: unknown, params: ExParams) => {
    const arg = exArg(params).replace(/^!\s*/, "");
    const path = arg ? notePathFor(arg) : null;
    if (path) void withArg(path);
    else if (!arg) void without();
  });
}

Vim.defineEx("write", "w", () => commands.run("note.save"));
Vim.defineEx("edit", "e", (_cm: unknown, params: ExParams) => {
  const arg = exArg(params);
  const force = /^e(dit)?!/.test(params.input ?? "") || arg.startsWith("!");
  const path = notePathFor(arg.replace(/^!\s*/, ""));
  if (path) void workbench.open(path);
  else if (!arg.replace(/^!\s*/, "") && (force || !workbench.focusedSession?.dirty)) commands.run("note.reload");
});
Vim.defineEx("quit", "q", () => commands.run("tab.close"));
Vim.defineEx("close", "clo", () => commands.run("window.close"));
Vim.defineEx("only", "on", () => commands.run("window.only"));
exOpen("split", "sp", (p) => workbench.load(p).then(() => workbench.split("down", p)), () => commands.run("window.splitDown"));
exOpen("vsplit", "vs", (p) => workbench.load(p).then(() => workbench.split("right", p)), () => commands.run("window.splitRight"));
exOpen("tabedit", "tabe", (p) => workbench.open(p, { newTab: true }), () => commands.run("tab.open"));
exOpen("tabnew", "tabnew", (p) => workbench.open(p, { newTab: true }), () => commands.run("tab.open"));
Vim.defineEx("tabnext", "tabn", () => commands.run("tab.next"));
Vim.defineEx("tabprevious", "tabp", () => commands.run("tab.previous"));
Vim.defineEx("tabclose", "tabc", () => commands.run("tab.close"));
// :tabmove +1, :tabmove -1, or :tabmove N to put the tab at position N (0 is first).
Vim.defineEx("tabmove", "tabm", (_cm: unknown, params: ExParams) => {
  const arg = exArg(params);
  const g = L.focused(workbench.layout);
  const by = /^[+-]\d+$/.test(arg) ? Number(arg) : /^\d+$/.test(arg) ? Number(arg) - g.active : arg === "" ? g.tabs.length - 1 - g.active : 0;
  workbench.change((l) => L.shiftTab(l, by));
});

/** A Vim normal-mode key sequence that runs a command. */
function vimKey(keys: string, command: string) {
  const action = `run:${command}`;
  Vim.defineAction(action, () => commands.run(command));
  Vim.mapCommand(keys, "action", action, {}, { context: "normal" });
}
vimKey("gd", "note.followLink");
vimKey("<C-o>", "go.back");
vimKey("<C-i>", "go.forward");
vimKey("gt", "tab.next");
vimKey("gT", "tab.previous");
// Vim's own Ctrl-W in normal mode does nothing, and as a whole key it would swallow Ctrl-W h and the rest.
Vim.unmap("<C-w>", "normal");
for (const [keys, command] of [
  ["h", "window.left"],
  ["j", "window.down"],
  ["k", "window.up"],
  ["l", "window.right"],
  ["w", "window.next"],
  ["<C-w>", "window.next"],
  ["s", "window.splitDown"],
  ["v", "window.splitRight"],
  ["q", "tab.close"],
  ["c", "window.close"],
  ["o", "window.only"],
  ["H", "tab.moveLeft"],
  ["J", "tab.moveDown"],
  ["K", "tab.moveUp"],
  ["L", "tab.moveRight"],
  [">", "window.wider"],
  ["<", "window.narrower"],
  ["+", "window.taller"],
  ["-", "window.shorter"],
  ["=", "window.equalize"],
]) {
  vimKey(`<C-w>${keys}`, command);
}

// Leaving the page: send what's unsaved without waiting for an answer.
window.addEventListener("pagehide", () => {
  for (const u of workbench.unsaved()) void api.write(u.path, u.text, u.base, true).catch(() => {});
});

try {
  files = await api.list();
  const asked = notePathFor(new URLSearchParams(location.search).get("note") ?? "");
  const fallback = files.find((d) => d.path === "Try this PR.md")?.path ?? files.find((d) => isNote(d.path))?.path ?? notePathFor("Welcome")!;
  await loadSettings();
  activate(BUILT_IN, plugins, settings["plugins.disabled"]);
  // Plugins have added their keybindings; settings come after them.
  await loadSettings();
  await workbench.start(asked);
  if (!workbench.focusedPath) await workbench.open(fallback);
  renderList();
} catch (err) {
  saveLine.textContent = `Couldn't load notes: ${(err as Error).message}`;
}
