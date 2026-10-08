// The app: a list of notes, the windows (workbench.ts) and the command bar. Everything it does is a
// command (commands.ts); keybindings, the command bar and Vim's ex commands run them.
import { mediaHooks, whenHiddenOf } from "./media.ts";
import { embedHooks, resetFloats } from "./lives.ts";
import { isRecordPath } from "../../worker/src/records.ts";
import { isNote, merge, type ChangeNotice, type FilePath, type FileSummary } from "../../worker/src/files.ts";
import { FIRST_PARTY_CATALOG, parseCatalog, type CatalogEntry } from "../../worker/src/catalog.ts";
import { extensionFilePath, parseManifest } from "../../worker/src/extensions.ts";
import { api } from "./api.ts";
import { CommandBar } from "./commandbar.ts";
import { combine, CORE_CATALOG, DEFAULT_SETTINGS, DEFAULTS, isReadOnly, parseSettings, SETTINGS_TEMPLATE, userSettingsPath, WORKSPACE_SETTINGS, type Settings, type SettingsCatalog } from "../../worker/src/settings.ts";
import { editSetting, settingsEditor, SETTINGS_VIEW, writeSetting, type Level, type Shown } from "./settings-ui.ts";
import { deviceSummary, renderDevice } from "./device-ui.ts";
import { settingsJson } from "./settings-json.ts";
import { APP_ONLY, bindingForKey, Commands, keyFor, refusalSummary } from "./commands.ts";
import { ago, describeAuthor, docLabel } from "./describe.ts";
import { Search } from "./search.ts";
import { format } from "../../worker/src/query.ts";
import { afterBurst, connectLive } from "./live.ts";
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
import { createState, editText, floatsOverEditors } from "./editor.ts";
import { keptWhen, showClash } from "./conflict.ts";
import { askPermission, confirmDialog, textDialog, type Asker } from "./dialog.ts";
import { activityView } from "./activity.ts";
import { parseGrants, type Answer } from "../../worker/src/permissions.ts";
import { EditorView } from "@codemirror/view";
import { idbKV, Offline, syncLine, UNREACHABLE_TEXT } from "./offline.ts";
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
import { barOf, GO_KEYS, PLACES_PATH, savedOf, type SavedSearch } from "../../worker/src/places.ts";
import { parsePins, PINS_PATH } from "../../worker/src/pins.ts";
import { GoKeys, Sidebar, type Chosen } from "./sidebar.ts";
import { changePlaces, placesChangeOf, sendPlaces, type PlacesChange } from "./places-file.ts";
import { undo as undoTyping } from "@codemirror/commands";
import { atLeast, deviceOfLayout, here, hereText, needsText, parseDeviceFile, type Override, type Requires } from "../../worker/src/devices.ts";

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
const notSavedLine = $("#not-saved");
const resolveButton = $<HTMLButtonElement>("#resolve");
const reloadLine = $("#reload");
const netLine = $("#net-activity");
netLine.addEventListener("click", () => panels.show("extension-activity"));

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
  conflict: "Not saved: this note changed in the same place elsewhere.",
  offline: UNREACHABLE_TEXT,
};

let files: FileSummary[] = [];
let settings: Settings = DEFAULTS;
/** Every setting there is: the app's, and each installed extension's, once their manifests are read. */
let catalog: SettingsCatalog = CORE_CATALOG;
let lastFile: FilePath | null = null;
/** Back online with edits still held: they go at their next retry, so until one fails again, they're being sent. */
let sending = false;
/** What the phone's not-saved pill says now. */
let notSaying = "";
const savedListeners: Array<(path: FilePath) => void> = [];
const changeListeners: Array<(notice: ChangeNotice) => void> = [];
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
      history.pushState({ nav: visit.id, ...shell?.entryFor(L.openableKey(L.fileTab(visit.file))) }, "", addressFor(visit.file));
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
      // A save that failed with the server reachable: it isn't on its way.
      if (status === "offline") sending = false;
      resolveButton.hidden = status !== "conflict";
      queueMicrotask(() => void renderUnsent());
    },
    navigated: (how, visit) => {
      browserHistory.follow(how, visit);
      // On a phone, a note opened shows over the place it was opened from.
      if (how === "push") shell?.showWindow();
    },
    // On a phone, a file opened shows over the place, the one on show already included.
    opened: () => shell?.showWindow(),
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
  // On a phone, the shell shows what the entry says: a place's list, a view, or a note.
  if (shell?.popped(e.state)) return;
  const id = (e.state as { nav?: unknown } | null)?.nav;
  const restore = (typeof id === "number" ? workbench.goTo(id) : Promise.resolve(false)).then(async (went) => {
    const file = went ? null : fileFromUrl(location.search);
    if (file) await workbench.open(file, { jump: false });
  });
  void (shell ? shell.hold(restore) : restore);
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

/** Offline, and how many edits are waiting to be sent, only when there's something to say; on a phone, only that something isn't saved. */
async function renderUnsent() {
  const unsent = await offline.unsent();
  const ops = await offline.ops();
  // Held edits the server refused, and open notes whose edit clashes with someone else's: said once, as clashes.
  const clashing = [...new Set([...unsent.filter((u) => u.conflict).map((u) => u.path), ...workbench.pending().flatMap((p) => (p.status === "conflict" ? [p.path] : []))])];
  const waiting = unsent.filter((u) => !clashing.includes(u.path)).length + ops.length;
  // Kept in memory only (this browser won't keep site data): they're gone if the page closes before they're sent.
  const fragile = waiting > 0 && !(await offline.durable());
  if (!waiting) sending = false;
  const line = syncLine({ online: offline.online, waiting, fragile, sending, clashing: clashing.map(docLabel) });
  unsentLine.textContent = line.wide;
  unsentLine.title = [...unsent.map((u) => `${u.path}${clashing.includes(u.path) ? " (can't be merged)" : ""}`), ...ops.map((o) => o.what)].join("\n");
  unsentLine.dataset.state = line.state;
  const clash = line.state === "conflict";
  notSavedLine.dataset.state = line.state;
  notSavedLine.setAttribute("role", clash ? "button" : "status");
  if (clash) notSavedLine.tabIndex = 0;
  else notSavedLine.removeAttribute("tabindex");
  const showing = !notSavedLine.hidden;
  notSaying = line.phone;
  notSavedLine.hidden = !line.phone;
  if (!line.phone) notSavedLine.textContent = "";
  else if (showing) {
    notSavedLine.textContent = line.phone;
    placeNotSaved();
  }
  // Shown first and said a frame later, so screen readers hear the live region change.
  else
    requestAnimationFrame(() => {
      placeNotSaved();
      notSavedLine.textContent = notSaying;
      // The line being edited, if the pill now covers it, moves out from under it; otherwise the
      // scroll stays where you left it. A laptop has no pill (the CSS hides it), so nothing moves there.
      const view = workbench.focusedView;
      if (!view || !notSavedLine.getClientRects().length) return;
      const pill = notSavedLine.getBoundingClientRect();
      const cursor = view.coordsAtPos(view.state.selection.main.head);
      if (cursor && cursor.top < pill.bottom && pill.top < cursor.bottom) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
    });
}
let wasOnline = offline.online;
offline.onChange(() => {
  sending = offline.online && (sending || !wasOnline);
  wasOnline = offline.online;
  void renderUnsent();
});
/** Open the first note whose edit can't be merged, and show the two. */
async function openClash() {
  const clashing = (await offline.unsent()).find((u) => u.conflict)?.path ?? workbench.pending().find((p) => p.status === "conflict")?.path;
  if (!clashing) return;
  if (clashing !== workbench.focusedPath) await workbench.open(clashing, { newTab: true });
  await resolveConflict();
}
unsentLine.addEventListener("click", () => void openClash());
/**
 * Where the pill floats. Over a note, just inside the top of the top right window's editors, whatever
 * is above them, where a note has an empty margin. Over anything else (a view, a panel, Trash, the
 * calendar), whose top is its controls, at the bottom, above the on-screen keyboard.
 */
function placeNotSaved() {
  if (notSavedLine.hidden) return;
  const tops = [...$("#workbench").querySelectorAll<HTMLElement>(".editors")].flatMap((e) => (e.getClientRects().length ? [e.getBoundingClientRect()] : []));
  const box = tops.sort((a, b) => b.right - a.right || a.top - b.top)[0];
  const top = box?.top ?? 0;
  notSavedLine.style.setProperty("--not-saved-at", `${Math.round(top)}px`);
  // What's there in the windows, under where the pill would sit at the top: a note's editor, or
  // something else. Overlays above them (Search, a menu, a dialog) aren't what it floats over once they close.
  const workbenchEl = $("#workbench");
  const under = box ? document.elementsFromPoint(box.right - 24, top + 16).find((e) => workbenchEl.contains(e)) : null;
  notSavedLine.dataset.at = under?.closest(".editors .cm-editor") ? "top" : "bottom";
  const viewport = window.visualViewport;
  notSavedLine.style.setProperty("--keyboard", `${viewport ? Math.max(0, Math.round(innerHeight - viewport.offsetTop - viewport.height)) : 0}px`);
}
// Placed again when the windows move (the page resizing, a bar above them coming or going), the
// keyboard comes or goes, focus moves, or a panel opens or closes.
new ResizeObserver(placeNotSaved).observe($("#workbench"));
window.visualViewport?.addEventListener("resize", placeNotSaved);
focusListeners.push(() => requestAnimationFrame(placeNotSaved));
new MutationObserver(() => requestAnimationFrame(placeNotSaved)).observe($("#panel"), { attributes: true, attributeFilter: ["hidden", "class"] });
// And as a menu or a dialog closes, in case what's under it changed while it was open.
new MutationObserver(() => requestAnimationFrame(placeNotSaved)).observe(document.body, { childList: true });
floatsOverEditors(notSavedLine);
notSavedLine.addEventListener("click", () => void openClash());
notSavedLine.addEventListener("keydown", (e) => {
  if (notSavedLine.dataset.state !== "conflict" || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  void openClash();
});
// A tap on the pill leaves the note focused, so a phone's keyboard stays up.
notSavedLine.addEventListener("mousedown", (e) => e.preventDefault());
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
    workbench.notice("Their version can't be read while offline: try again when you're back online.", [], "alert");
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
  // A change to places.json is made on the file as the server has it now; the rest are records' edits.
  const { refused } = await offline.flushOps((op) => {
    const places = placesChangeOf(op);
    return places ? sendPlaces(offline, places) : api.editEvent(op.method, op.body, op.extension);
  });
  for (const { op, error } of refused) workbench.notice(`${op.what} couldn't be made: ${error}`, [], "alert");
  const { sent } = await offline.flush((path) => workbench.isOpen(path));
  if (sent.length) {
    await refreshList();
    await workbench.refreshFromServer(sent);
  }
}
window.setInterval(() => void sendUnsent(), 5000);
window.addEventListener("online", () => void sendUnsent());

/**
 * What the list beside the note shows (decision 4): the Feed (every note, until the Feed lists them by
 * their changes), or the notes a saved search finds. On a phone it's the Feed's screen.
 */
let listShows: { feed: true } | { all: true } | { saved: SavedSearch; results: Array<{ path: FilePath; title: string; line?: string }> | null; more?: boolean; note?: string } = { feed: true };
const listHead = document.createElement("header");
listHead.className = "list-head";
$("#notes").prepend(listHead);

/** A row of the list: a note, opened in the window beside (⌘-click or a double click, in a tab of its own). */
function listRow(path: FilePath, label: string, current: FilePath | null, detail?: string) {
  const a = document.createElement("a");
  a.href = urlForFile(path);
  a.textContent = label;
  if (detail) a.append(Object.assign(document.createElement("small"), { textContent: detail }));
  if (path === current) a.setAttribute("aria-current", "page");
  // What it opens, for the Workbench extension's dragging into windows.
  a.dataset.open = JSON.stringify(L.fileTab(path));
  a.dataset.title = label;
  // Double-click opens it kept, not as the preview tab.
  a.addEventListener("dblclick", (e) => {
    e.preventDefault();
    void workbench.open(path, { newTab: true });
  });
  a.addEventListener("click", async (e) => {
    e.preventDefault();
    await workbench.open(path, { newTab: IS_MAC ? e.metaKey : e.ctrlKey });
  });
  const li = document.createElement("li");
  li.append(a);
  return li;
}

/** The Feed, drawn in the list column on a wide screen (decision 4): a card opens its note beside it. */
const feedBox = document.createElement("div");
feedBox.className = "list-feed";
feedBox.hidden = true;
$("#notes").append(feedBox);
/**
 * Whether the Feed is to be drawn in the list column again: at first, and when you go to it. Opened in a
 * tab (Open the Feed), it's there instead, and the column lists every note until you go to the Feed again.
 */
let drawFeed = true;
/** Whether the list column shows the Feed extension's view: on a wide screen, with the Feed on and chosen, and it here. */
function feedInList(): boolean {
  if (!("feed" in listShows) || !device.atLeast("expanded") || !extensions.host.records.some((r) => r.id === "feed" && r.state === "active")) return false;
  if (drawFeed) {
    workbench.drawInto("feed", feedBox);
    drawFeed = !feedBox.childElementCount;
  }
  return feedBox.childElementCount > 0;
}

function renderList() {
  const current = workbench.focusedPath;
  const feed = feedInList();
  // The Feed is the place but hasn't drawn yet (the app starting): its column waits, empty, at its
  // width, so the note beside it doesn't change width (and its embeds height) once it has.
  const coming = !feed && drawFeed && "feed" in listShows && device.atLeast("expanded") && feedOn();
  document.documentElement.toggleAttribute("data-list-feed", feed || coming);
  feedBox.hidden = !feed;
  listHead.hidden = list.hidden = feed || coming;
  // Behind the Feed, the rows of every note aren't kept: they're drawn again when they show.
  if (feed || coming) return void list.replaceChildren();
  if ("saved" in listShows) {
    const { saved, results, more, note } = listShows;
    listHead.replaceChildren(Object.assign(document.createElement("h2"), { textContent: saved.name }), Object.assign(document.createElement("code"), { textContent: saved.query }));
    const rows = (results ?? []).map((r) => listRow(r.path, r.title, current, r.line));
    const say = (text: string) => Object.assign(document.createElement("li"), { className: "list-note", textContent: text });
    list.replaceChildren(...rows, ...(note ? [say(note)] : results === null ? [say("Searching…")] : !rows.length ? [say("No notes match.")] : more ? [say("More notes match than one search reads: add words or filters.")] : []));
    return;
  }
  // Every note: the Feed's list until the Feed extension is on; with it, the Feed opens in the window.
  listHead.replaceChildren(Object.assign(document.createElement("h2"), { textContent: feedOn() ? "All notes" : "Feed" }));
  const notes = files.filter((d) => isNote(d.path));
  if (current && isNote(current) && !notes.some((n) => n.path === current)) notes.push({ path: current, revision: 0 });
  list.replaceChildren(...notes.map((n) => listRow(n.path, name(n.path), current)));
}

/** Whether the Feed extension is on, so the Feed is its view, not the list of every note. */
function feedOn(): boolean {
  return extensions.host.records.some((r) => r.id === "feed" && (r.state === "active" || r.state === "inactive"));
}

/** Show a saved search's notes in the list, and keep them current as notes change. */
async function showSaved(saved: SavedSearch) {
  if (!("saved" in listShows) || listShows.saved.name !== saved.name || listShows.saved.query !== saved.query) listShows = { saved, results: null };
  renderList();
  try {
    const found = await api.search(saved.query, 200);
    if (!("saved" in listShows) || listShows.saved.query !== saved.query) return;
    listShows = { saved, results: found.results.map((r) => ({ path: r.path as FilePath, title: r.title, line: r.line?.text })), more: found.more };
  } catch {
    if (!("saved" in listShows) || listShows.saved.query !== saved.query) return;
    listShows = { saved, results: [], note: "Searching needs a connection." };
  }
  renderList();
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

/** A sandboxed extension's refusals in a row, by its id, while their notice is up: another is summed up with them. */
let refusals: { from: string; refused: Array<{ title: string; why: string }>; up: () => boolean } | null = null;
const commands = new Commands((title, why, by) => {
  const one = `${title}: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
  if (by === "app") return void workbench.notice(one, [], "alert");
  const refused = [...(refusals?.from === by.sandbox && refusals.up() ? refusals.refused : []), { title, why }];
  // Its own command off on this device is news: only asking for what only you may run is an alert, so an extension can't hold the alert's place.
  const urgency = refused.some((r) => r.why === APP_ONLY) ? "alert" : "news";
  refusals = { from: by.sandbox, refused, up: workbench.notice(refused.length > 1 ? refusalSummary(by.name, refused) : `${by.name}: ${one}`, [], urgency) };
});
/** Why a core command is off on this device, if it is: what it needs and the device hasn't. */
const needs = (requires: Requires) => () => hereText(here(requires, device.facts));
commands.register(
  { id: "quickOpen", title: "Search…", run: () => pick("here") },
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

/** Folders that hold notes, for completing `in:`. */
const folders = () => [...new Set(files.filter((f) => isNote(f.path) && !f.path.startsWith(".")).flatMap((f) => f.path.split("/").slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join("/")}/`)))].sort();
const search = new Search({
  manifests: () => extensions.host.records.filter((r) => r.state !== "off").map((r) => r.manifest),
  owner: (type) => extensions.ownership.owner("searchType", type),
  notes: {
    search: async (query, limit, within) => {
      const answer = await api.search(format(query), limit, within);
      return {
        more: answer.more,
        results: answer.results.map((r) => ({
          title: r.title,
          path: r.path,
          detail: r.line?.text ?? r.path,
          aside: `${r.archived ? "archived · " : r.trashed ? "in Trash · " : ""}${ago(r.edited)}`,
          dim: r.archived === true || r.trashed === true,
          run: () => (r.trashed ? commands.run("trash.show") : openFromBar(r.path as FilePath)),
        })),
      };
    },
  },
  values: (key) => (key === "in" ? folders() : []),
});
const bar = new CommandBar({ all: () => search.filters(), extraKeys: () => search.extraKeys() });
// The pill's place again as Search closes.
new MutationObserver(() => requestAnimationFrame(placeNotSaved)).observe($("#command-bar"), { attributes: true, attributeFilter: ["hidden"] });
const panels = new Panels($("#panel"));

const promptFor: Prompt<[Trigger | null]> = (m, asks, joined, trigger) => askPermission(askerOf(m.id), m, asks, joined, trigger);
const extensions = new ExtensionRuntime({
  me,
  commands,
  bar,
  search,
  statusItems: new StatusItems($("#status-left"), $("#status-right"), (command, owner, by) => extensions.runFor(owner, command, by)),
  panels,
  workbench,
  offline,
  settings: () => settings,
  files: () => files,
  openFromBar,
  lastFile: () => lastFile,
  onSaved: savedListeners,
  onChange: changeListeners,
  onFocus: focusListeners,
  onRecords: recordListeners,
  saveGrant: async (id, key, answer) => {
    await answerGrant(id, key, answer);
    await loadSettings();
  },
  prompt: dev ? dev.prompt(promptFor) : promptFor,
  // It tried something it never asked for: say so once, with where to see what it does ask for.
  undeclared: (denied) => workbench.notice(denied.message, [{ label: changeIn(denied.extension.name), run: () => extensionsUi.showDetails(denied.extension.id) }], "alert"),
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
  // The Feed started (or stopped): the list beside the note is drawn again, if it's the Feed's.
  if ("feed" in listShows && drawFeed) renderList();
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
/**
 * Your answer to one of an extension's permissions, in your settings, beside the others there (or
 * none, to ask again). Each settings file's answers are edited as that file has them: the settings
 * combined from all of them take the whole key from one file, and writing those back would copy
 * another file's answers over, or lose its own.
 */
function answerGrant(id: string, key: string, answer: Answer | undefined) {
  return editSetting(api, USER_SETTINGS ?? WORKSPACE_SETTINGS, "extensions.permissions", (value) => {
    const grants = parseGrants(value);
    const mine = { ...grants[id] };
    if (answer) mine[key] = answer;
    else delete mine[key];
    return { ...grants, [id]: mine };
  });
}

/** Forget every answer to an extension's permissions, in each settings file that has any. */
async function forgetGrants(id: string) {
  for (const path of new Set([USER_SETTINGS, WORKSPACE_SETTINGS].filter((p) => p !== null)))
    await editSetting(api, path, "extensions.permissions", (value) => {
      const grants = parseGrants(value);
      if (!(id in grants)) return value;
      const { [id]: _forgotten, ...others } = grants;
      return others;
    });
}

/**
 * Clear away a retired Catalog extension's copy (Word count): its files and your answers to its
 * permissions, each a change in History that undo can take back. Done once: then there's nothing left.
 */
async function clearRetired(found: readonly { id: string; files: FilePath[] }[]) {
  const kept: FilePath[] = [];
  for (const w of found) {
    // The Catalog's files only: anything you added in its folder stays, and you're told.
    const catalogs = new Set(["extension.json", "index.js", "installed.json"].map((f) => `.common-ink/extensions/${w.id}/${f}`));
    const theirs = w.files.filter((p) => catalogs.has(p));
    // Every file in its folder, notes too, which aren't the extension's own files.
    kept.push(...files.map((f) => f.path).filter((p) => p.startsWith(`.common-ink/extensions/${w.id}/`) && !catalogs.has(p)));
    workbench.forget(theirs);
    for (const path of theirs) {
      const file = await api.read(path).catch(() => null);
      if (file?.revision) await api.delete(path, file.revision);
    }
    await forgetGrants(w.id);
  }
  if (!found.length) return;
  await loadSettings();
  await refreshList();
  if (kept.length) workbench.notice(`Word count left the Catalog, and its files are gone. ${kept.length === 1 ? "A file" : `${kept.length} files`} you added in its folder stayed: ${kept.map(docLabel).join(", ")}.`);
}

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
    await answerGrant(r.id, key, answer);
    await loadSettings();
  },
  async resetAnswers(r) {
    await forgetGrants(r.id);
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
      workbench.notice(`Couldn't install it: ${(err as Error).message}`, [], "alert");
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
    workbench.notice(`Couldn't install ${entry.name}: ${(err as Error).message}`, [], "alert");
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

/** Where Vim stands here once a choice is saved, said as it is: on, going after a reload, off here and why, or off in settings. */
function vimHere(): string {
  const r = extensions.host.records.find((x) => x.id === "vim");
  if (!r || r.state === "off") return "Vim stays off: it's turned off in your settings (extensions.disabled).";
  if (r.state === "safe" || r.state === "failed") return `Vim isn't running${r.state === "safe" ? " in safe mode" : ": it failed to start"}.`;
  const h = extensions.here(r.manifest);
  // On here: running, or about to go in (the device's change puts it in).
  if (h.on) return h.by === "you" ? "Vim is on here, keyboard or not." : "Vim is on here.";
  if (r.state !== "unmet") return "Vim goes after a reload.";
  return h.by === "you" ? "Vim is off here." : `Vim is off here: it ${needsText(h.needs)}.`;
}

/** Say what a device choice did. Something still running that's now off here goes after a reload, as turning an extension off does: offer it. */
function deviceNotice(lead: string) {
  const going = extensions.host.records.filter((r) => (r.state === "active" || r.state === "inactive") && !extensions.here(r.manifest).on).map((r) => r.manifest.name);
  const vim = vimHere();
  const reload = going.filter((n) => n !== "Vim");
  const text = [lead, vim, reload.length ? `${reload.join(", ")} ${reload.length === 1 ? "goes" : "go"} after a reload.` : ""].filter(Boolean).join(" ");
  workbench.notice(text, going.length ? [{ label: "Reload", run: () => reloadWindow() }] : [{ label: "This device", run: () => openSettingsUi("device") }]);
}

// What Settings › This device and the Extensions view's On here do, as commands, so they're in the command
// bar: for a phone or tablet with a keyboard the app didn't find, or a Vim user on one. Only you run them:
// an extension that ran them would be choosing what runs on your device.
commands.register(
  { id: "device.keyboardYes", title: "Keyboard: this device has a keyboard", appOnly: true, run: () => device.setKeyboard("yes").then(() => deviceNotice("This device has a keyboard.")) },
  { id: "device.keyboardNo", title: "Keyboard: this device has no keyboard", appOnly: true, run: () => device.setKeyboard("no").then(() => deviceNotice("This device has no keyboard.")) },
  {
    id: "device.keyboardAuto",
    title: "Keyboard: let the app tell whether this device has one",
    appOnly: true,
    run: () => device.setKeyboard("auto").then(() => deviceNotice(`The app tells whether this device has a keyboard: ${device.has("keyboard") ? "it has one" : "none found yet"}.`)),
  },
  { id: "vim.onHere", title: "Vim: turn on for this device", appOnly: true, run: () => setOverride("vim", "on").then(() => deviceNotice("Vim: On for this device.")) },
  { id: "vim.offHere", title: "Vim: turn off for this device", appOnly: true, run: () => setOverride("vim", "off").then(() => deviceNotice("Vim: Off for this device.")) },
  {
    id: "vim.autoHere",
    title: "Vim: on here whenever this device has a keyboard",
    appOnly: true,
    run: () => setOverride("vim", undefined).then(() => deviceNotice("Vim: Auto for this device, on with a keyboard.")),
  },
);

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
  if (!trusted && settings["extensions.trusted"].includes(id)) workbench.notice(`${id} is still trusted: fix the settings file that lists it under extensions.trusted (it isn't valid JSON), then try again.`, [], "alert");
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
    // A modal has the keys while it's up: its own, and Tab and Escape. So does the command bar while
    // it has focus: off a Mac, its Ctrl-k and Ctrl-p move through what it lists, not open it again.
    if (modalOpen() || bar.hasFocus) return;
    const binding = bindingForKey(e, settings.keybindings);
    // A command that declines the key (it doesn't apply here) leaves it to do what it would have.
    if (!binding?.command || !commands.runForKey(binding.command, binding.by)) return;
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
/** The saved searches, from places.json, kept up to date as it changes. */
let savedSearches: SavedSearch[] = [];
async function loadPlaces() {
  const text = (await offline.read(PLACES_PATH).catch(() => ({ text: "" }))).text;
  barIds = barOf(text);
  savedSearches = savedOf(text);
  shell?.update();
  // A saved search on show that's renamed or removed: the list goes back to the Feed.
  const shown = listShows;
  if ("saved" in shown && !savedSearches.some((q) => q.name === shown.saved.name)) showFeed();
  void countSaved();
  sidebar.render();
}
/** Write one key of places.json (places-file.ts), saying what happened in a notice. */
/** Change one key of places.json (places-file.ts): held, and sent with the rest of what's held. */
const writePlaces = (change: PlacesChange, what: string) => changePlaces(offline, change, what, sendUnsent, (message) => workbench.notice(message));
async function setBar(ids: string[]) {
  barIds = ids;
  await writePlaces({ key: "bar", ids }, "the bottom bar");
}
/** Whether an extension owns a view (ownership.ts): what names a view reaches only its owner's. */
const ownsView = (extension: string, view: string) => extensions.ownership.owns(extension, "view", view);
/** Every place, in order: the Feed (the Feed extension's view, or the notes list without it), extensions' places, views that aren't places yet, Extensions and Settings. */
function places(): Place[] {
  const on = extensions.host.records.filter((r) => r.state === "inactive" || r.state === "active");
  const placed = new Set(on.flatMap((r) => r.manifest.contributes.places.flatMap((p) => ("view" in p ? [p.view] : []))));
  // The Feed is the core's place; its view is the Feed extension's, while that's on (and isn't listed again as a view).
  const feed = on.some((r) => r.id === "feed") && ownsView("feed", "feed");
  if (feed) placed.add("feed");
  /**
   * Who a place is from, said beside it so no extension's place passes for the app's own: a workspace
   * extension says so, so one named like the app can't pass for a built-in; a built-in named as its place
   * (Tasks' Tasks) isn't said twice.
   */
  const from = (r: (typeof on)[number], title: string) => {
    if (r.workspace) return `${r.manifest.name} · workspace extension`;
    return r.manifest.name.trim().toLowerCase() === title.trim().toLowerCase() ? undefined : r.manifest.name;
  };
  const place = (r: (typeof on)[number], p: Omit<Place, "from">): Place => {
    const by = from(r, p.title);
    return by ? { ...p, from: by } : p;
  };
  return [
    { id: "feed", title: "Feed", icon: "inbox", open: feed ? { view: "feed" } : { list: true } },
    // An extension's places are named for it, so none can be the core's (feed, extensions, settings) or another's.
    // A place runs a command, or shows a view, still the extension's own (the runtime's bindable, and who owns
    // the view), as its keys and menu items do: none reaches another extension's.
    ...on.flatMap((r) => r.manifest.contributes.places.filter((p) => ("view" in p ? ownsView(r.id, p.view) : extensions.bindable(r.manifest)(p.command))).map((p) => place(r, { id: `${r.id}.${p.id}`, title: p.title, icon: isIcon(p.icon) ? p.icon : "file-text", open: "view" in p ? { view: p.view } : { command: p.command }, ...extensions.by(r.manifest) }))),
    ...on.flatMap((r) => (r.manifest.contributes.views.sidebar ?? []).filter((v) => !placed.has(v.id) && ownsView(r.id, v.id)).map((v) => place(r, { id: `view:${v.id}`, title: v.name, icon: "file-text", open: { view: v.id } }))),
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
  restore: async (show, nav) => {
    if (show.startsWith("view:")) return workbench.openView(show.slice("view:".length));
    const file = show.startsWith("file:") ? (show.slice("file:".length) as FilePath) : null;
    // Its place in Navigation's history brings its window and cursor back; one no longer kept, just the note.
    const went = typeof nav === "number" && (await workbench.goTo(nav));
    if (file && (!went || workbench.focusedPath !== file)) await workbench.open(file, { jump: false });
  },
  // Done when what the command does is (a note opened); refused at once when it's off here, or app-only and a sandboxed extension's.
  run: (command, by) => commands.start(command, by),
  visitId: () => workbench.navigation.here?.id ?? null,
  notice: (message) => workbench.notice(message),
  showing: () => {
    const tab = L.activeTab(workbench.focusedGroup);
    return tab && { key: L.openableKey(tab), title: workbench.title(tab), note: "file" in tab && isNote(tab.file) };
  },
  contextViews: () => extensions.host.on().flatMap((m) => (m.contributes.views.context ?? []).filter((v) => ownsView(m.id, v.id)).map((v) => ({ id: v.id, title: v.name }))),
  drawView: (id, el) => workbench.drawInto(id, el),
  menu: () => [...extensions.menu("tabMenu").map((i) => action(i.command, { title: i.title, ...(i.by ? { by: i.by } : {}) })), action("tab.open"), action("window.openRight"), action("tab.close")],
  // Extensions' buttons, then the core's: a heading, a link, undo.
  toolbar: () => [
    ...extensions.host.on().flatMap((m) => m.contributes.toolbar.filter((t) => extensions.bindable(m)(t.command)).map((t) => ({ ...action(t.command), title: t.title, ...(t.icon ? { icon: t.icon } : {}), ...(t.label ? { label: t.label } : {}), off: extensions.offHere(m, t.requires) ?? action(t.command).off, ...extensions.by(m) }))),
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

// Places on wide screens (sidebar.ts): the sidebar, the list beside the note, ⌘B and the go keys, at 840px and over.
/** What's chosen in the sidebar. */
let chosen: Chosen = { place: "feed" };
/** The pinned notes, from pins.json (the Feed's pins, decision 16), kept up to date as it changes. */
let pinned: FilePath[] = [];
async function loadPins() {
  pinned = parsePins((await offline.read(PINS_PATH).catch(() => ({ text: "" }))).text);
  sidebar.render();
}
/** How many notes each saved search finds, said beside it: worked out again a moment after notes change. */
const savedCounts = new Map<string, string>();
let counting = 0;
async function countSaved() {
  const turn = ++counting;
  for (const q of savedSearches) {
    const found = await api.search(q.query, 1).catch(() => null);
    if (turn !== counting) return;
    if (found) savedCounts.set(q.query, `${found.total}${found.more ? "+" : ""}`);
  }
  sidebar.render();
}
let recount = 0;
function showFeed() {
  listShows = { feed: true };
  drawFeed = true;
  renderList();
}
/** Go to a place: the Feed in the list beside the note, a view in the window, or a command's place. */
function goTo(place: Place) {
  chosen = { place: place.id };
  // The Feed is the list beside the note (decision 4): with the Feed extension on, its cards, else every note.
  // Another place shows in the window, with every note in the list beside it.
  if ("list" in place.open || place.id === "feed") showFeed();
  else {
    listShows = { all: true };
    renderList();
    if ("view" in place.open) workbench.openView(place.open.view);
    else void commands.start(place.open.command, place.by);
  }
  sidebar.render();
}
async function saveSearch(query: string) {
  const name = (await textDialog("Save this search", `It's kept in Places, with how many notes it finds: ${query}`, "Name", "Save", "text"))?.trim();
  if (!name) return;
  if (savedSearches.some((q) => q.name === name) && !(await confirmDialog(`Replace "${name}"?`, `A saved search is called that. Its query becomes ${query}.`, "Replace"))) return;
  savedSearches = [...savedSearches.filter((q) => q.name !== name), { name, query }];
  chosen = { saved: name };
  void showSaved({ name, query });
  sidebar.render();
  await writePlaces({ key: "saved", name, query }, "the saved searches");
}
const sidebar = new Sidebar({
  places,
  pinned: () => pinned.map((path) => ({ path, title: name(path) })),
  saved: () => savedSearches.map((q) => ({ ...q, ...(savedCounts.has(q.query) ? { count: savedCounts.get(q.query) } : {}) })),
  current: () => chosen,
  go: goTo,
  openPinned: (path) => {
    chosen = { pinned: path };
    sidebar.render();
    void workbench.open(path);
  },
  openSaved: (q) => {
    chosen = { saved: q.name };
    sidebar.render();
    void showSaved(q);
  },
  removeSaved: (q) => {
    savedSearches = savedSearches.filter((s) => s.name !== q.name);
    if ("saved" in chosen && chosen.saved === q.name) {
      chosen = { place: "feed" };
      showFeed();
    }
    sidebar.render();
    void writePlaces({ key: "saved", name: q.name, query: null }, "the saved searches").then(() => workbench.notice(`Removed "${q.name}" from Places: undo its change to places.json in History to bring it back.`));
  },
  search: () => void commands.run("quickOpen"),
});
document.body.insertBefore(sidebar.root, $("#notes"));
bar.onSave = (query) => void saveSearch(query);
/** Whether Places is a sidebar here: on wide screens, unless ⌘B put it away (kept in this browser). */
const PLACES_HIDDEN = "common-ink.places-hidden";
let placesHidden = (() => {
  try {
    return localStorage.getItem(PLACES_HIDDEN) === "1";
  } catch {
    return false;
  }
})();
const wide = () => device.atLeast("expanded");
function placeSidebar() {
  document.documentElement.toggleAttribute("data-places", wide() && !placesHidden);
  sidebar.render();
  renderList();
}
device.onChange(placeSidebar);
placeSidebar();
savedListeners.push((path) => {
  if (path === PINS_PATH) void loadPins();
  else if (isNote(path)) {
    // A note changed: the saved searches' counts, and the one on show, again in a moment.
    clearTimeout(recount);
    recount = window.setTimeout(() => {
      void countSaved();
      if ("saved" in listShows) void showSaved(listShows.saved);
    }, 1000);
  }
});
void loadPins();
/** What each go key's command is called (`g` then the key, study 9.3). */
const GO_TITLES: Readonly<Record<string, string>> = { f: "Feed", "/": "Search", d: "Today", t: "Tasks", c: "Calendar", a: "Archive", x: "Trash", s: "Sources", e: "Extensions", ",": "Settings" };
/** The go keys (study 9.3): `g`, then a key, outside text, at 840px and over. */
const goPlace = (key: string): boolean => {
  const id = GO_KEYS[key];
  if (!id) return false;
  if (id === "search") return void commands.run("quickOpen"), true;
  const place = places().find((p) => p.id === id);
  if (!place) return false;
  goTo(place);
  return true;
};
const goKeys = new GoKeys(goPlace);
window.addEventListener(
  "keydown",
  (e) => {
    if (!wide() || modalOpen() || bar.hasFocus || !goKeys.key(e)) return;
    e.preventDefault();
    e.stopPropagation();
  },
  { capture: true },
);
commands.register(
  {
    id: "places.toggle",
    title: "Show or hide Places",
    // Under 840px Places is a sheet, from the bottom bar: the key does what it would have. So it does off a
    // Mac in a note with Vim, where Ctrl-b is Vim's page up.
    run: () => {
      if (!wide()) return false;
      if (!IS_MAC && document.activeElement?.closest(".cm-editor") && extensions.host.records.find((r) => r.id === "vim")?.state === "active") return false;
      placesHidden = !placesHidden;
      try {
        localStorage.setItem(PLACES_HIDDEN, placesHidden ? "1" : "0");
      } catch {
        // Kept for this page only.
      }
      placeSidebar();
      if (!placesHidden) sidebar.focus();
    },
  },
  { id: "places.focus", title: "Go to Places", run: () => (wide() ? (placesHidden && commands.run("places.toggle"), sidebar.focus()) : false) },
  ...Object.entries(GO_KEYS).map(([key, id]) => ({ id: `go.place.${id}`, title: `Go to ${GO_TITLES[key]}`, run: () => goPlace(key) })),
);

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
// Extensions hear of every file that changed, once a burst of changes ends (the history view redraws, say).
const heardChange = afterBurst(400, (path) => savedListeners.forEach((fn) => fn(path)));
let recordsTimer = 0;
connectLive({
  async change(notice) {
    for (const fn of changeListeners) fn(notice);
    // A deleted note isn't left open to type into: its windows' tabs close, unless it has changes not yet
    // saved, which stay, with a word on where it went.
    if (notice.deleted && isNote(notice.path)) {
      void refreshList();
      const who = notice.author.kind === "user" && notice.author.email === me ? "" : ` by ${describeAuthor(notice.author, me)}`;
      const open = L.groups(workbench.layout).some((g) => g.tabs.some((t) => "file" in t && t.file === notice.path));
      if (notice.purged) {
        // Deleted forever: nothing of it stays here, open, kept for offline, or waiting to be sent.
        if (open) workbench.forget([notice.path]);
        await offline.forget(notice.path);
        if (open) workbench.notice(`"${name(notice.path)}" was deleted forever${who}`);
      } else if (workbench.pending().some((p) => p.path === notice.path)) workbench.notice(`"${name(notice.path)}" was moved to Trash${who}: your changes are still here, and Restore in Trash brings the note back.`);
      else if (open) {
        workbench.forget([notice.path]);
        if (who) workbench.notice(`"${name(notice.path)}" was moved to Trash${who}`);
      }
      heardChange(notice.path);
      return;
    }
    // A note deleted forever where another note is now: what this browser kept for the purged one goes.
    if (notice.purged) await offline.forgetPurged(notice.path, async (r) => (await api.version(notice.path, r).catch(() => "")) === null);
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
    heardChange(notice.path);
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
  // On a phone the app opens on the place you were last on, or a note its address names over the Feed.
  shell.update();
  shell.started(history.state, { note: !!asked });
  const failed = extensions.host.records.find((r) => r.state === "failed");
  if (failed) {
    workbench.notice(`Extension ${failed.manifest.name} didn't start: ${failed.error}`, [
      { label: "Show extensions", run: () => panels.show("extensions") },
      ...(failed.workspace ? [{ label: "Open in safe mode", run: () => reloadWindow(true) }] : []),
    ], "alert");
  }
  if (missing) {
    // An old or edited address: say so, and only offer to make it if it's a note. JSON files are never made by accident.
    workbench.notice(`No file at ${missing}`, isNote(missing) ? [{ label: `Create ${missing.replace(/\.md$/, "")}`, run: () => workbench.open(missing, { newTab: true }) }] : []);
    // Nothing on show opens a note. On a phone, the place is what's on show (the Feed, or what an entry says, still coming).
  } else if (!workbench.focusedPath && !shell?.active) await workbench.open(fallback);
  renderList();
  // Once the windows are up, so what it says shows in one.
  void clearRetired(extensions.host.retired);
} catch (err) {
  saveLine.textContent = `Couldn't load notes: ${(err as Error).message}`;
}
dev?.install({ workbench, extensions, commands, bar, offline, settings: () => settings, device });
