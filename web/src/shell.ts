// The phone shell, for widths under 840px (compact and medium): a top bar with back, what's on show,
// views about the note (◷) and its menu (⋯); a bottom bar of three places, Search and Places; the
// Places sheet; and, while you edit by touch, the keyboard toolbar above the on-screen keyboard. One
// screen at a time: a place (the notes list, or a view) or a note over it. Back goes up to the place,
// and the system's back gesture goes back through the browser's history, which holds each place shown.
// Sheets are modals (modal.ts), so focus, Escape and the scrim work as everywhere else.
import { icon, isIcon, type IconName } from "./icons.ts";
import { openModal, type Modal } from "./modal.ts";
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
  /** Show a view in the focused window; run a command. */
  openView(id: string): void;
  run(command: string): void;
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
  /** A new entry in the browser's history for a place, so the system's back gesture comes back to it. */
  push(state: { shell: string }): void;
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
  const b = el("button", { type: "button", className: "shell-icon", ariaLabel: label, title: label }, icon(name), shown ? el("span", { textContent: label }) : null);
  b.addEventListener("click", run);
  return b;
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
    const vv = window.visualViewport;
    const fit = () => document.documentElement.style.setProperty("--app-height", `${Math.round(vv?.height ?? innerHeight)}px`);
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", () => {
      // iOS scrolls the page to keep the caret in sight; the page already fits above the keyboard.
      if (this.on && scrollY) scrollTo(0, 0);
    });
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

  /** Go to a place: its screen, and an entry in the browser's history unless that's how you came. */
  go(id: string, how: { push?: boolean } = {}): void {
    const place = this.deps.places().find((p) => p.id === id);
    if (!place) return;
    this.sheet?.close();
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
      this.deps.run(place.open.command);
    }
    // A command's place (Today) goes to a note, and opening it makes the entry.
    if (how.push !== false && this.on && !("command" in place.open)) this.deps.push({ shell: id });
    this.update();
  }

  /** A note was opened (from the list, a link, search): it shows over the place. */
  showWindow(): void {
    this.screen = "window";
    if (this.awaitingRoot) [this.root, this.awaitingRoot] = [this.deps.showing()?.key ?? null, false];
    this.update();
  }

  /** The browser went back or forward to an entry: one of a place's, which the shell shows. Says whether it was. */
  popped(state: unknown): boolean {
    const id = (state as { shell?: unknown } | null)?.shell;
    if (typeof id !== "string" || !this.on) return false;
    this.go(id, { push: false });
    return true;
  }

  /** Back, up to the place the note is over. */
  private back(): void {
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
    const onBar = this.deps.bar().flatMap((id) => places.filter((p) => p.id === id));
    const button = (name: IconName, label: string, current: boolean, run: () => void) => {
      const b = iconButton(name, label, run, true);
      if (current) b.setAttribute("aria-current", "page");
      return b;
    };
    this.bottom.replaceChildren(
      ...onBar.map((p) => button(p.icon, p.title, p.id === this.place, () => this.go(p.id))),
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
      const b = el("button", { type: "button", className: "shell-tool", ariaLabel: a.title, title: a.off ? `${a.title}: ${a.off}` : a.title }, a.icon && isIcon(a.icon) ? icon(a.icon) : (a.label ?? a.title));
      if (a.off) b.setAttribute("aria-disabled", "true");
      // Tapped without taking focus from the note, so the keyboard stays up.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => this.deps.run(a.command));
      return b;
    });
    const done = el("button", { type: "button", className: "shell-tool done", ariaLabel: "Hide the keyboard", title: "Hide the keyboard" }, icon("keyboard-off"));
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
        const b = el("button", { type: "button", className: "shell-place" }, icon(p.icon), el("span", { textContent: p.title }));
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
      const chosen = new Set(this.deps.bar());
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
        await this.deps.setBar(places.filter((p) => chosen.has(p.id)).map((p) => p.id));
        sheet.close();
        this.update();
      });
      body.append(el("h2", { textContent: "The bottom bar" }), note, ...places.map((p, i) => el("label", { className: "shell-place" }, boxes[i], icon(p.icon), el("span", { textContent: p.title }))), save);
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
