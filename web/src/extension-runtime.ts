// Extensions in the running app: what their manifests declare goes in at once (commands in the
// command bar, keybindings, menus, views, settings sections), and each extension's code starts the
// first time one of its activation events happens. Trusted extensions run in the page with a context
// object; sandboxed ones run in a host frame and call the same services over messages. Either way,
// anything sensitive goes through the permission broker first.
import { statePath, type ExtensionManifest, type MenuId } from "../../worker/src/extensions.ts";
import { parseFilePath, type Change, type FilePath, type FileSummary } from "../../worker/src/files.ts";
import { decide, decidesTrust, globMatches, parseGrants, type Ask } from "../../worker/src/permissions.ts";
import { settingsCatalog, type Keybinding, type Settings, type SettingsCatalog } from "../../worker/src/settings.ts";
import { api, type ExtensionResponse } from "./api.ts";
import { drawSafely, showDrawError } from "./boundary.ts";
import { PermissionBroker } from "./broker.ts";
import { fileWords, plain, type Trigger } from "./permission-words.ts";
import type { CommandBar, Item } from "./commandbar.ts";
import { keyFor, type Commands } from "./commands.ts";
import { docLabel } from "./describe.ts";
import { addMarkdownSyntax } from "./editor.ts";
import { noteOfMedia, revealMedia, stopMedia } from "./lives.ts";
import { currentMedia, mediaSession, onMedia, startMedia, type MediaSession } from "./media.ts";
import type { Embed, EmbedHost } from "./embeds.ts";
import type { EventInput, ExtensionContext, ViewRenderer, WebviewHandle } from "./extension-api.ts";
import { newEventId, type Scope } from "../../worker/src/calendar.ts";
import { ExtensionHost, findWorkspaceExtensions, guarded, type BuiltIn, type ExtensionRecord, type WorkspaceExtension } from "./extension-host.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { formatKeys } from "./keys.ts";
import { notePathFor } from "./links.ts";
import { unreachable, type HeldOp, type Offline } from "./offline.ts";
import type { EditResult } from "../../worker/src/data-sources.ts";
import type { Panels } from "./panels.ts";
import * as L from "./layout.ts";
import { SandboxHost, Webview } from "./sandbox.ts";
import type { StatusItems } from "./status-items.ts";
import type { Workbench, WorkbenchChrome } from "./workbench.ts";

/** What of the app extensions reach, through their contexts. */
export interface RuntimeApp {
  me: string | undefined;
  commands: Commands;
  bar: CommandBar;
  panels: Panels;
  workbench: Workbench;
  offline: Offline;
  settings(): Settings;
  files(): FileSummary[];
  openFromBar(path: FilePath): void;
  /** The file focused last, for views that work on "the note on show" while they have focus. */
  lastFile(): FilePath | null;
  statusItems: StatusItems;
  onSaved: Array<(path: FilePath) => void>;
  onFocus: Array<(path: FilePath | null) => void>;
  /** After any data source's record changes. */
  onRecords: Array<() => void>;
  /** Keep an answer to a permission prompt in your settings. */
  saveGrant(extension: string, key: string, answer: "allow" | "deny"): Promise<void>;
  /** Show a permission prompt. */
  prompt: ConstructorParameters<typeof PermissionBroker>[0]["prompt"];
  /** An extension tried something it never asked for. */
  undeclared: ConstructorParameters<typeof PermissionBroker>[0]["undeclared"];
  /** An extension's state, error or activity changed. */
  changed(): void;
}

type DataApi = Omit<ExtensionContext["data"], "connect" | "calendar"> & { calendar: Omit<ExtensionContext["data"]["calendar"], "onChange"> };

/**
 * Data sources for an extension (ADR 0007), each call checked against its permissions first. A
 * built-in changes records as you; any other extension, as itself acting for you.
 */
function dataApi(check: (ask: Ask) => Promise<void>, author: string | undefined, offline: Offline): DataApi {
  const read = async <T>(kind: "data:calendar:read" | "data:contacts:read", run: () => Promise<T>) => (await check({ kind }), run());
  /** A write, sent now, or kept to send once the server can be reached (offline.ts). */
  const send = async (method: HeldOp["method"], body: Record<string, unknown>, what: string): Promise<EditResult> => {
    await check({ kind: "data:calendar:write" });
    try {
      return await api.editEvent(method, body, author);
    } catch (err) {
      if (!unreachable(err)) throw err;
      await offline.holdOp({ method, body, ...(author ? { extension: author } : {}), what });
      return { status: "queued", address: String(body.address ?? ""), written: [], deleted: [], error: "you're offline, so it goes when you're back" };
    }
  };
  return {
    status: api.sources,
    sync: (force) => read("data:calendar:read", () => api.sync(force)),
    calendar: {
      calendars: () => read("data:calendar:read", api.calendars),
      events: (from, to, calendars) => read("data:calendar:read", () => api.events(from, to, calendars)),
      event: (address) => read("data:calendar:read", () => api.event(address)),
      // The id is made here, so an edit held offline and sent twice makes one event.
      create: (event) => send("POST", { ...event, id: newEventId() }, `Add ${event.title}`),
      update: (address, change, scope) => send("PATCH", { ...change, address, ...(scope ? { scope } : {}) }, `Change ${change.title ?? "an event"}`),
      remove: (address, scope) => send("DELETE", { address, ...(scope ? { scope } : {}) }, "Delete an event"),
    },
    contacts: { search: (query) => read("data:contacts:read", () => api.contacts(query)) },
  };
}

/** Go to Google to connect calendar and contacts, and come back to where you were. */
const connectGoogle = () => location.assign(`/auth/google?data=1&next=${encodeURIComponent(location.pathname + location.search)}`);

/** The services an extension reaches, each checked against its manifest and your answers first. */
interface Services {
  read(path: FilePath): ReturnType<Offline["read"]>;
  write(path: FilePath, text: string, base: number): ReturnType<typeof api.writeAs>;
  /** Files it may read, of all there are. Asks for each declared scope it needs, once. */
  list(): Promise<FileSummary[]>;
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<ExtensionResponse>;
  card(url: string): ReturnType<typeof api.extensionCard>;
  check(ask: Ask): Promise<void>;
}

let webviewIds = 0;

/** Whether a URL embed's pattern matches a URL; a pattern that isn't a regular expression matches nothing. */
const matches = (pattern: string, url: string) => {
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return false;
  }
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`"${url}" isn't a URL`);
  }
};

/** Give a drawn embed new arguments or body in place: false if it can't take them, and it's drawn again. */
type Updater = (embed: Embed) => boolean;

/** What a webview tells its frame: how tall its page is, that it has loaded, and that it first painted. */
interface WebviewHooks {
  onHeight?: (height: number) => void;
  onLoaded?: () => void;
  onPainted?: () => void;
}

/**
 * An embed's box is drawn with `data-pending` on its body until what it shows is ready: its extension
 * has started and drawn it, and a frame has painted. Until then it's a quiet card as tall as it was
 * last time (lives.ts), so nothing flashes and nothing below it moves.
 */
const settle = (el: HTMLElement) => {
  if (!el.querySelector(".cm-embed-frame.is-pending")) delete el.dataset.pending;
};

/** A path a sandboxed extension passed, parsed here at the frame's edge: anything that isn't one is refused before it's checked or used. */
function filePath(value: unknown): FilePath {
  const path = parseFilePath(value);
  if (!path) throw new Error(`${typeof value === "string" ? value : "That"} isn't a file path`);
  return path;
}

/**
 * An event's fields, as a sandboxed extension passed them: each one an event has, of its type. Fields
 * an event doesn't have are left out; one of the wrong type is refused, not guessed at.
 */
function eventInput(value: unknown): EventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An event's fields have to be an object");
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const take = (k: string, ok: (v: unknown) => boolean, what: string) => {
    if (!(k in o) || o[k] === undefined) return;
    if (!ok(o[k])) throw new Error(`An event's ${k} has to be ${what}`);
    out[k] = o[k];
  };
  const text = (v: unknown) => typeof v === "string";
  const textOrNull = (v: unknown) => typeof v === "string" || v === null;
  for (const k of ["title", "start", "end", "calendar"]) take(k, text, "text");
  for (const k of ["timeZone", "location", "description"]) take(k, textOrNull, "text or null");
  take("allDay", (v) => typeof v === "boolean", "true or false");
  take("recurrence", (v) => textOrNull(v) || (Array.isArray(v) && v.every(text)), "a rule, a list of rules, or null");
  return out as EventInput;
}

/** Which occurrences of a series an edit is for, or none (the Worker's default); anything else is refused. */
function scopeOf(value: unknown): Scope | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "this" || value === "following" || value === "all") return value;
  throw new Error('A scope is "this", "following" or "all"');
}

/** An address a sandboxed extension passed, as text: anything else is refused here, at the frame's edge. */
function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("An address has to be text");
  return value;
}

/** The options of a sandboxed extension's fetch: a method, headers and a body, each as text, and nothing else it sent. */
function fetchOptions(value: unknown): { method?: string; headers?: Record<string, string>; body?: string } {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const headers = o.headers && typeof o.headers === "object" && !Array.isArray(o.headers) ? Object.entries(o.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string") : [];
  return {
    ...(typeof o.method === "string" ? { method: o.method } : {}),
    ...(headers.length ? { headers: Object.fromEntries(headers) } : {}),
    ...(typeof o.body === "string" ? { body: o.body } : {}),
  };
}

export class ExtensionRuntime {
  readonly host: ExtensionHost;
  readonly broker: PermissionBroker;
  private handlers = new Map<string, () => unknown>();
  private renderers = new Map<string, ViewRenderer>();
  private describers: Array<(change: Change) => string | null> = [];
  /** How each embed language draws, once its extension has said. */
  private embedDrawers = new Map<string, (el: HTMLElement, embed: Embed, tools: HTMLElement) => Updater | null>();
  /** How to give each drawn embed new arguments or body in place, for the ones whose extension can take them. */
  private updaters = new WeakMap<HTMLElement, Updater>();
  /** How each URL embed draws, by its id. */
  private urlDrawers = new Map<string, (el: HTMLElement, link: { url: string; match: string[] }) => void>();
  private sandboxes = new Map<string, SandboxHost>();

  constructor(private app: RuntimeApp) {
    this.broker = new PermissionBroker({
      grants: () => parseGrants(app.settings()["extensions.permissions"]),
      isBuiltIn: (id) => !!this.host.records.find((r) => r.id === id && r.builtIn && !r.workspace),
      save: (id, key, answer) => app.saveGrant(id, key, answer),
      prompt: app.prompt,
      undeclared: app.undeclared,
      changed: () => app.changed(),
    });
    this.host = new ExtensionHost({
      context: (record, failed) => this.context(record, failed),
      // From the Worker, so `script-src 'self'` allows it; the version makes each change a new address.
      load: (w: WorkspaceExtension, main: string) => import(/* @vite-ignore */ `/extensions/${w.id}/${main}?v=${encodeURIComponent(w.version)}`),
      sandbox: (record, failed) => this.startSandbox(record, failed),
      changed: () => app.changed(),
    });
  }

  /** Read every extension's manifest. */
  load(builtIns: readonly BuiltIn[], files: readonly FileSummary[], disabled: readonly string[], safe: boolean, trusted: readonly string[]): Promise<void> {
    return this.host.load(builtIns, files, (path) => this.app.offline.read(path), disabled, safe, trusted);
  }

  /** Every setting, the app's and installed extensions', on or off: they're all listed, so you can set one before turning it on. */
  catalog(): SettingsCatalog {
    return settingsCatalog(this.host.installed());
  }

  /** Keybindings extensions that are on declare, before the user's and the workspace's. */
  keybindings(): Keybinding[] {
    return this.host.on().flatMap((m) => m.contributes.keybindings.flatMap((k) => ("key" in k ? [{ key: k.key, command: k.command }] : [])));
  }

  /** Commands extensions add to a menu, with their titles. */
  menu(id: MenuId): Array<{ command: string; title: string }> {
    return this.host.on().flatMap((m) => (m.contributes.menus[id] ?? []).map((item) => ({ command: item.command, title: m.contributes.commands.find((c) => c.command === item.command)?.title ?? item.command })));
  }

  /** Every keybinding in effect, with the Vim sequences extensions declare. */
  allKeybindings(): Array<{ command: string; key?: string; vim?: string; operator?: true }> {
    const keys = this.app.settings().keybindings.flatMap((k) => (k.command ? [{ command: k.command, key: k.key }] : []));
    const vim = this.host.on().flatMap((m) => m.contributes.keybindings.flatMap((k) => ("vim" in k ? [{ command: k.command, vim: k.vim, ...(k.operator ? { operator: true as const } : {}) }] : [])));
    return [...keys, ...vim];
  }

  /** Put in what the manifests of extensions that are on declare: commands, status bar items and views. No extension code runs. */
  declare(): void {
    for (const m of this.host.on()) this.declareOne(m);
  }

  /**
   * An extension installed or turned on while the app runs, put in at once when nothing about it needs a
   * reload: a sandboxed extension, whose contributions are all declared and whose code runs in its own
   * frame. (A trusted one changes the page and its editors, so it waits for a reload.) Returns whether it
   * did. `because` is what you did, for its asks as it starts.
   */
  async addLive(files: readonly FileSummary[], id: string, trusted: readonly string[], because: Trigger): Promise<boolean> {
    if (trusted.includes(id)) return false;
    const w = findWorkspaceExtensions(files).find((x) => x.id === id);
    const record = w && (await this.host.add(w, (path) => this.app.offline.read(path)));
    if (!record) return false;
    this.declareOne(record.manifest);
    this.broker.cause(id, because);
    if (record.manifest.activationEvents.includes("onStartup")) await this.host.activate(record);
    return true;
  }

  private declareOne(m: ExtensionManifest): void {
    this.app.statusItems.declare(m.contributes.statusBarItems.map((item) => ({ ...item, owner: m.id })));
    for (const c of m.contributes.commands)
      this.app.commands.register({
        id: c.command,
        title: c.title,
        run: () => {
          this.broker.cause(m.id, { kind: "command", title: c.title });
          // Started already, its answer comes back at once: false declines a key (commands.runForKey).
          const handler = this.handlers.get(c.command);
          return handler ? handler() : this.runCommand(c.command);
        },
      });
    for (const view of Object.values(m.contributes.views).flat()) {
      const declared = {
        id: view.id,
        title: view.name,
        render: async (el: HTMLElement) => {
          this.broker.cause(m.id, { kind: "view", name: view.name });
          await this.activateFor(`onView:${view.id}`, (x) => Object.values(x.contributes.views).flat().some((v) => v.id === view.id));
          const renderer = this.renderers.get(view.id);
          if (renderer) await renderer.render(el);
          else el.textContent = `${m.name} didn't draw this view. Is it turned off, or did it fail to start? See the Extensions view.`;
        },
      };
      // A view shows in the side panel, and also opens in a window: drag its title there, or use its command.
      this.app.panels.register(declared);
      this.app.workbench.registerView(declared);
      this.app.commands.register({ id: `${view.id}.openInWindow`, title: `Open ${view.name} in a window`, run: () => this.app.workbench.openView(view.id, { newTab: true }) });
    }
  }

  /** Start the extensions that start with the app. */
  start(): Promise<void> {
    for (const m of this.host.on()) if (m.activationEvents.includes("onStartup")) this.broker.cause(m.id, { kind: "startup" });
    return this.host.fire("onStartup");
  }

  /** What history's describers say about a change, or null. */
  summary(change: Change): string | null {
    return this.describers.map((d) => d(change)).find((s) => s) ?? null;
  }

  /** Tell sandboxed extensions something happened. */
  broadcast(name: "saved" | "focus" | "records", arg: FilePath | null): void {
    for (const host of this.sandboxes.values()) host.event(name, arg);
  }

  /** You did something any extension may act on (switched to a note): their asks just after say so. */
  youDid(trigger: Trigger): void {
    for (const m of this.host.on()) this.broker.cause(m.id, trigger);
  }

  /** Settings changed: sandboxed extensions get their own section's new values. */
  settingsChanged(): void {
    for (const [id, host] of this.sandboxes) host.event("settings", this.ownSettings(id));
  }

  private ownSettings(id: string): Record<string, unknown> {
    const settings = this.app.settings();
    return Object.fromEntries(Object.keys(settings).filter((k) => k.startsWith(`${id}.`)).map((k) => [k, settings[k]]));
  }

  /** What draws embeds in notes: the embeds extensions that are on declare, drawing each by its extension, and giving it new arguments; and links alone on their lines. */
  readonly embedHost: Omit<EmbedHost, "needs"> = {
    contributions: () => new Map(this.host.on().flatMap((m) => m.contributes.embeds.map((e) => [e.language, e] as const))),
    draw: (el, embed, tools) => drawSafely(el, `The ${embed.language} embed`, () => this.drawEmbed(el, embed, tools).finally(() => settle(el))),
    update: (el, embed) => this.updaters.get(el)?.(embed) ?? false,
    // The first pattern that matches, in the order extensions are listed and contribute them.
    urlEmbed: (url) => this.host.on().flatMap((m) => m.contributes.urlEmbeds).find((e) => matches(e.pattern, url))?.id ?? null,
    drawUrl: (el, url, id) => drawSafely(el, "The link embed", () => this.drawUrl(el, url, id).finally(() => settle(el))),
    prepare: (languages) => {
      // A note's embeds start their extensions as it opens, alongside the editor's first render.
      for (const language of new Set(languages)) void this.activateFor(`onEmbed:${language}`, (m) => m.contributes.embeds.some((e) => e.language === language)).catch(() => {});
    },
  };

  private async drawUrl(el: HTMLElement, url: string, id: string): Promise<void> {
    const declares = (m: ExtensionManifest) => m.contributes.urlEmbeds.some((e) => e.id === id);
    await this.activateFor(`onUrlEmbed:${id}`, declares);
    const contribution = this.host.on().flatMap((m) => m.contributes.urlEmbeds).find((e) => e.id === id);
    const draw = this.urlDrawers.get(id);
    if (draw && contribution) return draw(el, { url, match: [...(new RegExp(contribution.pattern).exec(url) ?? [])] });
    // Its extension didn't draw it: the link, as a link.
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    a.className = "cm-md-link";
    a.dataset.href = url;
    el.replaceChildren(a);
  }

  private async drawEmbed(el: HTMLElement, embed: Embed, tools: HTMLElement): Promise<void> {
    const declares = (m: ExtensionManifest) => m.contributes.embeds.some((e) => e.language === embed.language);
    const drawer = this.host.on().find(declares);
    if (drawer) this.broker.cause(drawer.id, { kind: "embed", title: drawer.contributes.embeds.find((e) => e.language === embed.language)!.title, note: embed.note });
    await this.activateFor(`onEmbed:${embed.language}`, declares);
    const draw = this.embedDrawers.get(embed.language);
    if (draw) {
      const updater = draw(el, embed, tools);
      if (updater) this.updaters.set(el, updater);
      return;
    }
    const owner = this.host.on().find(declares);
    el.classList.add("cm-embed-missing");
    el.textContent = `${owner?.name ?? "An extension"} didn't draw this ${embed.language} embed. Did it fail to start? See the Extensions view.`;
  }

  /**
   * Code an extension runs in an embed: a webview in a quiet frame, with Stop in the embed's toolbar.
   * Stopping removes the frame, and with it everything running in it; Run starts it again. New
   * arguments or body go to the running webview when its extension can take them (`start` returns how),
   * so the frame isn't reloaded; a new `height` resizes the frame.
   */
  private framed(el: HTMLElement, m: ExtensionManifest, first: Embed, tools: HTMLElement, start: (box: HTMLElement, hooks: WebviewHooks, embed: Embed) => Updater | null): Updater {
    const declared = m.contributes.embeds.find((e) => e.language === first.language);
    const title = declared?.title ?? first.language;
    let embed = first;
    let box: HTMLElement | null = null;
    let update: Updater | null = null;
    // A height in its arguments (or their default), or else the height of what it shows.
    const fixed = () => Number(embed.args.height ?? declared?.arguments.height?.default);
    const clamp = (h: number) => `${Math.min(Math.max(h, 40), 2000)}px`;
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "cm-embed-stop";
    stop.textContent = "Stop";
    stop.title = `Stop ${title}: what it's running stops`;
    stop.addEventListener("mousedown", (e) => e.preventDefault());
    stop.addEventListener("click", () => {
      [box, update, stop.hidden] = [null, null, true];
      const stopped = document.createElement("div");
      stopped.className = "cm-embed-stopped";
      const again = document.createElement("button");
      again.textContent = "Run";
      again.addEventListener("click", run);
      stopped.append(`${title} is stopped.`, again);
      el.replaceChildren(stopped);
    });
    tools.prepend(stop);
    const run = () => {
      const frame = document.createElement("div");
      // Invisible until its page has painted, then shown with a short fade: never a blank frame.
      frame.className = "cm-embed-frame is-pending";
      const inner = document.createElement("div");
      inner.style.height = clamp(fixed() || 80);
      const painted = () => {
        if (!frame.classList.contains("is-pending")) return;
        frame.classList.remove("is-pending");
        settle(el);
      };
      window.setTimeout(painted, 5000);
      frame.append(inner);
      el.replaceChildren(frame);
      [box, stop.hidden] = [inner, false];
      update = start(inner, { onHeight: (h) => !fixed() && (inner.style.height = clamp(h)), onPainted: painted }, embed);
    };
    run();
    return (next) => {
      // Stopped, it runs with the newest arguments when you press Run.
      if (!box) {
        embed = next;
        return true;
      }
      if (!update || !update(next)) return false;
      embed = next;
      if (fixed()) box.style.height = clamp(fixed());
      return true;
    };
  }

  /** An extension's state, from its state.json: null if it has none. */
  private async readState(m: ExtensionManifest): Promise<unknown> {
    const file = await this.app.offline.read(statePath(m.id));
    try {
      return file.text ? JSON.parse(file.text) : null;
    } catch {
      return null;
    }
  }

  /** Keep an extension's state, as a change by it in history. Its own state file needs no permission. */
  private async writeState(m: ExtensionManifest, value: unknown): Promise<void> {
    const path = statePath(m.id);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    for (let tries = 0; tries < 3; tries++) {
      const current = await this.app.offline.read(path);
      if (current.text === text) return;
      const result = await api.writeAs(m.id, path, text, current.revision);
      if (result.status !== "conflict") return;
    }
    throw new Error(`${m.name}'s state kept changing under it; try again`);
  }

  private async activateFor(event: `onView:${string}` | `onCommand:${string}` | `onEmbed:${string}` | `onUrlEmbed:${string}`, declares: (m: ExtensionManifest) => boolean): Promise<void> {
    await this.host.fire(event);
    // Declaring it is enough to start it, whatever activation events it lists.
    const owner = this.host.owner(declares);
    if (owner && owner.state === "inactive") await this.host.activate(owner);
  }

  private async runCommand(id: string): Promise<unknown> {
    if (!this.handlers.has(id)) await this.activateFor(`onCommand:${id}`, (m) => m.contributes.commands.some((c) => c.command === id));
    const run = this.handlers.get(id);
    if (!run) this.app.workbench.notice(`The command "${id}" isn't available: its extension is off, or didn't start.`);
    return run?.();
  }

  /** What an extension reaches, each through the broker. Trusted built-ins have their declared permissions already. */
  private services(m: ExtensionManifest): Services {
    const app = this.app;
    const check = (ask: Ask) => this.broker.check(m, ask);
    return {
      check,
      read: async (path) => {
        await check({ kind: "files:read", target: path });
        return app.offline.read(path);
      },
      write: async (path, text, base) => {
        await check({ kind: "files:write", target: path });
        // In history, the change is the extension's, acting for you.
        return api.writeAs(m.id, path, text, base);
      },
      list: async () => {
        // Each declared scope is asked about as a whole, all at once, so they're one prompt; files in the ones allowed are listed.
        const scopes = m.permissions["files:read"]?.paths ?? [];
        const answers = await Promise.allSettled(scopes.map((scope) => check({ kind: "files:read", scope })));
        const allowed = scopes.filter((_, i) => answers[i].status === "fulfilled");
        return app.files().filter((f) => allowed.some((glob) => globMatches(glob, f.path)));
      },
      fetch: async (url, init) => {
        const host = hostOf(url);
        await check({ kind: "network", target: host });
        return this.broker.inFlightWhile(m.id, url, () => api.extensionFetch(m.id, url, init, this.broker.allowedOnce(m, { kind: "network", target: host })));
      },
      card: async (url) => {
        const host = hostOf(url);
        await check({ kind: "network", target: host });
        return this.broker.inFlightWhile(m.id, url, () => api.extensionCard(m.id, url, this.broker.allowedOnce(m, { kind: "network", target: host })));
      },
    };
  }

  /** A system notification, once the extension may show one and the browser lets the app. */
  private async notify(services: Services, title: string, body = ""): Promise<void> {
    await services.check({ kind: "notifications" });
    if ("Notification" in window && (Notification.permission === "granted" || (await Notification.requestPermission()) === "granted")) new Notification(title, { body });
  }

  private async split(direction: "left" | "right" | "up" | "down", path?: FilePath): Promise<void> {
    if (!["left", "right", "up", "down"].includes(direction)) throw new Error(`"${direction}" isn't a direction to split in`);
    if (path) await this.app.workbench.load(path);
    this.app.workbench.split(direction, path);
  }

  private tabs(): { active: number; count: number } {
    const g = L.focused(this.app.workbench.layout);
    return { active: g.active, count: g.tabs.length };
  }

  /** A webview in `el` for one of an extension's views. Messages from its page go to `onMessage`. */
  private webview(m: ExtensionManifest, viewId: string, el: HTMLElement, onMessage: (message: unknown) => void, hooks: WebviewHooks = {}): Webview {
    el.replaceChildren();
    const view = new Webview(el, `${viewId}:${++webviewIds}`, `${m.name}: ${viewId}`, onMessage, hooks.onHeight, hooks.onLoaded, hooks.onPainted);
    view.frame.dataset.view = viewId;
    return view;
  }

  /** A trusted extension's handle on a webview: its HTML, and messages both ways. */
  private webviewHandle(m: ExtensionManifest, viewId: string, el: HTMLElement, hooks: WebviewHooks = {}): WebviewHandle {
    const listeners: Array<(message: unknown) => void> = [];
    const view = this.webview(m, viewId, el, (message) => listeners.forEach((fn) => fn(message)), hooks);
    let html = "";
    return {
      get html() {
        return html;
      },
      set html(value: string) {
        html = value;
        void view.setHtml(value);
      },
      post: (message) => view.post(message),
      onMessage: (fn) => void listeners.push(fn),
    };
  }

  /** The context a trusted extension's code gets in the page: everything it registers is checked against its manifest, and what it throws is reported. */
  private context(record: ExtensionRecord, failed: (err: unknown) => void): ExtensionContext {
    const m = record.manifest;
    const app = this.app;
    const services = this.services(m);
    const guard = <A extends unknown[], R>(fn: (...args: A) => R, fallback?: R) => guarded(fn, failed, fallback);
    const declaresView = (id: string) => Object.values(m.contributes.views).flat().some((v) => v.id === id);
    const needsEditor = () => {
      if (!m.permissions.editor) throw new Error(`${m.id} needs the "editor" permission in its extension.json to change note editors`);
    };
    const asked = new Set<string>();
    return {
      extension: m,
      me: app.me,
      settings: { get: <T>(key: string) => app.settings()[key] as T },
      commands: {
        register: (id, run) => {
          if (!m.contributes.commands.some((c) => c.command === id)) throw new Error(`Command "${id}" isn't declared in ${m.id}'s contributes.commands`);
          this.handlers.set(id, guard(run));
        },
        run: (id) => app.commands.run(id),
        all: () => app.commands.all().map((c) => ({ id: c.id, title: c.title })),
        shortcut: (id) => {
          const key = keyFor(id, app.settings().keybindings);
          return key && formatKeys(key);
        },
        keybindings: () => this.allKeybindings(),
        menu: (id) => this.menu(id),
      },
      layout: {
        get: () => app.workbench.layout,
        change: (fn) => app.workbench.change(fn),
        close: (group, index) => app.workbench.closeTab(group, index),
        closeTabs: (which) => app.workbench.closeTabs(which),
        isSaved: (tab) => app.workbench.isSaved(tab),
        title: (tab) => app.workbench.title(tab),
        chrome: (chrome) => {
          needsEditor();
          // Chrome that throws is dropped, for the plain windows, and the extension is marked failed.
          const safe = <K extends keyof WorkbenchChrome>(k: K) => {
            const part = chrome[k] as ((...args: unknown[]) => unknown) | undefined;
            if (!part) return undefined;
            return ((...args: unknown[]) => {
              try {
                return part(...args);
              } catch (err) {
                failed(err);
                queueMicrotask(() => app.workbench.setChrome(null));
                return undefined;
              }
            }) as WorkbenchChrome[K];
          };
          app.workbench.setChrome({ window: safe("window"), tabs: safe("tabs"), divider: safe("divider"), empty: safe("empty") });
        },
      },
      statusBar: { set: (id, text, tooltip) => app.statusItems.set(m.id, id, text, tooltip) },
      commandBar: {
        provide: (p) => app.bar.provide({ ...p, items: guard((q: string) => p.items(q), []) }),
        open: (text) => app.bar.open(text),
      },
      views: {
        register: (id, renderer) => {
          if (!declaresView(id)) throw new Error(`View "${id}" isn't declared in ${m.id}'s contributes.views`);
          const draw = "resolve" in renderer ? (el: HTMLElement) => renderer.resolve(this.webviewHandle(m, id, el)) : (el: HTMLElement) => renderer.render(el);
          this.renderers.set(id, { render: (el: HTMLElement) => drawSafely(el, `${m.name}'s view`, () => draw(el), failed) });
        },
        provide: (prefix, make) =>
          app.workbench.provideViews(prefix, (id) => {
            const view = guard(make, null)(id);
            return view && { id, title: view.title, render: (el: HTMLElement) => drawSafely(el, `${m.name}'s view`, () => view.render(el), failed) };
          }),
        toggle: (id) => app.panels.toggle(id),
        show: (id) => app.panels.show(id),
        shown: () => app.panels.shown(),
        refresh: (id) => {
          app.panels.refresh(id);
          app.workbench.refreshView(id);
        },
        open: (id, how) => app.workbench.openView(id, how),
      },
      embeds: {
        register: (language, provider) => {
          if (!m.contributes.embeds.some((e) => e.language === language)) throw new Error(`Embed "${language}" isn't declared in ${m.id}'s contributes.embeds`);
          this.embedDrawers.set(
            language,
            "resolve" in provider
              ? (el, embed, tools) =>
                  this.framed(el, m, embed, tools, (box, hooks, first) => {
                    const handle = this.webviewHandle(m, `embed:${language}`, box, hooks);
                    drawSafely(box, `${m.name}'s ${language} embed`, () => provider.resolve(handle, first), failed);
                    return provider.update ? (next) => (guard(() => provider.update!(handle, next))(), true) : null;
                  })
              : (el, embed) => {
                  drawSafely(el, `${m.name}'s ${language} embed`, () => provider.render(el, embed), failed);
                  return provider.update ? (next) => (guard(() => provider.update!(el, next))(), true) : null;
                },
          );
        },
      },
      media: (() => {
        // Every part of it needs the media permission, as the manifest says.
        const may = () => {
          if (!m.permissions.media) throw new Error(`${m.id} needs the "media" permission in its extension.json to play or control media`);
        };
        const of = (id: number) => (may(), mediaSession(id));
        return {
          session: (spec) => {
            may();
            return startMedia({ ...spec, play: guard(() => spec.play()), pause: guard(() => spec.pause()), stop: spec.stop && guard(() => spec.stop!()) });
          },
          current: () => {
            may();
            const s = currentMedia();
            return s && mediaInfo(s);
          },
          onChange: (fn) => (may(), void onMedia(guard(fn))),
          play: (id) => of(id)?.play(),
          pause: (id) => of(id)?.pause(),
          stop: (id) => {
            const s = of(id);
            if (s) stopMedia(s);
          },
          reveal: (id) => {
            const s = of(id);
            if (s?.el) revealMedia(s);
            else if (s?.note) void app.workbench.open(s.note);
          },
        };
      })(),
      urlEmbeds: {
        register: (id, provider) => {
          if (!m.contributes.urlEmbeds.some((e) => e.id === id)) throw new Error(`URL embed "${id}" isn't declared in ${m.id}'s contributes.urlEmbeds`);
          needsEditor();
          this.urlDrawers.set(id, (el: HTMLElement, link: { url: string; match: string[] }) => drawSafely(el, `${m.name}'s link embed`, () => provider.render(el, link), failed));
        },
      },
      state: {
        get: () => this.readState(m),
        set: (value) => this.writeState(m, value),
      },
      changes: {
        describe: (d) => void this.describers.push(guard(d, null)),
        summary: (change) => this.summary(change),
      },
      editor: {
        extend: (extension, where) => {
          needsEditor();
          app.workbench.extend(extension, where?.everywhere);
        },
        markdown: (extension) => {
          needsEditor();
          addMarkdownSyntax(extension);
          // Notes already open are parsed again with it.
          app.workbench.applySettings(app.settings());
        },
        focused: () => {
          needsEditor();
          return app.workbench.focusedView;
        },
      },
      files: {
        // In the page, a list has to be there at once: files it may read without asking you, and asks for the rest once.
        list: () =>
          app.files().filter((f) => {
            const d = decide(m, { kind: "files:read", target: f.path }, parseGrants(app.settings()["extensions.permissions"]), { builtIn: !!record.builtIn && !record.workspace });
            if (d.outcome === "ask" && !asked.has(d.key)) {
              asked.add(d.key);
              void services.check({ kind: "files:read", target: f.path }).catch(() => {});
            }
            return d.outcome === "allow";
          }),
        fetchList: async () => app.offline.list(),
        read: services.read,
        write: (path, text, base) => (record.builtIn && !record.workspace ? app.offline.write(path, text, base) : services.write(path, text, base)),
        upload: async (name, data) => {
          await services.check({ kind: "files:write", target: ".common-ink/uploads.json" });
          return api.upload(name, data);
        },
      },
      net: { fetch: services.fetch, card: services.card },
      clipboard: {
        read: async () => {
          await services.check({ kind: "clipboard:read" });
          return navigator.clipboard.readText();
        },
        write: (text) => {
          // A browser lets a page write the clipboard only while it handles a click or a key. Allowed
          // already, it's written now, before anything waits; otherwise you're asked first.
          if (this.broker.granted(m, { kind: "clipboard:write" })) return navigator.clipboard.writeText(text);
          return services.check({ kind: "clipboard:write" }).then(() => navigator.clipboard.writeText(text));
        },
      },
      notifications: { show: (title, body) => this.notify(services, title, body) },
      data: (() => {
        const data = dataApi(services.check, record.builtIn && !record.workspace ? undefined : m.id, app.offline);
        return { ...data, connect: connectGoogle, calendar: { ...data.calendar, onChange: (fn: () => void) => void app.onRecords.push(guard(fn)) } };
      })(),
      workbench: {
        open: (path, how) => app.workbench.open(path, how),
        openPicked: (path) => app.openFromBar(path),
        // With a view focused (History in a window, say), the file is the one focused last.
        focusedPath: () => app.workbench.focusedPath ?? app.lastFile(),
        hasUnsavedChanges: () => !!app.workbench.focusedSession?.dirty,
        split: (direction, path) => this.split(direction, path),
        tabs: () => this.tabs(),
        moveTab: (by) => app.workbench.change((l) => L.shiftTab(l, by)),
        refreshFromServer: (paths) => app.workbench.refreshFromServer(paths),
        notice: (message, actions) => app.workbench.notice(message, actions),
        canGo: (by) => !!app.workbench.navigation.step(by),
      },
      util: { fuzzyFilter, notePathFor: (name) => notePathFor(name), label: docLabel },
      extensions: {
        api: async <T,>(id: string) => (await this.host.api(id)) as T | undefined,
      },
      events: {
        onSaved: (fn) => void app.onSaved.push(guard(fn)),
        onFocus: (fn) => void app.onFocus.push(guard(fn)),
      },
    };
  }

  /** Start a sandboxed extension: its host frame, its code by token, and the services it calls, each checked. */
  private async startSandbox(record: ExtensionRecord, failed: (err: unknown) => void): Promise<void> {
    const m = record.manifest;
    const app = this.app;
    const services = this.services(m);
    const data = dataApi(services.check, record.builtIn && !record.workspace ? undefined : m.id, app.offline);
    const webviews = new Map<string, Webview>();
    const providers = new Map<string, string>();
    const declaresView = (id: string) => Object.values(m.contributes.views).flat().some((v) => v.id === id);
    const host: SandboxHost = new SandboxHost(
      m,
      async (method, args) => {
        const [a, b, c] = args as [string, unknown, unknown];
        switch (method) {
          case "commands.register":
            if (!m.contributes.commands.some((x) => x.command === a)) throw new Error(`Command "${a}" isn't declared in ${m.id}'s contributes.commands`);
            this.handlers.set(a, () => host.invoke(`command:${a}`).catch(failed));
            return;
          case "commands.run":
            return app.commands.run(a);
          case "commands.all":
            return app.commands.all().map((x) => ({ id: x.id, title: x.title }));
          case "commands.shortcut": {
            const key = keyFor(a, app.settings().keybindings);
            return key && formatKeys(key);
          }
          case "commands.keybindings":
            return this.allKeybindings();
          case "statusBar.set":
            return app.statusItems.set(m.id, a, String(b ?? ""), typeof c === "string" ? c : undefined);
          case "commandBar.provide":
            providers.set(a, String(b));
            app.bar.provide({
              prefix: String(b),
              placeholder: String(c),
              items: async (query) => {
                const items = (await host.invoke(`provider:${a}`, query).catch(() => [])) as Array<{ label: string; detail?: string; run: string }>;
                return items.map((i): Item => ({ label: i.label, detail: i.detail, run: () => host.invoke(`item:${i.run}`).catch(failed) }));
              },
            });
            return;
          case "commandBar.open":
            return app.bar.open(a);
          case "views.register":
            if (!declaresView(a)) throw new Error(`View "${a}" isn't declared in ${m.id}'s contributes.views`);
            this.renderers.set(a, {
              render: (el) => {
                // A webview keeps running between redraws; only a missing one is made again.
                if (el.querySelector(`iframe.webview[data-view="${CSS.escape(a)}"]`)) return;
                const view = this.webview(m, a, el, (message) => host.event("webview.message", view.id, message));
                webviews.set(view.id, view);
                void host.invoke(`view:${a}`, view.id).catch((err) => (failed(err), showDrawError(el, `${m.name}'s view`, err)));
              },
            });
            return;
          case "embeds.register": {
            if (!m.contributes.embeds.some((e) => e.language === a)) throw new Error(`Embed "${a}" isn't declared in ${m.id}'s contributes.embeds`);
            // Whether its provider takes new arguments in place: said as it registers, since a change can't wait on the frame to answer.
            const updates = b === true;
            this.embedDrawers.set(a, (el, embed, tools) =>
              this.framed(el, m, embed, tools, (box, hooks, first) => {
                const view = this.webview(m, `embed:${a}`, box, (message) => host.event("webview.message", view.id, message), hooks);
                webviews.set(view.id, view);
                void host.invoke(`embed:${a}`, view.id, first).catch((err) => (failed(err), showDrawError(box, `${m.name}'s ${a} embed`, err)));
                return updates ? (next) => (void host.invoke(`embedUpdate:${a}`, view.id, next).catch(failed), true) : null;
              }),
            );
            return;
          }
          case "state.get":
            return this.readState(m);
          case "state.set":
            return this.writeState(m, args[0]);
          case "views.show":
            return app.panels.show(a);
          case "views.toggle":
            return app.panels.toggle(a);
          case "views.refresh":
            app.panels.refresh(a);
            return app.workbench.refreshView(a);
          case "views.open":
            return app.workbench.openView(a, b as { newTab?: boolean });
          case "webview.html":
            return webviews.get(a)?.setHtml(String(b));
          case "webview.post":
            return webviews.get(a)?.post(b);
          case "files.list":
            return services.list();
          case "files.read":
            return services.read(filePath(a));
          case "files.write": {
            const path = filePath(a);
            if (decidesTrust(path)) {
              this.broker.record(m.id, { kind: "files:write", target: path }, "denied");
              throw new Error(`${m.name} can't change ${plain(fileWords(path))}: it runs sandboxed, and that decides what extensions may do`);
            }
            return services.write(path, String(b), Number(c));
          }
          case "net.fetch":
            return services.fetch(address(a), fetchOptions(b));
          case "net.card":
            return services.card(address(a));
          case "clipboard.read":
            await services.check({ kind: "clipboard:read" });
            return navigator.clipboard.readText();
          case "clipboard.write":
            await services.check({ kind: "clipboard:write" });
            return navigator.clipboard.writeText(a);
          case "notifications.show":
            return this.notify(services, a, String(b ?? ""));
          case "data.status":
            return data.status();
          case "data.sync":
            return data.sync(a === "force");
          case "data.calendars":
            return data.calendar.calendars();
          case "data.events":
            return data.calendar.events(new Date(a), new Date(String(b)), (c ?? undefined) as string[] | undefined);
          case "data.event":
            return data.calendar.event(a);
          case "data.create":
            return data.calendar.create(eventInput(b) as Parameters<DataApi["calendar"]["create"]>[0]);
          case "data.update":
            return data.calendar.update(address(a), eventInput(b), scopeOf(c));
          case "data.remove":
            return data.calendar.remove(address(a), scopeOf(b));
          case "data.contacts":
            return data.contacts.search(a);
          case "workbench.open":
            return app.workbench.open(a as FilePath, b as { newTab?: boolean });
          case "workbench.focusedPath":
            return app.workbench.focusedPath ?? app.lastFile();
          case "workbench.hasUnsavedChanges":
            return !!app.workbench.focusedSession?.dirty;
          case "workbench.split":
            return this.split(a as "left" | "right" | "up" | "down", (b ?? undefined) as FilePath | undefined);
          case "workbench.tabs":
            return this.tabs();
          case "workbench.moveTab":
            return app.workbench.change((l) => L.shiftTab(l, Number(a)));
          case "workbench.notice":
            return app.workbench.notice(`${m.name}: ${a}`);
        }
        throw new Error(`There's no ${method} for extensions`);
      },
      (message) => failed(new Error(message)),
    );
    this.sandboxes.set(m.id, host);
    const code = record.builtIn && !record.workspace ? `${location.origin}/sandbox/builtin/${m.id}/${m.main}` : `${location.origin}/sandbox/code/${await api.sandboxToken(m.id)}/${m.main}`;
    await host.start(code, this.ownSettings(m.id), app.me);
  }
}

/** A session as extensions see it. */
const mediaInfo = (s: MediaSession) => ({ id: s.id, title: s.title, kind: s.kind, playing: s.playing, note: noteOfMedia(s) ?? s.note ?? null });
