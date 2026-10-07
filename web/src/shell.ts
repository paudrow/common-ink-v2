// The phone shell, for widths under 840px (compact and medium): a top bar with back, what's on show,
// views about the note (◷) and its menu (⋯); a bottom bar of three places, Search and Places; the
// Places sheet; and, while you edit by touch, the keyboard toolbar above the on-screen keyboard. One
// screen at a time: a place (the notes list, or a view) or a note over it. Back goes up to the place,
// and the system's back gesture goes back through the browser's history, which holds each place shown.
// Sheets are modals (modal.ts), so focus, Escape and the scrim work as everywhere else.
import { icon, isIcon, type IconName } from "./icons.ts";
import { openModal, type Modal } from "./modal.ts";
import { shownOnBar } from "../../worker/src/places.ts";
import type { Device } from "./device.ts";

/** Somewhere to go: listed in the Places sheet, and maybe on the bottom bar. */
export interface Place {
  id: string;
  title: string;
  icon: IconName;
  /** What it shows: the notes list, a view in the window, or wherever a command goes (Daily notes' Today). */
  open: { list: true } | { view: string } | { command: string };
  /** Listed at the bottom of Places, with Extensions and Settings. */
  end?: boolean;
  /** The extension that adds it: said beside it, so no extension's place passes for the app's own. */
  from?: string;
  /** Added by a sandboxed extension: its command runs for it, not for the app (commands.ts, appOnly). */
  by?: "sandbox";
}

/** A command as a button or a menu item, with why it's off on this device if it is. */
export interface Action {
  command: string;
  title: string;
  icon?: string;
  label?: string;
  off?: string | null;
  /** Added by a sandboxed extension: its command runs for it, not for the app. */
  by?: "sandbox";
}

export interface ShellDeps {
  device: Device;
  /** Every place, in order. */
  places(): Place[];
  /** The bottom bar's place ids, as places.json says. */
  bar(): string[];
  setBar(ids: string[]): Promise<void>;
  /** Show a view in the focused window; run a command, done when what it does is. */
  openView(id: string): void;
  /**
   * Show exactly what a history entry says is on show, a tab's key ("view:…" or "file:…"): its view, or
   * its note (at the place in Navigation's history `nav` names, if that's still kept). Done once it's on show.
   */
  restore(show: string, nav: number | undefined): Promise<unknown>;
  run(command: string, by?: "sandbox"): unknown;
  /** Navigation's own place in its history (navigation.ts), for the entry of a note on show. */
  visitId(): number | null;
  notice(message: string): void;
  /** What's on show in the window: which tab (its key, as layout.ts writes it), its title, and whether it's a note. */
  showing(): { key: string; title: string; note: boolean } | null;
  /** Views about the note in focus (contributes.views.context), and how to draw one into a sheet. */
  contextViews(): Array<{ id: string; title: string }>;
  drawView(id: string, el: HTMLElement): void;
  /** The note's ⋯ menu, and the keyboard toolbar's buttons. */
  menu(): Action[];
  toolbar(): Action[];
  /** What this device's layout keeps that doesn't show here. */
  kept(): { windows: number; tabs: number };
  search(): void;
  newNote(): void;
  /** The browser's history: a new entry, the one you're on in its place, or back `n` entries. */
  push(state: ShellEntry): void;
  replace(state: ShellEntry): void;
  back(n: number): void;
}

/**
 * What a browser history entry shows on a phone: the place it's in, what's on show (`show`: "list", or a
 * tab's key, as layout.ts writes it), whether that's the place's own screen (`own`: the Feed's list, or a
 * view place's view), and how many entries it is above the place's first (0 is the first: the place's own
 * screen, or the note a command's place went to).
 */
export interface ShellEntry {
  place: string;
  show: string;
  above: number;
  own?: true;
  nav?: number;
}

/** A history entry's state, if it's one the shell made. */
export function entryOf(state: unknown): ShellEntry | null {
  const e = state as Partial<ShellEntry> | null;
  return e && typeof e.place === "string" && typeof e.show === "string" && typeof e.above === "number" ? (e as ShellEntry) : null;
}

type Child = Node | string | null | false | "";

/** The children that are there: leaving one out is writing null, false or "" in its place. */
const present = (...children: Child[]) => children.filter(Boolean) as Array<Node | string>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  node.append(...present(...children));
  return node;
}

/** A button with an icon and a label for screen readers (and, `shown`, beside the icon). */
function iconButton(name: IconName, label: string, run: () => void, shown = false): HTMLButtonElement {
  const b = el("button", { type: "button", className: "shell-icon", ariaLabel: label, title: label }, icon(name, "1em"), shown ? el("span", { textContent: label }) : null);
  b.addEventListener("click", run);
  return b;
}

/** A place's name, and under it the extension that adds it, if one does. */
function placeName(p: Place): HTMLElement {
  return el("span", { className: "shell-place-name" }, el("span", { textContent: p.title }), p.from ? el("small", { className: "shell-place-from", textContent: p.from }) : null);
}

/**
 * Half a second's press, without moving more than 10px, runs `held`; the click that press ends with is
 * then not a tap. A drag or a swipe isn't a press, and a click from the keyboard is never swallowed.
 */
function longPress(b: HTMLElement, held: () => void): void {
  let timer = 0;
  let fired = false;
  let from: { x: number; y: number } | null = null;
  const cancel = () => {
    clearTimeout(timer);
    from = null;
  };
  b.addEventListener("pointerdown", (e) => {
    fired = false;
    from = { x: e.clientX, y: e.clientY };
    timer = window.setTimeout(() => ((fired = true), held()), 500);
  });
  b.addEventListener("pointermove", (e) => {
    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) cancel();
  });
  for (const end of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(end, () => clearTimeout(timer));
  b.addEventListener("contextmenu", (e) => e.preventDefault());
  b.addEventListener(
    "click",
    (e) => {
      const swallow = fired && e.detail > 0;
      fired = false;
      if (!swallow) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    { capture: true },
  );
}

const LAST_PLACE = "common-ink.place";

/** The place you were last on, on this device: its browser keeps it. */
function lastPlace(): string | null {
  try {
    return localStorage.getItem(LAST_PLACE);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(LAST_PLACE, id);
  } catch {
    // No storage (a private window): the app opens on the Feed.
  }
}

export class Shell {
  readonly top = el("header", { id: "shell-top" });
  readonly bottom = el("nav", { id: "shell-bar", ariaLabel: "Places" });
  readonly toolbar = el("div", { id: "shell-toolbar", role: "toolbar", ariaLabel: "Editing" });
  /** The place you're in, and whether the window shows it (or a note over it). */
  private place = "feed";
  private screen: "list" | "window" = "window";
  /** What the place shows (its view, or the note its command went to), for telling the place from a note over it. */
  private root: string | null = null;
  /** A place's command went somewhere: what shows next is the place. */
  private awaitingRoot = false;
  /** History is reconciled with what's on show once the app has started, and not while an entry is restored. */
  private ready = false;
  private openedEarly = false;
  private holding = 0;
  /**
   * Entries being restored (the browser's back and forward, a reload), one after another: each waits for
   * the one before to be on show, and one a later pop has overtaken is skipped, so the latest one wins.
   */
  private restores: Promise<void> = Promise.resolve();
  private restoring = 0;
  private latest = 0;
  private reconciling = false;
  private sheet: Modal | null = null;
  private on = false;

  constructor(private deps: ShellDeps) {
    document.body.append(this.top, this.toolbar, this.bottom);
    this.toolbar.hidden = true;
    // While a note is edited by touch, the bottom bar gives way to the keyboard toolbar.
    const editing = () => queueMicrotask(() => this.drawToolbar());
    document.addEventListener("focusin", editing);
    document.addEventListener("focusout", editing);
    // The on-screen keyboard: the page is as tall as what's left above it (visualViewport), so the
    // toolbar sits on top of the keyboard and the note scrolls above both.
    // On iOS the keyboard covers the page rather than shrinking it, and the page may be panned (offsetTop)
    // to keep the caret in sight: the page sits where the visible part is, as tall as it.
    const vv = window.visualViewport;
    const fit = () => {
      const root = document.documentElement.style;
      root.setProperty("--app-height", `${Math.round(vv?.height ?? innerHeight)}px`);
      root.setProperty("--app-top", `${Math.round(vv?.offsetTop ?? 0)}px`);
    };
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    fit();
    // What's along the bottom (the bottom bar, or the keyboard toolbar in its place), for the not-saved
    // pill to float above when it's at the bottom (--not-saved-bottom, main.ts's placeNotSaved).
    new ResizeObserver(() => this.sayBottom()).observe(this.bottom);
    new ResizeObserver(() => this.sayBottom()).observe(this.toolbar);
  }

  private sayBottom(): void {
    // The pill adds the safe area itself: the bar's padding for it (its bottom padding) isn't counted twice.
    const bar = this.bottom.offsetHeight ? this.bottom.offsetHeight - parseFloat(getComputedStyle(this.bottom).paddingBottom) : 0;
    const height = this.on ? Math.round(Math.max(bar, this.toolbar.offsetHeight)) : 0;
    if (height) document.documentElement.style.setProperty("--not-saved-bottom", `${height}px`);
    else document.documentElement.style.removeProperty("--not-saved-bottom");
  }

  /** Whether the shell is the way round the app now: under 840px, where windows can't be side by side. */
  get active(): boolean {
    return this.on;
  }

  /** The width changed, or what's on show: turn the shell on or off, and draw it again. */
  update(): void {
    this.on = !this.deps.device.atLeast("expanded");
    document.documentElement.toggleAttribute("data-shell", this.on);
    document.documentElement.dataset.screen = this.on ? this.screen : "";
    this.top.hidden = this.bottom.hidden = !this.on;
    if (!this.on) {
      this.sheet?.close();
      this.toolbar.hidden = true;
      return;
    }
    this.drawTop();
    this.drawBar();
    this.drawToolbar();
    this.reconcile();
  }

  /**
   * Go to a place. Tapped again, the place you're on goes back down the history to its first entry, or
   * does nothing there. Its history entry is made by the reconciling, once it's on show.
   */
  go(id: string, how: { push?: boolean; now?: boolean } = {}): void {
    const place = this.deps.places().find((p) => p.id === id);
    if (!place) return;
    this.sheet?.close();
    const fromHistory = how.push === false || !this.on;
    // A tap while an entry is still being restored: it overtakes any waiting, and goes once the one under way is on show.
    if (!fromHistory && this.restoring && !how.now) {
      this.latest++;
      // In the chain, so a pop after the tap is restored after it, not alongside.
      this.restores = this.restores.then(() => this.go(id, { ...how, now: true })).catch(() => {});
      return;
    }
    const at = entryOf(history.state);
    if (!fromHistory && id === this.place && at?.place === id) {
      if (at.above > 0) return this.deps.back(at.above);
      if (!this.awaitingRoot) return this.update();
    }
    this.place = id;
    remember(id);
    this.root = null;
    this.awaitingRoot = false;
    if ("list" in place.open) this.screen = "list";
    else if ("view" in place.open) {
      this.screen = "window";
      this.deps.openView(place.open.view);
      this.root = `view:${place.open.view}`;
    } else {
      this.screen = "window";
      this.awaitingRoot = true;
      // Its note comes on show (opened), or was on show already: either way, once it's done, that's the place.
      void Promise.resolve(this.deps.run(place.open.command, place.by)).then(() => this.awaitingRoot && this.place === id && this.showWindow());
    }
    this.update();
  }

  /** What's on show, as a history entry would say it, or null while a place's command is still on its way. */
  private onShow(): Omit<ShellEntry, "above"> | null {
    if (this.screen === "list") return { place: this.place, show: "list", own: true };
    if (this.awaitingRoot) return null;
    const key = this.deps.showing()?.key ?? "list";
    return { place: this.place, show: key, ...(key === this.root && key.startsWith("view:") ? { own: true as const } : {}) };
  }

  /**
   * The one rule for the browser's history on a phone: the entry you're on says what's on show. However
   * something came on show (a tap, Search, a command, a link, a view an extension opened), once it has:
   * the same thing, nothing; a place's own screen takes the place of a place's own entry, and is a new one
   * over anything else; anything else is a new entry over the one you're on.
   */
  reconcile(): void {
    if (!this.on || !this.ready || this.holding || this.restoring || this.reconciling) return;
    this.reconciling = true;
    queueMicrotask(() => {
      this.reconciling = false;
      if (!this.on || !this.ready || this.holding || this.restoring) return;
      const want = this.onShow();
      if (!want) return;
      const at = entryOf(history.state);
      if (at && at.place === want.place && at.show === want.show && !!at.own === !!want.own) return;
      const nav = this.deps.visitId();
      if (want.own) {
        const entry: ShellEntry = { ...want, above: 0 };
        if (at?.own) this.deps.replace(entry);
        else this.deps.push(entry);
      } else this.deps.push({ ...want, above: at && at.place === want.place ? at.above + 1 : 0, ...(nav !== null ? { nav } : {}) });
      this.update();
    });
  }

  /**
   * An entry for a jump the app's own history makes, while the shell is on: what's on show, over the
   * entry you're on. Undefined when the shell is off, or isn't keeping history yet.
   */
  entryFor(show: string): Omit<ShellEntry, "nav"> | undefined {
    if (!this.on || !this.ready) return undefined;
    if (this.awaitingRoot) [this.root, this.awaitingRoot] = [show, false];
    this.screen = "window";
    const at = entryOf(history.state);
    return { place: this.place, show, above: at && at.place === this.place ? at.above + 1 : 0 };
  }

  /**
   * The app has started. A reload shows what its entry says. Opened afresh, it shows the place you were
   * last on, on this device (decision 21; the Feed at first), unless its address names a note: then the
   * note shows over the Feed, whose own entry goes under it, so back goes to the Feed, and then leaves.
   */
  started(state: unknown, how: { note?: boolean } = {}): void {
    if (!this.on) return void (this.ready = true);
    const kept = entryOf(state);
    if (kept) {
      this.ready = true;
      return this.restore(kept);
    }
    if (!how.note && !this.openedEarly) {
      const last = lastPlace();
      const place = this.deps.places().find((p) => p.id === last) ?? this.deps.places().find((p) => p.id === "feed");
      if (place) {
        this.deps.replace({ place: place.id, show: "list", own: true, above: 0 });
        this.ready = true;
        return this.go(place.id, { push: false });
      }
    }
    this.deps.replace({ place: this.place, show: "list", own: true, above: 0 });
    if (!this.deps.showing()) this.screen = "list";
    this.ready = true;
    this.update();
  }

  /** Something came on show in the window (a note opened, a view): it shows over the place. */
  showWindow(): void {
    // Before the app has started, something opened already (a link, a script) is what to show, not the last place.
    if (!this.ready) this.openedEarly = true;
    this.screen = "window";
    if (this.awaitingRoot) [this.root, this.awaitingRoot] = [this.deps.showing()?.key ?? null, false];
    this.update();
  }

  /** The browser goes back or forward to an entry: show what it says. Null if it isn't the shell's to show. */
  popped(state: unknown): ShellEntry | null {
    const entry = entryOf(state);
    if (!this.on || !entry) return null;
    this.restore(entry);
    return entry;
  }

  /**
   * Put on show exactly what an entry says: the place, and its list, view or note, whatever is on show
   * now. History isn't reconciled until it is, and restores go one at a time, the latest winning.
   */
  private restore(entry: ShellEntry): void {
    const turn = ++this.latest;
    this.restoring++;
    this.restores = this.restores
      .then(async () => {
        if (turn !== this.latest) return;
        this.sheet?.close();
        const place = this.deps.places().find((p) => p.id === entry.place);
        this.place = entry.place;
        remember(entry.place);
        this.awaitingRoot = false;
        this.screen = entry.show === "list" ? "list" : "window";
        // What the place itself shows, for telling it from what's over it: its view, or the note its command went to.
        this.root = !place ? null : "view" in place.open ? `view:${place.open.view}` : "command" in place.open && entry.above === 0 ? entry.show : null;
        this.update();
        if (entry.show !== "list") await this.deps.restore(entry.show, entry.nav);
      })
      .catch(() => {})
      .finally(() => {
        this.restoring--;
        this.update();
      });
  }

  /** While the browser's entry is being put on show (a note loading), history is left as it is. */
  hold<T>(work: Promise<T>): Promise<T> {
    this.holding++;
    return work.finally(() => {
      this.holding--;
      this.update();
    });
  }

  /** Back, up to the place: down the history to its first entry, or, with none below, the place's own screen in this entry's stead. */
  private back(): void {
    const at = entryOf(history.state);
    if (at && at.place === this.place && at.above > 0) return this.deps.back(at.above);
    const place = this.deps.places().find((p) => p.id === this.place);
    if (place && !("command" in place.open)) {
      this.deps.replace({ place: this.place, show: "list" in place.open ? "list" : `view:${place.open.view}`, own: true, above: 0 });
      return this.go(this.place, { push: false });
    }
    this.go(this.place);
  }

  private atPlace(): boolean {
    if (this.screen === "list" || this.awaitingRoot) return true;
    return this.deps.showing()?.key === this.root;
  }

  private drawTop(): void {
    const place = this.deps.places().find((p) => p.id === this.place);
    const showing = this.deps.showing();
    const atPlace = this.atPlace();
    const title = this.screen === "list" ? (place?.title ?? "Notes") : (showing?.title ?? place?.title ?? "");
    const kept = this.deps.kept();
    const keptText = [kept.windows ? `${kept.windows} ${kept.windows === 1 ? "window" : "windows"}` : "", kept.tabs ? `${kept.tabs} ${kept.tabs === 1 ? "tab" : "tabs"}` : ""].filter(Boolean).join(", ");
    const note = this.screen === "window" && !!showing?.note;
    this.top.replaceChildren(
      ...present(
      !atPlace ? iconButton("chevron-left", `Back to ${place?.title ?? "the list"}`, () => this.back()) : el("span", { className: "shell-gap" }),
      el("h1", { textContent: title }),
      // On a tablet, tabs show; what's kept for a wider screen is said here (a phone says it in Places).
      keptText && this.deps.device.atLeast("medium") ? el("span", { className: "shell-kept", textContent: `${keptText} kept`, title: "Kept in this device's layout until the window is wide enough" }) : null,
      this.screen === "list" ? iconButton("square-pen", "New note", () => this.deps.newNote()) : null,
      note && this.deps.contextViews().length ? iconButton("history", "History and views about this note", () => this.openContext()) : null,
      note ? iconButton("ellipsis", "More", () => this.openMenu()) : null,
      ),
    );
  }

  private drawBar(): void {
    const places = this.deps.places();
    const onBar = shownOnBar(this.deps.bar(), new Set(places.map((p) => p.id))).map((id) => places.find((p) => p.id === id)!);
    const button = (name: IconName, label: string, current: boolean, run: () => void) => {
      const b = iconButton(name, label, run, true);
      if (current) b.setAttribute("aria-current", "page");
      return b;
    };
    /** An extension's place on the bar: too narrow to say whose it is, so a long press says. */
    const placeButton = (p: Place) => {
      const b = button(p.icon, p.title, p.id === this.place, () => this.go(p.id));
      if (!p.from) return b;
      b.title = `${p.title} · ${p.from}`;
      longPress(b, () => this.deps.notice(`${p.title} comes from ${p.from}.`));
      return b;
    };
    this.bottom.replaceChildren(
      ...onBar.map(placeButton),
      button("search", "Search", false, () => this.deps.search()),
      button("menu", "Places", false, () => this.openPlaces()),
    );
  }

  /** The keyboard toolbar: while a note is edited on a touch screen, its buttons; otherwise none. */
  private drawToolbar(): void {
    const active = document.activeElement;
    const editing = this.deps.device.has("touch") && !!active?.closest("#workbench .cm-editor");
    document.documentElement.toggleAttribute("data-editing", editing && this.on);
    const was = !this.toolbar.hidden;
    this.toolbar.hidden = !editing;
    if (!editing || was) return;
    const buttons = this.deps.toolbar().map((a) => {
      const b = el("button", { type: "button", className: "shell-tool", ariaLabel: a.title, title: a.off ? `${a.title}: ${a.off}` : a.title }, a.icon && isIcon(a.icon) ? icon(a.icon, "1em") : (a.label ?? a.title));
      if (a.off) b.setAttribute("aria-disabled", "true");
      // Tapped without taking focus from the note, so the keyboard stays up.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.deps.run(a.command, a.by));
      return b;
    });
    const done = el("button", { type: "button", className: "shell-tool done", ariaLabel: "Hide the keyboard", title: "Hide the keyboard" }, icon("keyboard-off", "1em"));
    done.addEventListener("pointerdown", (e) => e.preventDefault());
    done.addEventListener("click", () => (document.activeElement as HTMLElement | null)?.blur());
    this.toolbar.replaceChildren(el("div", { className: "shell-tools" }, ...buttons), done);
  }

  /** A sheet from the bottom: a modal with a handle, closed by the scrim, Escape, or dragging it down. */
  private openSheet(label: string, fill: (body: HTMLElement, sheet: Modal) => void): Modal {
    this.sheet?.close();
    const sheet = openModal({ label, className: "shell-sheet", closeOnOutside: true, onClose: () => this.sheet === sheet && (this.sheet = null) });
    this.sheet = sheet;
    const handle = el("div", { className: "shell-handle", ariaHidden: "true" }, el("i"));
    let startY: number | null = null;
    handle.addEventListener("pointerdown", (e) => {
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (startY !== null) sheet.box.style.translate = `0 ${Math.max(0, e.clientY - startY)}px`;
    });
    handle.addEventListener("pointerup", (e) => {
      const moved = startY === null ? 0 : e.clientY - startY;
      startY = null;
      sheet.box.style.translate = "";
      if (moved > 80) sheet.close();
    });
    const body = el("div", { className: "shell-sheet-body" });
    sheet.box.append(handle, body);
    fill(body, sheet);
    return sheet;
  }

  /** Places: where you can go, what's kept for a wider screen, and the bottom bar's places. */
  openPlaces(): void {
    this.openSheet("Places", (body) => {
      const places = this.deps.places();
      const row = (p: Place) => {
        const b = el("button", { type: "button", className: "shell-place" }, icon(p.icon), placeName(p));
        if (p.id === this.place) b.setAttribute("aria-current", "page");
        b.addEventListener("click", () => this.go(p.id));
        return b;
      };
      const kept = this.deps.kept();
      const keptLines = [kept.windows ? `${kept.windows} ${kept.windows === 1 ? "window" : "windows"} beside this one` : "", kept.tabs ? `${kept.tabs} more ${kept.tabs === 1 ? "tab" : "tabs"}` : ""].filter(Boolean);
      const customize = el("button", { type: "button", className: "shell-place quiet", textContent: "Customize the bottom bar…" });
      customize.addEventListener("click", () => this.openBarChoice());
      body.append(
        ...present(
        el("h2", { textContent: "Places" }),
        ...places.filter((p) => !p.end).map(row),
        keptLines.length ? el("p", { className: "shell-kept-box" }, el("b", { textContent: "Kept for wider screens: " }), `${keptLines.join(" and ")}. They stay in this device's layout and come back when the window is wide enough.`) : null,
        el("hr"),
        ...places.filter((p) => p.end).map(row),
        customize,
        ),
      );
    });
  }

  /** Which three places are on the bottom bar: tick them, in the order they're listed. */
  private openBarChoice(): void {
    this.openSheet("The bottom bar", (body, sheet) => {
      const places = this.deps.places();
      // Three of the places there are now. Ids the bar keeps for places that aren't (an extension turned
      // off) take no slot here, and stay in the file after them, for when they're back.
      const ids = new Set(places.map((p) => p.id));
      const chosen = new Set(shownOnBar(this.deps.bar(), ids));
      const absent = this.deps.bar().filter((id) => !ids.has(id));
      const note = el("p", { className: "shell-note", textContent: "Pick three. Search and Places are always there." });
      const boxes = places.map((p) => {
        const box = el("input", { type: "checkbox", checked: chosen.has(p.id) });
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(p.id);
          else chosen.delete(p.id);
          for (const [i, b] of boxes.entries()) b.disabled = !b.checked && chosen.size >= 3 && !chosen.has(places[i].id);
        });
        return box;
      });
      for (const [i, b] of boxes.entries()) b.disabled = !b.checked && chosen.size >= 3 && !chosen.has(places[i].id);
      const save = el("button", { type: "button", className: "shell-primary", textContent: "Done" });
      save.addEventListener("click", async () => {
        await this.deps.setBar([...places.filter((p) => chosen.has(p.id)).map((p) => p.id), ...absent]);
        sheet.close();
        this.update();
      });
      body.append(el("h2", { textContent: "The bottom bar" }), note, ...places.map((p, i) => el("label", { className: "shell-place" }, boxes[i], icon(p.icon, "1em"), placeName(p))), save);
    });
  }

  /** Views about the note in focus, in a sheet with a switcher across its top. */
  private openContext(): void {
    const views = this.deps.contextViews();
    this.openSheet("About this note", (body) => {
      const view = el("div", { className: "shell-context tab-view" });
      const show = (id: string) => {
        for (const b of switcher.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.view === id));
        this.deps.drawView(id, view);
      };
      const switcher = el(
        "div",
        { className: "shell-switcher", role: "tablist" },
        ...views.map((v) => {
          const b = el("button", { type: "button", role: "tab", textContent: v.title });
          b.dataset.view = v.id;
          b.addEventListener("click", () => show(v.id));
          return b;
        }),
      );
      body.append(switcher, view);
      show(views[0].id);
    });
  }

  /** The note's ⋯ menu: what can be done with it here, and what can't, greyed with why. */
  private openMenu(): void {
    this.openSheet("More", (body, sheet) => {
      body.append(
        ...this.deps.menu().map((a) => {
          const b = el("button", { type: "button", className: "shell-action" }, el("span", { textContent: a.title }), a.off ? el("span", { className: "shell-why", textContent: a.off.replace(/^Off on this device · /, "") }) : null);
          if (a.off) b.setAttribute("aria-disabled", "true");
          b.addEventListener("click", () => {
            sheet.close();
            this.deps.run(a.command, a.by);
          });
          return b;
        }),
      );
    });
  }
}
