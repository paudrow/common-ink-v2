// The app: a list of notes, the windows (workbench.ts) and the command bar. Everything it does is a
// command (commands.ts); keybindings, the command bar and Vim's ex commands run them.
import { getCM, Vim } from "@replit/codemirror-vim";
import { isNote, type FilePath, type FileSummary } from "../../worker/src/files.ts";
import { api } from "./api.ts";
import { CommandBar } from "./commandbar.ts";
import { combine, DEFAULT_SETTINGS, DEFAULTS, isReadOnly, parseSettings, schema, SETTINGS_TEMPLATE, userSettingsPath, WORKSPACE_SETTINGS, type Settings } from "../../worker/src/settings.ts";
import { settingsEditor, SETTINGS_VIEW, writeSetting, type Level } from "./settings-ui.ts";
import { settingsJson } from "./settings-json.ts";
import { commandForKey, Commands, keyFor } from "./commands.ts";
import { describeAuthor, docLabel } from "./describe.ts";
import { connectLive } from "./live.ts";
import { formatKeys, IS_MAC, learnLayout } from "./keys.ts";
import { fileFromUrl, urlForFile } from "./address.ts";
import { endDrag, startDrag } from "./dnd.ts";
import { SEPARATOR, showMenu, type MenuItem } from "./menu.ts";
import * as L from "./layout.ts";
import { noteLinkAt, notePathFor } from "./links.ts";
import type { SaveStatus } from "./session.ts";
import { Panels } from "./panels.ts";
import type { PluginContext } from "./plugins.ts";
import { changedPlugins, manifestText, pluginPaths, pluginStates, startPlugins, type BuiltIn, type PluginEntry } from "./plugin-host.ts";
import { builtInSourceView, pluginsView } from "./plugins-view.ts";
import { BUILT_IN } from "./plugins/index.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { createState } from "./editor.ts";
import { EditorView } from "@codemirror/view";
import { Workbench } from "./workbench.ts";

/** Safe mode (?safe=1): only built-in plugins start, for when a workspace plugin breaks the app. */
const SAFE = new URLSearchParams(location.search).get("safe") === "1";
/** This page's address in or out of safe mode. */
const addressFor = (path: FilePath | null, safe = SAFE) => `${path ? urlForFile(path) : "?"}${safe ? `${path ? "&" : ""}safe=1` : ""}`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const list = $<HTMLUListElement>("#notes ul");
const modeLine = $("#mode");
const saveLine = $("#save");
const problemsLine = $("#problems");
const reloadLine = $("#reload");

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
  conflict: "Not saved: this note changed in the same place elsewhere. :e! loads that version.",
  offline: "Not saved: can't reach the server. Trying again.",
};

let files: FileSummary[] = [];
let settings: Settings = DEFAULTS;
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
    if (path) window.history.replaceState(null, "", addressFor(path));
    if (path) lastFile = path;
    for (const fn of focusListeners) fn(path);
    document.title = path ? `${name(path)} · Common Ink` : "Common Ink";
    renderList();
  },
  created: () => void refreshList(),
  saved(path) {
    for (const fn of savedListeners) fn(path);
    if (isSettingsFile(path)) void loadSettings();
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
    item("history.addLabel", "Add Label…", !tab || !("file" in tab)),
    SEPARATOR,
    item("window.splitRight", "Split Right"),
    item("window.splitDown", "Split Down"),
  ];
}

/** Each settings file's settings the last time it could be read. */
const lastGood: { user: Partial<Settings>; workspace: Partial<Settings> } = { user: {}, workspace: {} };

/** Read user and workspace settings, apply them, and say what in them was ignored. */
async function loadSettings() {
  const [user, workspace] = await Promise.all([USER_SETTINGS ? api.read(USER_SETTINGS) : null, api.read(WORKSPACE_SETTINGS)]);
  const u = parseSettings(user?.text ?? "");
  const w = parseSettings(workspace.text);
  // Half-typed JSON that saved keeps the settings the file had, rather than dropping them all.
  if (!u.broken) lastGood.user = u.settings;
  if (!w.broken) lastGood.workspace = w.settings;
  settings = combine(lastGood.user, lastGood.workspace);
  workbench.applySettings(settings);
  const problems = [...u.problems.map((p) => `User settings: ${p}`), ...w.problems.map((p) => `Workspace settings: ${p}`)];
  problemsLine.textContent = problems.length ? `Settings: ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}` : "";
  problemsLine.title = problems.join("\n");
  pluginsChanged();
  workbench.refreshView(SETTINGS_VIEW);
}

const settingsPath = (level: Level) => (level === "user" ? USER_SETTINGS : WORKSPACE_SETTINGS);
const isSettingsFile = (path: FilePath) => path === USER_SETTINGS || path === WORKSPACE_SETTINGS;

const settingsUi = settingsEditor({
  pathFor: settingsPath,
  read: (path) => api.read(path),
  write: (path, text, base) => api.write(path, text, base),
  effective: () => settings,
  openJson: (level) => void openSettings(settingsPath(level)),
  changed: () => void loadSettings(),
});
workbench.registerView(settingsUi);

/** Open the settings editor at user or workspace settings. */
function openSettingsUi(level: Level) {
  settingsUi.level = level;
  workbench.openView(SETTINGS_VIEW, { newTab: true });
  workbench.refreshView(SETTINGS_VIEW);
}

// A settings file's editor helps with its keys and values, and leads back to the settings editor.
workbench.extensionsFor = (path) =>
  isSettingsFile(path) || path === DEFAULT_SETTINGS ? [settingsJson({ readOnly: isReadOnly(path), openUi: () => openSettingsUi(path === WORKSPACE_SETTINGS ? "workspace" : "user") })] : [];

/** Open a settings file in a new tab, starting it from a template if there isn't one yet. */
async function openSettings(path: FilePath | null) {
  if (!path) return;
  if (path !== DEFAULT_SETTINGS && (await api.read(path)).revision === 0) await api.write(path, SETTINGS_TEMPLATE, 0);
  await workbench.open(path, { newTab: true });
}

async function refreshList() {
  files = await api.list();
  renderList();
  pluginsChanged();
}

function renderList() {
  const current = workbench.focusedPath;
  const notes = files.filter((d) => isNote(d.path));
  if (current && isNote(current) && !notes.some((n) => n.path === current)) notes.push({ path: current, revision: 0 });
  list.replaceChildren(
    ...notes.map((n) => {
      const a = document.createElement("a");
      a.href = urlForFile(n.path);
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
  { id: "settings.user", title: "Open user settings", run: () => openSettingsUi("user") },
  { id: "settings.userJson", title: "Open user settings (JSON)", run: () => openSettings(USER_SETTINGS) },
  { id: "settings.workspace", title: "Open workspace settings", run: () => openSettingsUi("workspace") },
  { id: "settings.workspaceJson", title: "Open workspace settings (JSON)", run: () => openSettings(WORKSPACE_SETTINGS) },
  { id: "settings.defaults", title: "Open default settings (JSON)", run: () => openSettings(DEFAULT_SETTINGS) },
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
  commands: {
    register: (...c) => commands.register(...c),
    run: (id) => commands.run(id),
    all: () => commands.all(),
    shortcut: (id) => {
      const key = keyFor(id, settings.keybindings);
      return key && formatKeys(key);
    },
  },
  util: { fuzzyFilter, notePathFor: (name) => notePathFor(name) },
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
  files: { list: () => files, read: api.read, write: (path, text, base) => api.write(path, text, base) },
  workbench: {
    open: (path, how) => workbench.open(path, how),
    openPicked: openFromBar,
    // With a view focused (History in a window, say), the file is the one focused last.
    focusedPath: () => workbench.focusedPath ?? lastFile,
    focusedView: () => workbench.focusedView,
    openView: (id, how) => workbench.openView(id, how),
    provideViews: (prefix, make) => workbench.provideViews(prefix, make),
    refreshFromServer: (paths) => workbench.refreshFromServer(paths),
    label: docLabel,
  },
  events: { onSaved: (fn) => void savedListeners.push(fn), onFocus: (fn) => void focusListeners.push(fn) },
};

// Plugins start once, as the app loads. Turning one on or off, or changing its files, applies after a
// reload (ADR 0005 says why), and until then the status bar and the Plugins view say so.
let pluginEntries: PluginEntry[] = [];
let statesAtStart = new Map<string, string>();
/** The settings that apply after a reload, as they were at start. */
let reloadSettingsAtStart: string | null = null;
const RELOAD_SETTINGS = Object.entries(schema.properties as Record<string, { appliesAfterReload?: boolean }>).filter(([, p]) => p.appliesAfterReload).map(([k]) => k);
const reloadSettingsNow = () => JSON.stringify(RELOAD_SETTINGS.map((k) => (settings as unknown as Record<string, unknown>)[k]));
const pluginsNeedReload = () => changedPlugins(statesAtStart, pluginStates(BUILT_IN, files, settings["plugins.disabled"], SAFE));

function updateReloadLine() {
  if (reloadSettingsAtStart === null) return;
  const plugins = pluginsNeedReload().size > 0;
  const settingsChanged = reloadSettingsNow() !== reloadSettingsAtStart;
  reloadLine.hidden = !plugins && !settingsChanged;
  const button = document.createElement("button");
  button.textContent = "Reload";
  button.addEventListener("click", () => reloadWindow());
  reloadLine.replaceChildren(`${plugins ? "Plugin" : "Settings"} changes apply after reload · `, button);
}

function pluginsChanged() {
  plugins.panels.refresh("plugins");
  updateReloadLine();
}

/** Load the page again, where it is, in or out of safe mode. */
function reloadWindow(safe = SAFE) {
  location.assign(addressFor(workbench.focusedPath ?? lastFile, safe));
}

function openPluginSource(e: PluginEntry) {
  if (e.workspace) void workbench.open(e.workspace.scriptPath, { newTab: true });
  else workbench.openView(`plugin-source:${e.manifest.id}`, { newTab: true });
}

/** Copy a built-in into the workspace, where it runs in its place after a reload, and open the copy. */
async function customize(b: BuiltIn) {
  const { manifestPath, scriptPath } = pluginPaths(b.id);
  await api.write(manifestPath, manifestText(b), 0);
  await api.write(scriptPath, b.source, 0);
  await refreshList();
  await workbench.open(scriptPath, { newTab: true });
}

/** Delete a workspace plugin's files, as changes that undo can take back. */
async function revertPlugin(e: PluginEntry) {
  if (!e.workspace) return;
  const paths = [e.workspace.scriptPath, e.workspace.manifestPath];
  workbench.forget(paths);
  for (const path of paths) {
    const file = await api.read(path);
    if (file.revision) await api.delete(path, file.revision);
  }
  await refreshList();
}

plugins.panels.register(
  pluginsView({
    entries: () => pluginEntries,
    needsReload: pluginsNeedReload,
    isOn: (id) => !settings["plugins.disabled"].includes(id),
    async setOn(id, on) {
      const others = settings["plugins.disabled"].filter((x) => x !== id);
      await writeSetting(api, WORKSPACE_SETTINGS, "plugins.disabled", on ? others : [...others, id]);
      await loadSettings();
    },
    safe: SAFE,
    openSource: openPluginSource,
    customize,
    revert: revertPlugin,
    reload: reloadWindow,
  }),
);
workbench.provideViews("plugin-source:", (id) => {
  const b = BUILT_IN.find((x) => `plugin-source:${x.id}` === id);
  if (!b) return null;
  const editor = (text: string) =>
    new EditorView({ state: createState(text, { json: false, code: true, readOnly: true, settings, extensions: [], onUpdate: () => {}, onBlur: () => {} }) });
  return builtInSourceView(b, { editor, customize: (x) => void customize(x) });
});
commands.register(
  { id: "plugins.show", title: "Show plugins", run: () => plugins.panels.toggle("plugins") },
  {
    id: "plugins.openSource",
    title: "Open plugin source…",
    run: () =>
      bar.pick(
        "Open a plugin's source",
        pluginEntries.map((e) => ({ label: e.manifest.name, detail: e.manifest.id, run: () => openPluginSource(e) })),
      ),
  },
  { id: "window.reload", title: "Reload window", run: () => reloadWindow() },
);

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

// Live: hear of every change as it's recorded, from agents, the CLI, other tabs and other devices.
let historyTimer2 = 0;
connectLive({
  async change(notice) {
    const open = await workbench.remoteChange(notice.path, notice.revision);
    const mine = notice.author.kind === "user" && notice.author.email === me;
    if (open && !mine && notice.path === workbench.focusedPath) {
      saveLine.textContent = `Edited by ${describeAuthor(notice.author, me)}`;
      saveLine.dataset.status = "remote";
    }
    // A new file, or a plugin's (which may have been deleted): list them again.
    if (!files.some((f) => f.path === notice.path) || notice.path.startsWith(".common-ink/plugins/")) void refreshList();
    if (isSettingsFile(notice.path)) void loadSettings();
    // Plugins hear of it as of any change to a file (the history panel redraws, say).
    clearTimeout(historyTimer2);
    historyTimer2 = window.setTimeout(() => savedListeners.forEach((fn) => fn(notice.path)), 400);
  },
  // Back after a gap: catch up on files that changed meanwhile.
  async open() {
    const latest = await api.list().catch(() => null);
    if (!latest) return;
    files = latest;
    renderList();
    for (const f of latest) await workbench.remoteChange(f.path, f.revision);
  },
});


try {
  files = await api.list();
  const asked = fileFromUrl(location.search);
  const fallback = files.find((d) => d.path === "Try this PR.md")?.path ?? files.find((d) => isNote(d.path))?.path ?? notePathFor("Welcome")!;
  await loadSettings();
  pluginEntries = await startPlugins({
    builtIns: BUILT_IN,
    files,
    read: api.read,
    // From the Worker, so `script-src 'self'` allows it; the version makes each change a new address.
    load: (w) => import(/* @vite-ignore */ `/plugins/${w.id}/index.js?v=${encodeURIComponent(w.version)}`),
    ctx: plugins,
    disabled: settings["plugins.disabled"],
    safe: SAFE,
    changed: pluginsChanged,
  });
  statesAtStart = pluginStates(BUILT_IN, files, settings["plugins.disabled"], SAFE);
  reloadSettingsAtStart = reloadSettingsNow();
  const { missing } = await workbench.start(asked);
  const failed = pluginEntries.find((e) => e.state === "failed");
  if (failed) {
    workbench.notice(`Plugin ${failed.manifest.name} didn't start: ${failed.error}`, [
      { label: "Show plugins", run: () => plugins.panels.show("plugins") },
      ...(failed.workspace ? [{ label: "Open in safe mode", run: () => reloadWindow(true) }] : []),
    ]);
  }
  if (missing) {
    // An old or edited address: say so, and only offer to make it if it's a note. JSON files are never made by accident.
    workbench.notice(`No file at ${missing}`, isNote(missing) ? [{ label: `Create ${missing.replace(/\.md$/, "")}`, run: () => workbench.open(missing, { newTab: true }) }] : []);
  } else if (!workbench.focusedPath) await workbench.open(fallback);
  renderList();
} catch (err) {
  saveLine.textContent = `Couldn't load notes: ${(err as Error).message}`;
}
