// The app: a list of notes, the windows (workbench.ts) and the command bar. Everything it does is a
// command (commands.ts); keybindings, the command bar and Vim's ex commands run them.
import { isRecordPath } from "../../worker/src/records.ts";
import { isNote, type FilePath, type FileSummary } from "../../worker/src/files.ts";
import { FIRST_PARTY_CATALOG, parseCatalog, type CatalogEntry } from "../../worker/src/catalog.ts";
import { extensionFilePath, parseManifest } from "../../worker/src/extensions.ts";
import { api } from "./api.ts";
import { CommandBar } from "./commandbar.ts";
import { combine, CORE_CATALOG, DEFAULT_SETTINGS, DEFAULTS, isReadOnly, parseSettings, SETTINGS_TEMPLATE, userSettingsPath, WORKSPACE_SETTINGS, type Settings, type SettingsCatalog } from "../../worker/src/settings.ts";
import { settingsEditor, SETTINGS_VIEW, writeSetting, type Level } from "./settings-ui.ts";
import { settingsJson } from "./settings-json.ts";
import { commandForKey, Commands, keyFor } from "./commands.ts";
import { describeAuthor, docLabel } from "./describe.ts";
import { connectLive } from "./live.ts";
import { formatKeys, IS_MAC, learnLayout } from "./keys.ts";
import { fileFromUrl, urlForFile } from "./address.ts";
import * as L from "./layout.ts";
import { linkAt, linkTarget, notePathFor, type LinkTarget } from "./links.ts";
import type { SaveStatus } from "./session.ts";
import { Panels } from "./panels.ts";
import { changedExtensions, extensionStates, type BuiltIn, type ExtensionRecord } from "./extension-host.ts";
import { ExtensionRuntime } from "./extension-runtime.ts";
import { builtInSourceView, extensionsView, originOf, type ExtensionsViewDeps } from "./extensions-view.ts";
import { modalOpen } from "./modal.ts";
import { changeIn, type Trigger } from "./permission-words.ts";
import { BUILT_IN } from "./extensions/index.ts";
import { createState } from "./editor.ts";
import { askPermission, confirmDialog, textDialog, type Asker } from "./dialog.ts";
import { activityView } from "./activity.ts";
import { parseGrants } from "../../worker/src/permissions.ts";
import { EditorView } from "@codemirror/view";
import { idbKV, Offline } from "./offline.ts";
import { Workbench } from "./workbench.ts";
import { Navigation, type Visit } from "./navigation.ts";
import { offerLibraries } from "./libraries.ts";
import { StatusItems } from "./status-items.ts";
import { embeds } from "./embeds.ts";
import { bootLevers } from "./dev-boot.ts";
import type { Prompt } from "./dev/index.ts";

// Test levers (docs/TESTING.md), where the Worker says there are any: before anything reads the clock or the network.
const dev = await bootLevers();

// Extensions in the workspace import CodeMirror and the app's helpers as libraries: the app's copies.
offerLibraries();

/** Safe mode (?safe=1): only built-in extensions start, for when a workspace extension breaks the app. */
const SAFE = new URLSearchParams(location.search).get("safe") === "1";
/** This page's address in or out of safe mode. */
const addressFor = (path: FilePath | null, safe = SAFE) => `${path ? urlForFile(path) : "?"}${safe ? `${path ? "&" : ""}safe=1` : ""}`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const list = $<HTMLUListElement>("#notes ul");
const saveLine = $("#save");
const problemsLine = $("#problems");
const unsentLine = $("#unsent");
const reloadLine = $("#reload");
const netLine = $("#net-activity");
netLine.addEventListener("click", () => panels.show("extension-activity"));

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
  conflict: "Not saved: this note changed in the same place elsewhere. :e! loads that version.",
  offline: "Not saved: can't reach the server. Trying again.",
};

let files: FileSummary[] = [];
let settings: Settings = DEFAULTS;
/** Every setting there is: the app's, and each installed extension's, once their manifests are read. */
let catalog: SettingsCatalog = CORE_CATALOG;
let lastFile: FilePath | null = null;
const savedListeners: Array<(path: FilePath) => void> = [];
const recordListeners: Array<() => void> = [];
const focusListeners: Array<(path: FilePath | null) => void> = [];

const offline = new Offline(idbKV(), api);

/** Who's signed in, remembered so the app knows offline too. */
const me = await fetch("/api/me")
  .then((r) => r.json())
  .then((who: { kind: string; email?: string }) => {
    try {
      if (who.email) localStorage.setItem("common-ink:me", who.email);
    } catch {}
    return who.email;
  })
  .catch(() => {
    try {
      return localStorage.getItem("common-ink:me") ?? undefined;
    } catch {
      return undefined;
    }
  });
const USER_SETTINGS = me ? userSettingsPath(me) : null;
const name = docLabel;

/** Where you've been, kept for this tab's session, so a reload keeps it (navigation.ts). */
const NAVIGATION_KEY = "common-ink.navigation";
function savedNavigation(): ConstructorParameters<typeof Navigation>[0] {
  try {
    return JSON.parse(sessionStorage.getItem(NAVIGATION_KEY) ?? "null");
  } catch {
    return null;
  }
}

/**
 * The browser's history follows the app's: a new entry for each jump, carrying its place's id, and the
 * entry you're on brought up to date as the cursor moves (a moment later, so typing doesn't flood it).
 */
const browserHistory = (() => {
  let pending: Visit | null = null;
  let timer = 0;
  let saveTimer = 0;
  const write = () => {
    if (pending) history.replaceState({ nav: pending.id }, "", addressFor(pending.file));
    pending = null;
  };
  const keep = () => {
    try {
      sessionStorage.setItem(NAVIGATION_KEY, JSON.stringify(workbench.navigation));
    } catch {
      // No session storage: it starts afresh after a reload.
    }
  };
  addEventListener("pagehide", () => (write(), keep()));
  return {
    follow(how: "push" | "replace", visit: Visit) {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(keep, 500);
      clearTimeout(timer);
      if (how === "replace") {
        pending = visit;
        timer = window.setTimeout(write, 400);
        return;
      }
      // The entry being left gets its last update first.
      write();
      history.pushState({ nav: visit.id }, "", addressFor(visit.file));
    },
    /** The browser moved to another entry: an update meant for the one it left is dropped. */
    moved() {
      clearTimeout(timer);
      pending = null;
    },
  };
})();

const workbench = new Workbench(
  $("#workbench"),
  {
    status(status, message) {
      saveLine.textContent = message ?? (status ? SAVE_TEXT[status] : "");
      saveLine.dataset.status = status ?? "";
    },
    navigated: (how, visit) => browserHistory.follow(how, visit),
    focus(path) {
      // Switching notes is something extensions act on; the first note showing, or focus coming back to the same one, isn't.
      if (path && lastFile && path !== lastFile) extensions.youDid({ kind: "opened", path });
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
  },
  offline,
  new Navigation(savedNavigation()),
);
// After a reload, the entry the browser is on is where you are.
if (typeof history.state?.nav === "number") workbench.navigation.goTo(history.state.nav);

/** Back (-1) or forward (1) a place: through the browser's history, so its Back and Forward agree. */
function navigate(by: -1 | 1) {
  if (!workbench.navigation.step(by)) return;
  history.go(by);
}

// The browser's Back and Forward (its buttons, the mouse's side buttons, a swipe): go to that place.
// An entry from before the app kept places, or one it no longer keeps, opens the file its address names.
addEventListener("popstate", (e) => {
  browserHistory.moved();
  const id = (e.state as { nav?: unknown } | null)?.nav;
  void (typeof id === "number" ? workbench.goTo(id) : Promise.resolve(false)).then((went) => {
    const file = went ? null : fileFromUrl(location.search);
    if (file) void workbench.open(file, { jump: false });
  });
});

/** Each settings file's settings the last time it could be read. */
const lastGood: { user: Partial<Settings>; workspace: Partial<Settings> } = { user: {}, workspace: {} };

/** Read user and workspace settings, apply them, and say what in them was ignored. */
async function loadSettings() {
  const [user, workspace] = await Promise.all([USER_SETTINGS ? offline.read(USER_SETTINGS) : null, offline.read(WORKSPACE_SETTINGS)]);
  const u = parseSettings(user?.text ?? "", catalog);
  const w = parseSettings(workspace.text, catalog);
  // Half-typed JSON that saved keeps the settings the file had, rather than dropping them all.
  if (!u.broken) lastGood.user = u.settings;
  if (!w.broken) lastGood.workspace = w.settings;
  settings = combine(lastGood.user, lastGood.workspace, extensions.keybindings(), catalog);
  workbench.applySettings(settings);
  const problems = [...u.problems.map((p) => `User settings: ${p}`), ...w.problems.map((p) => `Workspace settings: ${p}`)];
  problemsLine.textContent = problems.length ? `Settings: ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}` : "";
  problemsLine.title = problems.join("\n");
  extensionsChanged();
  extensions.settingsChanged();
  workbench.refreshView(SETTINGS_VIEW);
}

const settingsPath = (level: Level) => (level === "user" ? USER_SETTINGS : WORKSPACE_SETTINGS);
const isSettingsFile = (path: FilePath) => path === USER_SETTINGS || path === WORKSPACE_SETTINGS;

const settingsUi = settingsEditor({
  pathFor: settingsPath,
  read: (path) => offline.read(path),
  write: (path, text, base) => offline.write(path, text, base),
  catalog: () => catalog,
  openJson: (level) => void openSettings(settingsPath(level)),
  changed: () => void loadSettings(),
});
workbench.registerView(settingsUi);

/** Open the settings editor at user or workspace settings, searching for `query` if given. */
function openSettingsUi(level: Level, query = "") {
  settingsUi.level = level;
  settingsUi.query = query;
  workbench.openView(SETTINGS_VIEW, { newTab: true });
  workbench.refreshView(SETTINGS_VIEW);
}

// A settings file's editor helps with its keys and values, and leads back to the settings editor.
workbench.extensionsFor = (path) =>
  isSettingsFile(path) || path === DEFAULT_SETTINGS ? [settingsJson({ readOnly: isReadOnly(path), catalog: () => catalog, openUi: () => openSettingsUi(path === WORKSPACE_SETTINGS ? "workspace" : "user") })] : [];

/** Open a settings file in a new tab, starting it from a template if there isn't one yet. */
async function openSettings(path: FilePath | null) {
  if (!path) return;
  if (path !== DEFAULT_SETTINGS && (await offline.read(path)).revision === 0) await offline.write(path, SETTINGS_TEMPLATE, 0).catch(() => {});
  await workbench.open(path, { newTab: true });
}

async function refreshList() {
  files = await offline.list();
  renderList();
  if (offline.online) void offline.warm(files);
  extensionsChanged();
}

/** "Offline", and how many edits are waiting to be sent: shown whenever either is true. */
async function renderUnsent() {
  const unsent = await offline.unsent();
  const ops = await offline.ops();
  const waiting = unsent.length + ops.length;
  const clashing = unsent.filter((u) => u.conflict);
  const parts = [offline.online ? "" : "Offline", waiting ? `${waiting} unsent ${waiting === 1 ? "change" : "changes"}` : ""].filter(Boolean);
  unsentLine.textContent = parts.join(" · ") + (clashing.length ? ` (${clashing.length} can't be merged: open ${docLabel(clashing[0].path)})` : "");
  unsentLine.title = [...unsent.map((u) => `${u.path}${u.conflict ? " (can't be merged)" : ""}`), ...ops.map((o) => o.what)].join("\n");
  unsentLine.dataset.state = clashing.length ? "conflict" : waiting || !offline.online ? "waiting" : "";
}
offline.onChange(() => void renderUnsent());
unsentLine.addEventListener("click", async () => {
  const clashing = (await offline.unsent()).find((u) => u.conflict);
  if (clashing) await workbench.open(clashing.path, { newTab: true });
});

/** Send what's waiting. Open editors send their own; the rest go from here, and land in open tabs and the list. */
async function sendUnsent() {
  // Edits of records go first, in the order they were made; one the server refuses is said and dropped.
  const { refused } = await offline.flushOps((op) => api.editEvent(op.method, op.body, op.extension));
  for (const { op, error } of refused) workbench.notice(`${op.what} couldn't be made: ${error}`);
  const { sent } = await offline.flush((path) => workbench.isOpen(path));
  if (sent.length) {
    await refreshList();
    await workbench.refreshFromServer(sent);
  }
}
window.setInterval(() => void sendUnsent(), 5000);
window.addEventListener("online", () => void sendUnsent());

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
      // What it opens, for the Workbench extension's dragging into windows.
      a.dataset.open = JSON.stringify(L.fileTab(n.path));
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

function followLink() {
  const view = workbench.focusedView;
  const from = workbench.focusedPath;
  if (!view || !from) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  follow(linkAt(line.text, head - line.from, from));
}

/** Open what a link points to: a note here, or a page in a new browser tab. */
function follow(target: LinkTarget | null, newTab = false) {
  if (!target) return;
  if ("note" in target) void workbench.open(target.note, { newTab });
  else window.open(target.url, "_blank", "noopener");
}

// ⌘-click (Ctrl-click off a Mac) on a link the live preview draws follows it, from the note it's in.
document.addEventListener(
  "mousedown",
  (e) => {
    const link = (e.target as HTMLElement).closest?.<HTMLElement>(".cm-md-link");
    if (!link || e.button !== 0 || !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const group = link.closest<HTMLElement>(".tab-editor")?.dataset.group;
    const g = L.groups(workbench.layout).find((x) => x.id === group);
    const tab = g?.tabs[g.active];
    const from = tab && "file" in tab ? tab.file : workbench.focusedPath;
    follow(linkTarget(link.dataset.href ?? "", from), e.shiftKey);
  },
  { capture: true },
);

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
  { id: "go.back", title: "Go back", run: () => navigate(-1) },
  { id: "go.forward", title: "Go forward", run: () => navigate(1) },
  { id: "tab.open", title: "Open note in a new tab…", run: () => pick("tab") },
  { id: "tab.close", title: "Close tab", run: () => workbench.closeTab() },
  { id: "window.openRight", title: "Open note in a split to the right…", run: () => pick("right") },
  { id: "window.openDown", title: "Open note in a split below…", run: () => pick("down") },
  { id: "window.close", title: "Close window", run: () => workbench.closeGroup() },
  { id: "account.signOut", title: "Sign out", run: () => location.assign("/auth/sign-out") },
  { id: "settings.user", title: "Open user settings", run: () => openSettingsUi("user") },
  { id: "settings.userJson", title: "Open user settings (JSON)", run: () => openSettings(USER_SETTINGS) },
  { id: "settings.workspace", title: "Open workspace settings", run: () => openSettingsUi("workspace") },
  { id: "settings.workspaceJson", title: "Open workspace settings (JSON)", run: () => openSettings(WORKSPACE_SETTINGS) },
  { id: "settings.defaults", title: "Open default settings (JSON)", run: () => openSettings(DEFAULT_SETTINGS) },
);

const bar = new CommandBar();
const panels = new Panels($("#panel"));

const promptFor: Prompt<[Trigger | null]> = (m, asks, joined, trigger) => askPermission(askerOf(m.id), m, asks, joined, trigger);
const extensions = new ExtensionRuntime({
  me,
  commands,
  bar,
  statusItems: new StatusItems($("#status-left"), $("#status-right"), (command) => commands.run(command)),
  panels,
  workbench,
  offline,
  settings: () => settings,
  files: () => files,
  openFromBar,
  lastFile: () => lastFile,
  onSaved: savedListeners,
  onFocus: focusListeners,
  onRecords: recordListeners,
  saveGrant: async (id, key, answer) => {
    const grants = parseGrants(settings["extensions.permissions"]);
    await writeSetting(api, USER_SETTINGS ?? WORKSPACE_SETTINGS, "extensions.permissions", { ...grants, [id]: { ...grants[id], [key]: answer } });
    await loadSettings();
  },
  prompt: dev ? dev.prompt(promptFor) : promptFor,
  // It tried something it never asked for: say so once, with where to see what it does ask for.
  undeclared: (denied) => workbench.notice(denied.message, [{ label: changeIn(denied.extension.name), run: () => extensionsUi.showDetails(denied.extension.id) }]),
  changed: () => extensionsChanged(),
});
/** Who's asking, for a permission prompt: its name, where it's from and who made it, and its details. */
function askerOf(id: string): Asker {
  const r = extensions.host.records.find((x) => x.id === id);
  return { name: r?.manifest.name ?? id, origin: r ? originOf(r) : "Workspace", publisher: r?.manifest.publisher, showDetails: () => extensionsUi.showDetails(id) };
}

// Sandboxed extensions hear of saves and focus changes like trusted ones do.
savedListeners.push((path) => extensions.broadcast("saved", path));
focusListeners.push((path) => extensions.broadcast("focus", path));
recordListeners.push(() => extensions.broadcast("records", null));

// Extensions' manifests are read once, as the app loads. Turning one on or off, or changing its files,
// applies after a reload (ADR 0006 says why), and until then the status bar and the Extensions view say so.
let statesAtStart = new Map<string, string>();
/** The settings that apply after a reload, as they were at start. */
let reloadSettingsAtStart: string | null = null;
const reloadSettingsNow = () =>
  JSON.stringify(
    [...catalog.values()].filter((d) => d.reload).map((d) => settings[d.key]),
  );
const extensionsNeedReload = () => changedExtensions(statesAtStart, extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE));

function updateReloadLine() {
  if (reloadSettingsAtStart === null) return;
  const changed = extensionsNeedReload().size > 0;
  const settingsChanged = reloadSettingsNow() !== reloadSettingsAtStart;
  reloadLine.hidden = !changed && !settingsChanged;
  const button = document.createElement("button");
  button.textContent = "Reload";
  button.addEventListener("click", () => reloadWindow());
  reloadLine.replaceChildren(`${changed ? "Extension" : "Settings"} changes apply after reload · `, button);
}

function extensionsChanged() {
  panels.refresh("extensions");
  workbench.refreshView("extensions");
  panels.refresh("extension-activity");
  workbench.refreshView("extension-activity");
  // The dot shows while an extension has a network request in flight.
  const busy = extensions.broker.busy();
  netLine.hidden = !busy.length;
  netLine.title = busy.length ? `Reaching the network: ${busy.join(", ")}` : "";
  updateReloadLine();
}

/** Load the page again, where it is, in or out of safe mode. */
function reloadWindow(safe = SAFE) {
  location.assign(addressFor(workbench.focusedPath ?? lastFile, safe));
}

function openExtensionSource(r: ExtensionRecord) {
  if (r.workspace) void workbench.open(extensionFilePath(r.id, r.manifest.main), { newTab: true });
  else workbench.openView(`extension-source:${r.id}`, { newTab: true });
}

/**
 * Copy a built-in into the workspace, file for file, where it runs in its place after a reload, and open
 * its code. You chose to make it yours, so the copy is trusted to run in the page as the built-in did.
 */
async function customize(b: BuiltIn) {
  for (const [file, text] of Object.entries(await b.copy())) await api.write(extensionFilePath(b.manifest.id, file), text, 0);
  if (!settings["extensions.trusted"].includes(b.manifest.id)) await setTrust(b.manifest.id, true);
  await refreshList();
  await workbench.open(extensionFilePath(b.manifest.id, b.manifest.main.replace(/\.ts$/, ".js")), { newTab: true });
}

/** Delete a workspace extension's files, as changes that undo can take back. */
async function removeExtension(r: ExtensionRecord) {
  if (!r.workspace) return;
  const paths = [...r.workspace.files];
  workbench.forget(paths);
  for (const path of paths) {
    const file = await api.read(path);
    if (file.revision) await api.delete(path, file.revision);
  }
  await refreshList();
}

const extensionDeps: ExtensionsViewDeps = {
  records: () => extensions.host.records,
  needsReload: extensionsNeedReload,
  isOn: (id) => !settings["extensions.disabled"].includes(id),
  async setOn(id, on) {
    const others = settings["extensions.disabled"].filter((x) => x !== id);
    await writeSetting(api, WORKSPACE_SETTINGS, "extensions.disabled", on ? others : [...others, id]);
    await loadSettings();
    // Turning a sandboxed workspace extension on needs no reload; turning anything off does.
    if (on && extensions.host.records.find((r) => r.id === id && r.state === "off" && r.workspace && !r.builtIn)) await goLive(id, { kind: "turnedOn" });
    extensionsChanged();
  },
  safe: SAFE,
  openSource: openExtensionSource,
  openSettings: (r) => openSettingsUi("user", r.manifest.contributes.configuration?.title || r.manifest.name),
  customize,
  remove: removeExtension,
  reload: reloadWindow,
  answer: (r, key) => parseGrants(settings["extensions.permissions"])[r.id]?.[key],
  async setAnswer(r, key, answer) {
    const grants = parseGrants(settings["extensions.permissions"]);
    const mine = { ...grants[r.id] };
    if (answer) mine[key] = answer;
    else delete mine[key];
    await writeSetting(api, USER_SETTINGS ?? WORKSPACE_SETTINGS, "extensions.permissions", { ...grants, [r.id]: mine });
    await loadSettings();
  },
  async resetAnswers(r) {
    const { [r.id]: _forgotten, ...others } = parseGrants(settings["extensions.permissions"]);
    await writeSetting(api, USER_SETTINGS ?? WORKSPACE_SETTINGS, "extensions.permissions", others);
    await loadSettings();
  },
  isTrusted: (r) => settings["extensions.trusted"].includes(r.id),
  async setTrusted(r, trusted) {
    if (trusted) {
      const ok = await confirmDialog(
        `Trust ${r.manifest.name}?`,
        `A trusted extension runs in the app's own page instead of a sandbox. It can change note editors and draw straight into the page, and it can reach the server and everything you can, around the permissions it asks for. Trust only code you've read or wrote.`,
        "Trust it",
      );
      if (!ok) return;
    }
    await setTrust(r.id, trusted);
  },
  async install() {
    const url = await textDialog(
      "Install an extension from a URL",
      "The address of an extension's folder, or of its extension.json. Its files are copied into this workspace, and it runs sandboxed, asking before it reaches anything. Extensions from others are at your own risk.",
      "https://example.com/my-extension/",
      "Install",
    );
    if (!url) return;
    try {
      const { id, name } = await api.installExtension(url);
      await refreshList();
      if (await goLive(id, { kind: "installed" })) workbench.notice(`Installed ${name}. It runs sandboxed.`);
      else workbench.notice(`Installed ${name}. It starts after a reload.`, [{ label: "Reload", run: () => reloadWindow() }]);
    } catch (err) {
      workbench.notice(`Couldn't install it: ${(err as Error).message}`);
    }
  },
  showActivity: () => panels.show("extension-activity"),
  commandTitle: (command) => commands.all().find((c) => c.id === command)?.title,
  catalog: () => {
    if (!listed && !listing) listing = loadCatalog().finally(() => extensionsChanged());
    return listed;
  },
  installFromCatalog: (entry) => installAndAnnounce(entry),
};
const extensionsUi = extensionsView(extensionDeps);

/**
 * Put an extension that was just installed or turned on into the running app, if it can go in without
 * a reload (a sandboxed one can): its commands, views and embeds work at once, and embeds already on
 * screen draw. Returns whether it went in; if not, it starts after a reload.
 */
async function goLive(id: string, because: Trigger): Promise<boolean> {
  if (SAFE || !(await extensions.addLive(files, id, settings["extensions.trusted"], because))) return false;
  statesAtStart.set(id, extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE).get(id)!);
  catalog = extensions.catalog();
  // Its settings join the catalog, its keybindings the ones in effect, and editors draw its embeds.
  await loadSettings();
  return true;
}

/** Install a Catalog extension, put it in at once if it can be, and say so. */
async function installAndAnnounce(entry: CatalogEntry): Promise<void> {
  try {
    await installFromCatalog(entry);
    await refreshList();
    if (await goLive(entry.id, { kind: "installed" })) workbench.notice(`Installed ${entry.name}.`);
    else workbench.notice(`Installed ${entry.name}. It starts after a reload.`, [{ label: "Reload", run: () => reloadWindow() }]);
  } catch (err) {
    workbench.notice(`Couldn't install ${entry.name}: ${(err as Error).message}`);
    throw err;
  } finally {
    extensionsChanged();
  }
}

/** The Catalog extension that draws an embed language no installed extension does, for a note to offer it. */
function embedNeeds(language: string): { name: string; install(): Promise<void> } | null {
  const entry = listed?.entries.find((e) => e.embeds.includes(language) && !extensions.host.records.some((r) => r.id === e.id && r.state !== "off"));
  return entry ? { name: entry.name, install: () => installAndAnnounce(entry) } : null;
}

/** What the catalogs list, read the first time the Extensions view shows. */
let listed: { entries: CatalogEntry[]; problems: string[] } | null = null;
let listing: Promise<void> | null = null;

async function loadCatalog() {
  const entries: CatalogEntry[] = [];
  const problems: string[] = [];
  const index = new URL(FIRST_PARTY_CATALOG, location.href).toString();
  try {
    const res = await fetch(index);
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    entries.push(...parseCatalog(await res.json(), index, true));
  } catch (err) {
    problems.push(`The app's catalog couldn't be read: ${(err as Error).message}`);
  }
  for (const url of settings["extensions.catalogs"]) {
    try {
      entries.push(...(await api.catalog(url)));
    } catch (err) {
      problems.push(`The catalog at ${url} couldn't be read: ${(err as Error).message}`);
    }
  }
  listed = { entries, problems };
}

/**
 * Copy an extension's files in from a catalog. The app's own are read from the app; another catalog's
 * are fetched by the Worker, as Install from URL does. Either way it's a workspace extension, sandboxed.
 */
async function installFromCatalog(entry: CatalogEntry) {
  if (!entry.firstParty) return void (await api.installExtension(entry.folder, entry.catalog));
  const get = async (file: string) => {
    const res = await fetch(new URL(file, entry.folder));
    // A missing file is answered with the app's page, so a page isn't a file of the extension's.
    if (!res.ok || res.headers.get("Content-Type")?.startsWith("text/html")) throw new Error(`${file} isn't in the catalog`);
    return res.text();
  };
  const manifestText = await get("extension.json");
  const manifest = parseManifest(JSON.parse(manifestText), entry.id);
  if (typeof manifest === "string") throw new Error(manifest);
  const files: Array<[string, string]> = [
    ["extension.json", manifestText],
    ...(await Promise.all(manifest.files.map(async (f): Promise<[string, string]> => [f, await get(f)]))),
    // Where it came from, so its row and prompts say Catalog.
    ["installed.json", `${JSON.stringify({ from: new URL("extension.json", entry.folder).toString(), catalog: entry.catalog })}\n`],
  ];
  for (const [file, text] of files) {
    const path = extensionFilePath(entry.id, file);
    await api.write(path, text, (await api.read(path)).revision);
  }
}

/** Trust an extension to run in the page, or stop: kept in your settings, applied after a reload. */
async function setTrust(id: string, trusted: boolean) {
  const others = settings["extensions.trusted"].filter((x) => x !== id);
  await writeSetting(api, USER_SETTINGS ?? WORKSPACE_SETTINGS, "extensions.trusted", trusted ? [...others, id] : others);
  await loadSettings();
}

const activityUi = activityView(extensions.broker, { name: (id) => extensions.host.records.find((r) => r.id === id)?.manifest.name ?? id, showDetails: (id) => extensionsUi.showDetails(id) });
panels.register(activityUi);
workbench.registerView(activityUi);
// The Extensions view is the app's own, not an extension: turning extensions off can't lock you out of it.
panels.register(extensionsUi);
workbench.registerView(extensionsUi);
workbench.provideViews("extension-source:", (id) => {
  const b = BUILT_IN.find((x) => `extension-source:${x.manifest.id}` === id);
  if (!b) return null;
  const editor = (text: string) =>
    new EditorView({ state: createState(text, { json: false, code: true, readOnly: true, settings, extensions: [], onUpdate: () => {}, onBlur: () => {} }) });
  return builtInSourceView(b, { editor, customize: (x) => void customize(x) });
});
commands.register(
  { id: "extensions.show", title: "Show extensions", run: () => panels.toggle("extensions") },
  { id: "extensions.openInWindow", title: "Open Extensions in a window", run: () => workbench.openView("extensions", { newTab: true }) },
  {
    id: "extensions.openSource",
    title: "Open extension source…",
    run: () =>
      bar.pick(
        "Open an extension's source",
        extensions.host.records.map((r) => ({ label: r.manifest.name, detail: r.id, run: () => openExtensionSource(r) })),
      ),
  },
  { id: "window.reload", title: "Reload window", run: () => reloadWindow() },
  { id: "extensions.activity", title: "Show extension activity", run: () => panels.toggle("extension-activity") },
);

window.addEventListener(
  "keydown",
  (e) => {
    // A modal has the keys while it's up: its own, and Tab and Escape.
    if (modalOpen()) return;
    const id = commandForKey(e, settings.keybindings);
    // A command that declines the key (it doesn't apply here) leaves it to do what it would have.
    if (!id || !commands.runForKey(id)) return;
    e.preventDefault();
    e.stopPropagation();
  },
  { capture: true },
);
window.addEventListener("focus", () => void learnLayout());
void learnLayout();

// Leaving the page: send what's unsaved without waiting for an answer.
window.addEventListener("pagehide", () => {
  const unsaved = workbench.unsaved();
  // Kept first, where it's sure to be written: the request may never arrive.
  offline.keepDraftsNow(unsaved);
  for (const u of unsaved) void api.write(u.path, u.text, u.base, true).catch(() => {});
});

// The app's own files, kept by a service worker so it opens offline.
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});
// Live: hear of every change as it's recorded, from agents, the CLI, other tabs and other devices.
let historyTimer2 = 0;
let recordsTimer = 0;
connectLive({
  async change(notice) {
    const open = await workbench.remoteChange(notice.path, notice.revision);
    const mine = notice.author.kind === "user" && notice.author.email === me;
    if (open && !mine && notice.path === workbench.focusedPath) {
      saveLine.textContent = `Edited by ${describeAuthor(notice.author, me)}`;
      saveLine.dataset.status = "remote";
    }
    // A data source's records aren't listed: views of them hear of it, once a burst of changes ends.
    if (isRecordPath(notice.path)) {
      clearTimeout(recordsTimer);
      recordsTimer = window.setTimeout(() => recordListeners.forEach((fn) => fn()), 150);
      return;
    }
    // A new file, or an extension's (which may have been deleted): list them again.
    if (!files.some((f) => f.path === notice.path) || notice.path.startsWith(".common-ink/extensions/")) void refreshList();
    if (isSettingsFile(notice.path)) void loadSettings();
    // Extensions hear of it as of any change to a file (the history view redraws, say).
    clearTimeout(historyTimer2);
    historyTimer2 = window.setTimeout(() => savedListeners.forEach((fn) => fn(notice.path)), 400);
  },
  // Back after a gap: send what's waiting, then catch up on files that changed meanwhile. One path
  // for both, whether the gap was a dropped socket or a whole offline spell.
  async open() {
    await sendUnsent();
    const latest = await offline.list().catch(() => null);
    if (!latest) return;
    files = latest;
    renderList();
    for (const f of latest) await workbench.remoteChange(f.path, f.revision);
  },
});


try {
  files = await offline.list();
  void renderUnsent();
  if (offline.online) void offline.warm(files);
  const asked = fileFromUrl(location.search);
  const fallback = files.find((d) => d.path === "Try this PR.md")?.path ?? files.find((d) => isNote(d.path))?.path ?? notePathFor("Welcome")!;
  // The app's settings first, for which extensions are off; then every manifest, whose settings join
  // the catalog; then settings again, read against it.
  await loadSettings();
  await extensions.load(BUILT_IN, files, settings["extensions.disabled"], SAFE, settings["extensions.trusted"]);
  catalog = extensions.catalog();
  extensions.declare();
  // Embeds draw in notes for the languages extensions that are on declare.
  workbench.extend(embeds({ ...extensions.embedHost, needs: embedNeeds }));
  await loadSettings();
  statesAtStart = extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE);
  reloadSettingsAtStart = reloadSettingsNow();
  await extensions.start();
  // The Catalog, so a note can offer what its embeds need; editors redraw once it's read.
  listing ??= loadCatalog().then(() => {
    workbench.applySettings(settings);
    extensionsChanged();
  });
  const { missing } = await workbench.start(asked);
  const failed = extensions.host.records.find((r) => r.state === "failed");
  if (failed) {
    workbench.notice(`Extension ${failed.manifest.name} didn't start: ${failed.error}`, [
      { label: "Show extensions", run: () => panels.show("extensions") },
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
dev?.install({ workbench, extensions, commands, bar, offline, settings: () => settings });
