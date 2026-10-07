// Places on wide screens (840px and over): a sidebar of where you can go, beside the list and the note
// (study 9.1, decisions 3, 4 and 22). Top to bottom: the places you go (the Feed, Search, then extensions'
// places), pinned notes, saved searches, and at the bottom Sources, Archive, Trash, Extensions and
// Settings. No file tree: folders are found with `in:` and saved searches. Under 840px the phone shell
// (shell.ts) has the same places in its sheet. ⌘B hides it; with focus in it, j and k move and ↵ or l opens.
import { icon, type IconName } from "./icons.ts";
import { matchKeys } from "./keys.ts";
import type { Place } from "./shell.ts";
import type { FilePath } from "../../worker/src/files.ts";
import type { SavedSearch } from "../../worker/src/places.ts";

/** Places listed at the bottom, in this order, with Extensions and Settings (the places marked `end`). */
const BOTTOM = ["data-sources.sources", "view:archive", "view:trash"];
/** Icons for views that are places without saying one. */
const ICONS: Readonly<Record<string, IconName>> = { "view:archive": "archive", "view:trash": "trash-2" };

/** What's chosen in the sidebar: a place, a pinned note, or a saved search. */
export type Chosen = { place: string } | { pinned: FilePath } | { saved: string };

export interface SidebarDeps {
  /** Every place, in order (main.ts's, as the phone shell lists them). */
  places(): Place[];
  /** The pinned notes, in pin order, with their titles. */
  pinned(): Array<{ path: FilePath; title: string }>;
  /** The saved searches, each with how many notes it finds, once that's known. */
  saved(): Array<SavedSearch & { count?: string }>;
  /** What's chosen now, marked as current. */
  current(): Chosen | null;
  go(place: Place): void;
  openPinned(path: FilePath): void;
  openSaved(saved: SavedSearch): void;
  removeSaved(saved: SavedSearch): void;
  search(): void;
}

type Child = Node | string | null | false | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  node.append(...(children.filter(Boolean) as Array<Node | string>));
  return node;
}

const same = (a: Chosen | null, b: Chosen) => !!a && JSON.stringify(a) === JSON.stringify(b);

export class Sidebar {
  readonly root = el("nav", { id: "places", ariaLabel: "Places" });

  constructor(private deps: SidebarDeps) {
    this.root.addEventListener("keydown", (e) => this.key(e));
  }

  /** Draw it again, keeping focus on the item it was on. */
  render(): void {
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement.dataset.item : undefined;
    const current = this.deps.current();
    const all = this.deps.places();
    const bottom = [...BOTTOM.flatMap((id) => all.filter((p) => p.id === id)), ...all.filter((p) => p.end)];
    const top = all.filter((p) => !bottom.includes(p));
    const item = (key: string, chosen: Chosen | null, name: IconName, title: string, run: () => void, more: { detail?: string; from?: string; remove?: () => void; label?: string } = {}) => {
      const button = el(
        "button",
        { type: "button", className: "place-item", title: more.label ?? title },
        icon(name, 16),
        el("span", { className: "place-title", textContent: title }),
        more.from && el("small", { className: "place-from", textContent: more.from }),
        more.detail && el("span", { className: "place-count", textContent: more.detail }),
      );
      button.dataset.item = key;
      if (chosen && same(current, chosen)) button.setAttribute("aria-current", "page");
      button.addEventListener("click", run);
      const li = el("li", {}, button);
      if (more.remove) {
        const remove = el("button", { type: "button", className: "place-remove", ariaLabel: `Remove "${title}" from Places`, title: "Remove from Places" }, icon("x", 14));
        remove.addEventListener("click", more.remove);
        li.append(remove);
      }
      return li;
    };
    const place = (p: Place) => item(`place:${p.id}`, { place: p.id }, ICONS[p.id] ?? p.icon, p.title, () => this.deps.go(p), { from: p.from });
    const section = (label: string, items: HTMLElement[], className = "") => (items.length ? el("section", { className: `places-section ${className}`.trim(), ariaLabel: label }, label && el("h3", { textContent: label }), el("ul", {}, ...items)) : null);
    const [feed, ...rest] = top;
    const sections = [
      section("", [
        ...(feed ? [place(feed)] : []),
        item("search", null, "search", "Search", () => this.deps.search(), { label: "Search (⌘K)" }),
        ...rest.map(place),
      ]),
      section("Pinned", this.deps.pinned().map((p) => item(`pinned:${p.path}`, { pinned: p.path }, "pin", p.title, () => this.deps.openPinned(p.path), { label: p.path }))),
      section(
        "Saved searches",
        this.deps.saved().map((s) => item(`saved:${s.name}`, { saved: s.name }, "search", s.name, () => this.deps.openSaved(s), { detail: s.count, label: s.query, remove: () => this.deps.removeSaved(s) })),
      ),
      section("", bottom.map(place), "places-bottom"),
    ];
    this.root.replaceChildren(...(sections.filter(Boolean) as HTMLElement[]));
    if (focused) this.items().find((b) => b.dataset.item === focused)?.focus();
  }

  /** Focus the current item, or the first. */
  focus(): void {
    (this.items().find((b) => b.getAttribute("aria-current")) ?? this.items()[0])?.focus();
  }

  private items(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>("button.place-item")];
  }

  private key(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const by = matchKeys(e, "j") || matchKeys(e, "ArrowDown") ? 1 : matchKeys(e, "k") || matchKeys(e, "ArrowUp") ? -1 : 0;
    if (by) items[Math.max(0, Math.min(items.length - 1, at + by))].focus();
    else if (matchKeys(e, "l")) items[at].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * The go keys' state: `g`, then a key from GO_KEYS within a moment, outside text. The first `g` isn't
 * taken from what has focus, so a list's own `gg` still works; the second key is, only if it goes somewhere.
 */
export class GoKeys {
  private armed = 0;

  constructor(private go: (key: string) => boolean) {}

  /** Whether an element takes typing, where `g` is a letter (or Vim's), not a go key. */
  static typing(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el?.closest) return false;
    return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .cm-editor");
  }

  /** A key went down: true if it was a go key's second, which then shouldn't do anything else. */
  key(e: KeyboardEvent): boolean {
    // Shift on its way to a key (`/` on some layouts) isn't one.
    if (["Shift", "Alt", "Control", "Meta"].includes(e.key)) return false;
    if (e.metaKey || e.ctrlKey || e.altKey || GoKeys.typing(e.target)) return (this.armed = 0), false;
    const armed = this.armed && Date.now() - this.armed < 1500;
    this.armed = 0;
    if (armed && e.key !== "g") return this.go(e.key);
    if (e.key === "g" && !armed) this.armed = Date.now();
    return false;
  }
}
