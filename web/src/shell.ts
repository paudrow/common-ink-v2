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
}

/** A command as a button or a menu item, with why it's off on this device if it is. */
export interface Action {
  command: string;
  title: string;
  icon?: string;
  label?: string;
  off?: string | null;
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
  run(command: string): unknown;
  /** The note on show as a step of its own over the place's entry, when coming on show made none (it was on show already). */
  stepOver(): void;
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
  /** The browser's history, for the place shown: a new entry, the one you're on in its place, or back `n` entries. */
  push(state: ShellEntry): void;
  replace(state: ShellEntry): void;
  back(n: number): void;
}

/**
 * What the shell keeps in a browser history entry: the place it's at, and how many entries it is above
 * that place's own (0 is the place's own). A place's entry has `shell`, and shows the place itself.
 */
export interface ShellEntry {
  place: string;
  above: number;
  shell?: true;
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

/** Half a second's press, without moving away, runs `held`; the click a press ends with is then not a tap. */
function longPress(b: HTMLElement, held: () => void): void {
  let timer = 0;
  let fired = false;
  b.addEventListener("pointerdown", () => {
    fired = false;
    timer = window.setTimeout(() => ((fired = true), held()), 500);
  });
  for (const end of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(end, () => clearTimeout(timer));
  b.addEventListener("contextmenu", (e) => e.preventDefault());
  b.addEventListener(
    "click",
    (e) => {
      if (!fired) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    { capture: true },
  );
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
  /** How many history entries the one you're on is above the place's own: -1 while the place has none. */
  private depth = -1;
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
  }

  /**
   * Go to a place: its screen, and its entry in the browser's history unless that's how you came. The
   * place you're on, from a note over it, is back down the history to its entry; tapped again on it,
   * nothing. Another place takes the place of the entry you're on if it's a place's, and is a new one
   * over a note, so back comes back to the note.
   */
  go(id: string, how: { push?: boolean } = {}): void {
    const place = this.deps.places().find((p) => p.id === id);
    if (!place) return;
    this.sheet?.close();
    const fromHistory = how.push === false || !this.on;
    if (!fromHistory && id === this.place && this.depth > 0) return this.deps.back(this.depth);
    if (!fromHistory && id === this.place && this.depth === 0 && !("command" in place.open)) return this.update();
    this.place = id;
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
      // Done, and nothing came on show (its note was on show already): that's the place now, as a step of its own.
      void Promise.resolve(this.deps.run(place.open.command)).then(() => {
        if (this.place !== id || !this.awaitingRoot) return;
        if (!fromHistory) this.deps.stepOver();
        this.showWindow();
      });
    }
    if (!fromHistory) {
      const entry: ShellEntry = { place: id, above: 0, shell: true };
      // A command's place (Today) goes to a note, whose opening makes its entry: over the place's entry you're
      // on, so back comes back to it; from a note, as the place's own.
      if ("command" in place.open) this.depth = this.depth === 0 ? 0 : -1;
      else {
        if (this.depth === 0) this.deps.replace(entry);
        else this.deps.push(entry);
        this.depth = 0;
      }
    }
    this.update();
  }

  /**
   * What goes in the entry for a note being opened, with a jump, while the shell is on: its place, and
   * how far above the place's entry it is. Undefined when the shell is off.
   */
  entryFor(): ShellEntry | undefined {
    if (!this.on) return undefined;
    this.depth = this.depth < 0 ? 0 : this.depth + 1;
    return { place: this.place, above: this.depth };
  }

  /** The app started on a note: under the shell it shows over the Feed, so back goes to the Feed and then leaves. */
  started(state: unknown, hereEntry: (entry: ShellEntry) => void): void {
    if (!this.on) return;
    const kept = state as Partial<ShellEntry> | null;
    if (kept && typeof kept.place === "string" && typeof kept.above === "number") {
      // A reload: where it was.
      if (kept.shell) return this.go(kept.place, { push: false });
      [this.place, this.depth, this.screen] = [kept.place, kept.above, "window"];
      return this.update();
    }
    this.deps.replace({ place: this.place, above: 0, shell: true });
    this.depth = 0;
    // Nothing on show: the Feed itself.
    if (!this.deps.showing()) this.screen = "list";
    else hereEntry(this.entryFor()!);
    this.update();
  }

  /** A note was opened (from the list, a link, search): it shows over the place. */
  showWindow(): void {
    this.screen = "window";
    if (this.awaitingRoot) [this.root, this.awaitingRoot] = [this.deps.showing()?.key ?? null, false];
    this.update();
  }

  /** The browser went back or forward to an entry. A place's own, the shell shows, and says so; a note's, it notes where it is. */
  popped(state: unknown): boolean {
    const entry = state as Partial<ShellEntry> | null;
    if (!this.on || !entry || typeof entry.place !== "string" || typeof entry.above !== "number") {
      this.depth = -1;
      return false;
    }
    if (entry.shell) {
      this.go(entry.place, { push: false });
      this.depth = 0;
      return true;
    }
    if (entry.place !== this.place) [this.place, this.root, this.awaitingRoot] = [entry.place, null, false];
    this.depth = entry.above;
    return false;
  }

  /** Back, up to the place the note is over: down the history to its entry, or, without one below, to the place in this entry's stead. */
  private back(): void {
    if (this.depth > 0) return this.deps.back(this.depth);
    const place = this.deps.places().find((p) => p.id === this.place);
    if (place && !("command" in place.open)) {
      this.deps.replace({ place: this.place, above: 0, shell: true });
      this.depth = 0;
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
      b.addEventListener("click", () => this.deps.run(a.command));
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
            this.deps.run(a.command);
          });
          return b;
        }),
      );
    });
  }
}
