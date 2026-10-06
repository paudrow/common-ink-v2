// The app: a list of notes, the windows (workbench.ts) and the command bar. Everything it does is a
// command (commands.ts); keybindings, the command bar and Vim's ex commands run them.
import { mediaHooks, whenHiddenOf } from "./media.ts";
import { embedHooks, resetFloats } from "./lives.ts";
import { isRecordPath } from "../../worker/src/records.ts";
import { isNote, merge, type FilePath, type FileSummary } from "../../worker/src/files.ts";
import { FIRST_PARTY_CATALOG, parseCatalog, type CatalogEntry } from "../../worker/src/catalog.ts";
import { extensionFilePath, parseManifest } from "../../worker/src/extensions.ts";
import { api } from "./api.ts";
import { CommandBar } from "./commandbar.ts";
import { combine, CORE_CATALOG, DEFAULT_SETTINGS, DEFAULTS, isReadOnly, parseSettings, SETTINGS_TEMPLATE, userSettingsPath, WORKSPACE_SETTINGS, type Settings, type SettingsCatalog } from "../../worker/src/settings.ts";
import { settingsEditor, SETTINGS_VIEW, writeSetting, type Level, type Shown } from "./settings-ui.ts";
import { deviceSummary, renderDevice } from "./device-ui.ts";
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
import { createState, editText } from "./editor.ts";
import { keptWhen, showClash } from "./conflict.ts";
import { askPermission, confirmDialog, textDialog, type Asker } from "./dialog.ts";
import { activityView } from "./activity.ts";
import { parseGrants } from "../../worker/src/permissions.ts";
import { EditorView } from "@codemirror/view";
import { idbKV, Offline, unreachable } from "./offline.ts";
import { Workbench } from "./workbench.ts";
import { Navigation, type Visit } from "./navigation.ts";
import { offerLibraries } from "./libraries.ts";
import { StatusItems } from "./status-items.ts";
import { embeds } from "./embeds.ts";
import { bootLevers } from "./dev-boot.ts";
import type { Prompt } from "./dev/index.ts";
import { Device } from "./device.ts";
import { Shell, type Action, type Place, type ShellEntry } from "./shell.ts";
import { isIcon } from "./icons.ts";
import { barOf, PLACES_PATH } from "../../worker/src/places.ts";
import { setTopLevelKey } from "./json-edit.ts";
import { undo as undoTyping } from "@codemirror/commands";
import { atLeast, deviceOfLayout, here, hereText, parseDeviceFile, type Override, type Requires } from "../../worker/src/devices.ts";

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
const resolveButton = $<HTMLButtonElement>("#resolve");
const reloadLine = $("#reload");
const netLine = $("#net-activity");
netLine.addEventListener("click", () => panels.show("extension-activity"));

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
  conflict: "Not saved: this note changed in the same place elsewhere.",
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

/** Signing out, here or in another tab: this browser keeps no edits of the account's from now on. */
const accounts = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("common-ink.account");
accounts?.addEventListener("message", (e) => {
  if (e.data === "signed-out") void offline.forgetDrafts();
});
function signingOut() {
  void offline.forgetDrafts();
  accounts?.postMessage("signed-out");
}
// A link or a script here going to sign-out, as well as the command. (One typed in the address bar can't be seen.)
(window as { navigation?: EventTarget }).navigation?.addEventListener("navigate", (e) => {
  const to = (e as Event & { destination?: { url: string } }).destination?.url;
  if (to && new URL(to).pathname === "/auth/sign-out") signingOut();
});

// Who was signed in is remembered from the start, before anything's typed. Not remembered, this
// browser's storage was cleared (a sign-out does) since: a draft is there only because a page that was
// going wrote it after, and it's the session's that ended.
try {
  if (localStorage.getItem("common-ink:me") === null) void offline.forgetDrafts();
} catch {}

/** Who's signed in, remembered so the app knows offline too. */
const me = await fetch("/api/me")
  .then((r) => {
    // The session's over: nothing kept for whoever was signed in is used, or kept on.
    if (r.status === 401) signingOut();
    return r.json();
  })
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
// Drafts of unsaved edits are this account's: another one signing in here doesn't see them.
offline.account = me ?? null;
const USER_SETTINGS = me ? userSettingsPath(me) : null;
/** What this browser has, live, and its device file (device.ts). The `device` lever stands in for another. */
const device = new Device({ me, preset: dev?.levers.device ?? null });
/** Extensions you turned off on this device, which apply after a reload like turning one off. */
const offHere = () => Object.entries(device.file.extensions).flatMap(([id, o]) => (o === "off" ? [id] : []));
const name = docLabel;
/** The phone shell, made once the app's parts are (below). */
let shell: Shell | undefined;
/** What the window showed last, to tell when something new comes on show. */
let lastShowing: string | null | undefined;

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
    // What the phone shell keeps in the entry (its place) stays with it.
    if (pending) history.replaceState({ ...history.state, nav: pending.id }, "", addressFor(pending.file));
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
      this.pushVisit(visit);
    },
    /** A new entry for a place, with where it is to the phone shell; or, for the note a shell's place went to, the entry you're on. */
    pushVisit(visit: Visit) {
      clearTimeout(timer);
      write();
      const replace = shell?.replacing;
      const state = { nav: visit.id, ...shell?.entryFor() };
      if (replace) history.replaceState(state, "", addressFor(visit.file));
      else history.pushState(state, "", addressFor(visit.file));
    },
    /** An entry of a place the phone shell shows: a new one, or the one you're on in its place. */
    place(state: ShellEntry, replace: boolean) {
      clearTimeout(timer);
      write();
      if (replace) history.replaceState(state, "", location.href);
      else history.pushState(state, "", location.href);
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
      resolveButton.hidden = status !== "conflict";
      queueMicrotask(() => void renderUnsent());
    },
    navigated: (how, visit) => {
      browserHistory.follow(how, visit);
      // On a phone, a note opened shows over the place it was opened from.
      if (how === "push") shell?.showWindow();
    },
    focus(path) {
      // Switching notes is something extensions act on; the first note showing, or focus coming back to the same one, isn't.
      if (path && lastFile && path !== lastFile) extensions.youDid({ kind: "opened", path });
      if (path) lastFile = path;
      for (const fn of focusListeners) fn(path);
      document.title = path ? `${name(path)} · Common Ink` : "Common Ink";
      renderList();
      // Something new on show in the window (a view a command opened, say) shows over the place on a phone.
      const tab = L.activeTab(workbench.focusedGroup);
      const showing = tab && L.openableKey(tab);
      if (showing !== lastShowing && lastShowing !== undefined) shell?.showWindow();
      else shell?.update();
      lastShowing = showing;
    },
    created: () => void refreshList(),
    saved(path) {
      for (const fn of savedListeners) fn(path);
      if (isSettingsFile(path)) void loadSettings();
    },
    // Keys are hinted only where there's a keyboard to press them.
    shortcut: (command) => {
      const key = device.has("keyboard") ? keyFor(command, settings.keybindings) : undefined;
      return key && formatKeys(key);
    },
  },
  offline,
  new Navigation(savedNavigation()),
);
// A floating video's setting, and its Back to note (media.ts, lives.ts).
mediaHooks.whenHidden = () => whenHiddenOf(settings["media.whenHidden"]);
mediaHooks.reveal = (view, pos) => workbench.reveal(view, pos);
mediaHooks.open = (path) => workbench.open(path);
// Focus in an embed's box (in the layer, outside every window) focuses the window its note is in.
embedHooks.focused = (view) => workbench.focusView(view);
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
  // One of the places the phone shell showed: it shows it again.
  if (shell?.popped(e.state)) return;
  shell?.showWindow();
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
  device: (root) =>
    renderDevice(root, {
      device,
      extensions: () => extensions.host.records.filter((r) => !r.broken).map((r) => ({ manifest: r.manifest, here: extensions.here(r.manifest) })),
      setOverride: (id, value) => setOverride(id, value),
      openFile: () => device.path && void workbench.open(device.path, { newTab: true }),
    }),
});
workbench.registerView(settingsUi);

/** Open the settings editor at user or workspace settings, searching for `query` if given, or at This device. */
function openSettingsUi(level: Shown, query = "") {
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
  // Held edits the server refused, and open notes whose edit clashes with someone else's: said once, as clashes.
  const clashing = [...new Set([...unsent.filter((u) => u.conflict).map((u) => u.path), ...workbench.pending().flatMap((p) => (p.status === "conflict" ? [p.path] : []))])];
  const waiting = unsent.filter((u) => !clashing.includes(u.path)).length + ops.length;
  const parts = [offline.online ? "" : "Offline", waiting ? `${waiting} unsent ${waiting === 1 ? "change" : "changes"}` : "", clashing.length ? `${clashing.length} can't be merged: open ${docLabel(clashing[0])}` : ""];
  unsentLine.textContent = parts.filter(Boolean).join(" · ");
  unsentLine.title = [...unsent.map((u) => `${u.path}${clashing.includes(u.path) ? " (can't be merged)" : ""}`), ...ops.map((o) => o.what)].join("\n");
  unsentLine.dataset.state = clashing.length ? "conflict" : waiting || !offline.online ? "waiting" : "";
}
offline.onChange(() => void renderUnsent());
unsentLine.addEventListener("click", async () => {
  const clashing = (await offline.unsent()).find((u) => u.conflict)?.path ?? workbench.pending().find((p) => p.status === "conflict")?.path;
  if (!clashing) return;
  if (clashing !== workbench.focusedPath) await workbench.open(clashing, { newTab: true });
  await resolveConflict();
});
resolveButton.addEventListener("click", () => void resolveConflict());

/**
 * The note on show has an edit that clashes with someone else's: show the two, and keep yours (saved
 * over theirs, which stays in History) or use theirs (as an edit of yours, so u brings yours back).
 */
async function resolveConflict(): Promise<boolean> {
  const session = workbench.focusedSession;
  const view = workbench.focusedView;
  if (!session || !view || session.status !== "conflict") return false;
  const path = session.path;
  let theirs: Awaited<ReturnType<typeof api.read>>;
  try {
    theirs = await api.read(path);
  } catch {
    workbench.notice("Their version can't be read while offline: try again when you're back online.");
    return true;
  }
  const latest = await fetch(`/api/history?${new URLSearchParams({ path, limit: "1" })}`)
    .then((r) => (r.ok ? (r.json() as Promise<Array<{ author: Parameters<typeof describeAuthor>[0] }>>) : []))
    .catch(() => []);
  const who = latest[0] ? describeAuthor(latest[0].author, me) : "Someone";
  const mine = view.state.doc.toString();
  const base = session.revision;
  const show = (keptAt?: string) =>
    showClash({
      where: docLabel(path),
      who: who.charAt(0).toUpperCase() + who.slice(1),
      mine,
      theirs: theirs.text,
      keepMine: keptAt ? () => void restore() : () => void session.adopt(theirs).then(() => session.save(true)),
      useTheirs: () => void session.adopt(theirs).then(() => editText(view, theirs.text)),
      returnTo: () => view.contentDOM,
      keptAt,
    });
  // Restore: the kept edit, from the revision it was made on, onto the note as it is now. Where the
  // two changed the same lines, it's a clash like any other, to keep yours or use theirs.
  const restore = async () => {
    const before = base === 0 ? "" : await api.version(path, base).catch(() => null);
    const merged = before === null ? null : merge(mine, before, theirs.text);
    if (merged === null) return show();
    await session.adopt(theirs);
    editText(view, merged);
    await session.save(true);
  };
  const kept = workbench.keptAt(path);
  show(kept === undefined ? undefined : keptWhen(kept));
  return true;
}

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
        // On a phone, the note on show opened again from the list is a step of its own, for back to come back to the list.
        const here = shell?.active && n.path === workbench.focusedPath ? workbench.navigation.here : null;
        void workbench.open(n.path, { newTab: IS_MAC ? e.metaKey : e.ctrlKey });
        if (here) browserHistory.pushVisit(here);
        shell?.showWindow();
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

const commands = new Commands((title, why) => workbench.notice(`${title}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`));
/** Why a core command is off on this device, if it is: what it needs and the device hasn't. */
const needs = (requires: Requires) => () => hereText(here(requires, device.facts));
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
  { id: "note.resolveConflict", title: "Compare your edit with the one it clashes with, and keep yours or theirs", run: () => void resolveConflict() },
  { id: "note.followLink", title: "Follow link under cursor", run: followLink },
  { id: "go.back", title: "Go back", run: () => navigate(-1) },
  { id: "go.forward", title: "Go forward", run: () => navigate(1) },
  { id: "tab.open", title: "Open note in a new tab…", run: () => pick("tab"), off: needs({ width: "medium" }) },
  { id: "tab.close", title: "Close tab", run: () => workbench.closeTab() },
  { id: "media.resetFloat", title: "Reset floating video position", run: () => resetFloats() },
  { id: "window.openRight", title: "Open note in a split to the right…", run: () => pick("right"), off: needs({ width: "expanded" }) },
  { id: "window.openDown", title: "Open note in a split below…", run: () => pick("down"), off: needs({ width: "expanded" }) },
  { id: "window.close", title: "Close window", run: () => workbench.closeGroup(), off: needs({ width: "expanded" }) },
  {
    id: "account.signOut",
    title: "Sign out",
    run: () => {
      // Nothing of this account's is kept in this browser for whoever signs in next.
      signingOut();
      location.assign("/auth/sign-out");
    },
  },
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
  device,
  promoted: (id) => {
    statesAtStart.set(id, extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE, offHere()).get(id)!);
    // Its keybindings join the ones in effect.
    void loadSettings();
  },
});
/** Who's asking, for a permission prompt: its name, where it's from and who made it, and its details. */
function askerOf(id: string): Asker {
  const r = extensions.host.records.find((x) => x.id === id);
  return { name: r?.manifest.name ?? id, origin: r ? originOf(r) : "Workspace", publisher: r?.manifest.publisher, showDetails: () => extensionsUi.showDetails(id) };
}

// The device changed: extensions that now have what they need go in, and views that say what's on here draw again.
device.onChange((d, was) => {
  extensions.deviceChanged();
  workbench.refreshParts();
  void extensions.promote().then((went) => {
    if (d.facts.keyboard && !was.keyboard && d.file.keyboard === "auto") {
      const on = went.length ? `${went.join(", ")} ${went.length === 1 ? "is" : "are"} on` : "shortcuts are on";
      // On a touch screen it's a guess from the keys pressed: say how to take it back. What went in goes with a reload.
      if (d.facts.touch)
        workbench.notice(`Keyboard found: ${on}.`, [
          { label: "Not a keyboard?", run: () => void device.setKeyboard("no").then(() => went.length && reloadWindow()) },
          { label: "This device", run: () => openSettingsUi("device") },
        ]);
      else workbench.notice(`Keyboard found: ${on} here.`, [{ label: "This device", run: () => openSettingsUi("device") }]);
    }
    else if (went.length) workbench.notice(`${went.join(", ")} ${went.length === 1 ? "is" : "are"} on here now.`);
    extensionsChanged();
    workbench.refreshView(SETTINGS_VIEW);
    // Shortcuts are hinted now there's a keyboard (or not, now there isn't).
    if (d.facts.keyboard !== was.keyboard) workbench.applySettings(settings);
  });
});

// Tabs and windows side by side show where the Workbench says they fit; without it, windows need the width they'd need with it.
workbench.parts = () => {
  const tabs = extensions.layoutPart("tabs");
  const splits = extensions.layoutPart("splits");
  return { tabs: tabs !== undefined ? tabs === null : true, splits: splits !== undefined ? splits === null : device.atLeast("expanded") };
};
if (device.layoutPath) workbench.layoutPath = device.layoutPath;
workbench.firstLayout = firstLayout;

/**
 * Where a device that has no layout of its own starts: a wide one from the layout of the wide device you
 * used last (or the workspace's, from before layouts were per device); a narrow one with just what was
 * on show there, since a phone keeps only what it needs.
 */
async function firstLayout(): Promise<L.Layout | null> {
  const parse = (text: string) => {
    try {
      return L.parseLayout(JSON.parse(text));
    } catch {
      return null;
    }
  };
  let from: L.Layout | null = null;
  const layouts = me ? files.filter((f) => f.path !== device.layoutPath && deviceOfLayout(f.path, me)).sort((a, b) => b.revision - a.revision) : [];
  for (const f of layouts) {
    const seen = parseDeviceFile((await offline.read(f.path.replace(/layout\.json$/, "device.json") as FilePath)).text).seen;
    if (seen && atLeast(seen.width, "expanded")) {
      from = parse((await offline.read(f.path)).text);
      if (from) break;
    }
  }
  from ??= parse((await offline.read(L.LAYOUT_PATH)).text);
  return from && (device.atLeast("expanded") ? from : L.onShow(from));
}

// This device's file changed: in another tab on this device, or by you or an agent. Its changes come in here.
savedListeners.push((path) => path === device.path && void device.absorb());

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
const extensionsNeedReload = () => changedExtensions(statesAtStart, extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE, offHere()));

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
      const { id, name, untrusted } = await api.installExtension(url);
      if (untrusted) await loadSettings();
      await refreshList();
      // Trust given to an earlier extension by this id was taken back, for everyone who'd given it.
      const taken = untrusted ? `: trust given to an earlier ${name} was taken back, for everyone. Look it over, then Trust it again if you want` : "";
      if (await goLive(id, { kind: "installed" })) workbench.notice(`Installed ${name}. It runs sandboxed${taken}.`);
      else workbench.notice(`Installed ${name}. It starts after a reload${taken}.`, [{ label: "Reload", run: () => reloadWindow() }]);
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
  device: {
    summary: () => deviceSummary(device),
    open: () => openSettingsUi("device"),
    here: (r) => extensions.here(r.manifest),
    override: (id) => device.override(id),
    setOverride,
  },
};
const extensionsUi = extensionsView(extensionDeps);

/**
 * Put an extension that was just installed or turned on into the running app, if it can go in without
 * a reload (a sandboxed one can): its commands, views and embeds work at once, and embeds already on
 * screen draw. Returns whether it went in; if not, it starts after a reload.
 */
async function goLive(id: string, because: Trigger): Promise<boolean> {
  if (SAFE || !(await extensions.addLive(files, id, settings["extensions.trusted"], because))) return false;
  statesAtStart.set(id, extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE, offHere()).get(id)!);
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

/** Turn an extension on or off on this device, or back to Auto: kept in the device file. Turning one on here puts it in at once. */
async function setOverride(id: string, value: Override | undefined) {
  await device.setOverride(id, value);
  extensionsChanged();
}

/** The extensions a settings file trusts, or null if it can't be read as JSON. */
async function trustedIn(path: FilePath): Promise<string[] | null> {
  try {
    const value = JSON.parse((await api.read(path)).text || "{}")["extensions.trusted"];
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return null;
  }
}

/**
 * Trust an extension to run in the page, kept in your settings; or stop, wherever it was trusted (yours
 * or the workspace's). Applied after a reload.
 */
async function setTrust(id: string, trusted: boolean) {
  for (const path of trusted ? [USER_SETTINGS ?? WORKSPACE_SETTINGS] : [USER_SETTINGS, WORKSPACE_SETTINGS]) {
    if (!path) continue;
    const list = (await trustedIn(path)) ?? [];
    if (trusted !== list.includes(id)) await writeSetting(api, path, "extensions.trusted", trusted ? [...list, id] : list.filter((x) => x !== id));
  }
  await loadSettings();
  if (!trusted && settings["extensions.trusted"].includes(id)) workbench.notice(`${id} is still trusted: fix the settings file that lists it under extensions.trusted (it isn't valid JSON), then try again.`);
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

// The phone shell (shell.ts): places, the bottom bar, sheets and the keyboard toolbar, under 840px.
/** The bottom bar's places, from places.json, kept up to date as it changes. */
let barIds = barOf("");
async function loadPlaces() {
  barIds = barOf((await offline.read(PLACES_PATH).catch(() => ({ text: "" }))).text);
  shell?.update();
}
/**
 * Write places.json's bar: just that key, the rest of the file as it was (saved searches, order). The
 * bar changes at once; offline, the write is held like any edit and sent once the server's back.
 */
async function setBar(ids: string[]) {
  barIds = ids;
  for (let tries = 0; tries < 3; tries++) {
    const now = await offline.read(PLACES_PATH);
    const text = setTopLevelKey(now.text.trim() ? now.text : "{}\n", "bar", ids);
    if (text === null) return workbench.notice("places.json isn't a JSON object: fix it to change the bottom bar.");
    try {
      if ((await offline.write(PLACES_PATH, text, now.revision)).status !== "conflict") return;
    } catch (err) {
      if (!unreachable(err)) return workbench.notice(`The bottom bar couldn't be saved: ${(err as Error).message}`);
      await offline.hold({ path: PLACES_PATH, text, base: now.revision });
      return workbench.notice("You're offline: the bottom bar is changed here, and saved once you're back.");
    }
  }
}
/** Every place, in order: the Feed (the notes list, until the Feed exists), extensions' places, views that aren't places yet, Extensions and Settings. */
function places(): Place[] {
  const on = extensions.host.on();
  const placed = new Set(on.flatMap((m) => m.contributes.places.flatMap((p) => ("view" in p ? [p.view] : []))));
  return [
    { id: "feed", title: "Feed", icon: "inbox", open: { list: true } },
    // An extension's places are named for it, so none can be the core's (feed, extensions, settings) or another's.
    ...on.flatMap((m) => m.contributes.places.map((p): Place => ({ id: `${m.id}.${p.id}`, title: p.title, icon: isIcon(p.icon) ? p.icon : "file-text", open: "view" in p ? { view: p.view } : { command: p.command } }))),
    ...on.flatMap((m) => (m.contributes.views.sidebar ?? []).filter((v) => !placed.has(v.id)).map((v): Place => ({ id: `view:${v.id}`, title: v.name, icon: "file-text", open: { view: v.id } }))),
    { id: "extensions", title: "Extensions", icon: "puzzle", open: { view: "extensions" }, end: true },
    { id: "settings", title: "Settings", icon: "settings", open: { view: SETTINGS_VIEW }, end: true },
  ];
}
/** A command as the shell shows it, with why it's off here. */
const action = (command: string, more: Partial<Action> = {}): Action => {
  const c = commands.get(command);
  return { command, title: c?.title ?? command, off: c?.off?.() ?? null, ...more };
};
shell = new Shell({
  device,
  places,
  bar: () => barIds,
  setBar,
  openView: (id) => workbench.openView(id),
  run: (command) => void commands.run(command),
  showing: () => {
    const tab = L.activeTab(workbench.focusedGroup);
    return tab && { key: L.openableKey(tab), title: workbench.title(tab), note: "file" in tab && isNote(tab.file) };
  },
  contextViews: () => extensions.host.on().flatMap((m) => (m.contributes.views.context ?? []).map((v) => ({ id: v.id, title: v.name }))),
  drawView: (id, el) => workbench.drawInto(id, el),
  menu: () => [...extensions.menu("tabMenu").map((i) => action(i.command, { title: i.title })), action("tab.open"), action("window.openRight"), action("tab.close")],
  // Extensions' buttons, then the core's: a heading, a link, undo.
  toolbar: () => [
    ...extensions.host.on().flatMap((m) => m.contributes.toolbar.map((t) => ({ ...action(t.command), title: t.title, ...(t.icon ? { icon: t.icon } : {}), ...(t.label ? { label: t.label } : {}), off: extensions.offHere(m, t.requires) ?? action(t.command).off }))),
    action("editor.heading", { icon: "heading" }),
    action("editor.link", { icon: "link", label: "[[" }),
    action("editor.undo", { icon: "undo-2" }),
  ],
  kept: () => workbench.kept(),
  search: () => bar.open(),
  newNote: () => void commands.run("note.new"),
  push: (state) => browserHistory.place(state, false),
  replace: (state) => browserHistory.place(state, true),
  back: (n) => history.go(-n),
});
workbench.focusOnOpen = () => device.has("keyboard") || !device.has("touch");
// Without room beside the windows, a panel opens in the window instead.
panels.elsewhere = (id) => {
  if (!shell?.active) return false;
  workbench.openView(id);
  shell.showWindow();
  return true;
};
device.onChange(() => shell?.update());
savedListeners.push((path) => path === PLACES_PATH && void loadPlaces());

/** The note in focus's editor, for the keyboard toolbar's core buttons. */
const onNote = (run: (view: EditorView) => unknown) => () => {
  const view = workbench.focusedView;
  if (!view) return false;
  run(view);
  view.focus();
  return true;
};
commands.register(
  {
    id: "editor.heading",
    title: "Make this line a heading, or a smaller one",
    run: onNote((view) => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const hashes = /^#{1,6}\s/.exec(line.text)?.[0] ?? "";
      // # to ## to ### and back to none.
      const next = hashes.length >= 4 ? "" : hashes ? `#${hashes}` : "# ";
      view.dispatch({ changes: { from: line.from, to: line.from + hashes.length, insert: next }, userEvent: "input" });
    }),
  },
  {
    id: "editor.link",
    title: "Link to a note",
    run: onNote((view) => {
      const at = view.state.selection.main;
      view.dispatch({ changes: { from: at.from, to: at.to, insert: "[[]]" }, selection: { anchor: at.from + 2 }, userEvent: "input" });
    }),
  },
  { id: "editor.undo", title: "Undo typing", run: onNote((view) => undoTyping(view)) },
);

// Leaving the page: send what's unsaved without waiting for an answer.
window.addEventListener("pagehide", () => {
  const unsaved = workbench.unsaved();
  // Kept first, where it's sure to be written: the request may never arrive.
  offline.keepDraftsNow(unsaved);
  // Then sent as a beacon, which outlives the page more surely than a keepalive request. One the
  // browser won't take (too big) waits as a draft: a keepalive request would draw on the same budget.
  for (const u of unsaved) {
    if (typeof navigator.sendBeacon === "function") api.beacon(u.path, u.text, u.base, u.edit);
    else void api.write(u.path, u.text, u.base, u.edit, true).catch(() => {});
  }
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
    // Taken in, it says who changed it; one that clashes with your edit keeps saying that instead.
    if (open && !mine && notice.path === workbench.focusedPath && workbench.focusedSession?.status !== "conflict") {
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
  // This device's file first: what it has and your overrides decide which extensions are on here.
  await device.load({ read: (path) => offline.read(path), write: (path, text, base) => offline.write(path, text, base) });
  await extensions.load(BUILT_IN, files, settings["extensions.disabled"], SAFE, settings["extensions.trusted"]);
  catalog = extensions.catalog();
  extensions.declare();
  // Embeds draw in notes for the languages extensions that are on declare.
  workbench.extend(embeds({ ...extensions.embedHost, needs: embedNeeds }));
  await loadSettings();
  statesAtStart = extensionStates(BUILT_IN, files, settings["extensions.disabled"], SAFE, offHere());
  reloadSettingsAtStart = reloadSettingsNow();
  await extensions.start();
  // The Catalog, so a note can offer what its embeds need; editors redraw once it's read.
  listing ??= loadCatalog().then(() => {
    workbench.applySettings(settings);
    extensionsChanged();
  });
  await loadPlaces();
  const { missing } = await workbench.start(asked);
  // On a phone the note the app opens on shows over the Feed: an entry for the Feed below it, so back goes there first.
  shell.update();
  shell.started(history.state, (entry) => {
    const here = workbench.navigation.here;
    if (here) history.pushState({ nav: here.id, ...entry }, "", location.href);
  });
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
dev?.install({ workbench, extensions, commands, bar, offline, settings: () => settings, device });
