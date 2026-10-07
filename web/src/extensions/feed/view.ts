// The Feed's view: pinned cards first, then the rest, newest change first, under date groups, read a page
// at a time as you scroll. By touch a card swipes (common-ink/swipe) to archive, trash or pin it, as the
// feed.swipe settings say, and a long press starts a selection that the bar at the bottom acts on. With a
// keyboard, j and k move between cards, ↵ opens one, e archives, # or dd trashes, p pins, x selects and u
// undoes the last of those (study, sections 5.2 and 9.3). Changes that arrive while you're scrolled down
// don't move the list: a pill says how many, and a tap on it brings them in at the top.
import type { Author, FilePath } from "common-ink/files";
import { icon } from "common-ink/icons";
import { IS_MAC } from "common-ink/keys";
import { swipeable, type SwipeAction } from "common-ink/swipe";
import { dateGroup, previewLines, type PreviewLine } from "./cards.ts";

/** A note as the Feed lists it: what search says of it, and its first lines once they're read. */
export interface Card {
  path: FilePath;
  title: string;
  edited: number;
  author: Author;
  lines?: PreviewLine[];
  pinned?: boolean;
}

export type SwipeChoice = "archive" | "trash" | "pin" | "none";

export interface FeedEnv {
  /** A page of the cards that aren't pinned, in the Feed's order, and how many there are in all. */
  page(offset: number, limit: number): Promise<{ cards: Card[]; total: number }>;
  /** The pinned cards, in the order they were pinned. */
  pinned(): Promise<Card[]>;
  /** A note's text, for its card's lines. */
  text(path: FilePath): Promise<string>;
  /** Open a note: in the window's preview tab, or in a tab of its own (`newTab`). */
  open(path: FilePath, how?: { newTab?: boolean }): void;
  archive(paths: FilePath[]): Promise<boolean>;
  trash(paths: FilePath[]): Promise<boolean>;
  pin(paths: FilePath[], pinned: boolean): Promise<boolean>;
  /** Take back the last archive, trash or pin, if there is one to take back. */
  undo(): void;
  swipe(side: "right" | "left"): SwipeChoice;
  /** Who made a change, as the Feed says it ("you", "Claude"), and whether that's an agent. */
  who(author: Author): { name: string; agent: boolean };
  /** When, as the Feed says it ("3 h ago"). */
  when(time: number): string;
  label(path: FilePath): string;
}

/** Cards read at a time, and how near the end the next page is read. */
export const PAGE = 30;
const NEAR_END_PX = 600;
/** Scrolled down further than this, a change waits under the pill rather than moving the list. */
const AT_TOP_PX = 40;

const ACTIONS: Record<"archive" | "trash", { label: string; tone: string }> = {
  archive: { label: "Archive", tone: "archive" },
  trash: { label: "Trash", tone: "delete" },
};

/** How long after a first d a second one makes dd. */
const DD_MS = 800;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class FeedView {
  private cards: Card[] = [];
  private pins: Card[] = [];
  /** The card the keyboard is on. */
  private current: FilePath | null = null;
  private lastD = 0;
  private total = 0;
  private loaded = false;
  private loading: Promise<void> | null = null;
  /** Notes changed since the list was last read from the top, while you were scrolled down. */
  private waiting = new Set<string>();
  private selected: Set<FilePath> | null = null;
  private root = el("div", "feed");
  private box: HTMLElement | null = null;
  private scroll = 0;
  private observer: IntersectionObserver | null = null;
  private generation = 0;
  /** Notes the Feed itself just changed (archived, trashed, or undid that), until when: their changes aren't news for the pill. */
  private own = new Map<string, number>();
  /** The pointer of the long press under way: its lifting click isn't a tap. */
  private held: number | null = null;
  /** Why the last read failed, shown above the cards until one works. */
  private problem = "";

  constructor(private env: FeedEnv) {
    this.root.addEventListener("focusin", (e) => {
      const path = (e.target as HTMLElement).closest<HTMLElement>(".feed-card")?.dataset.path;
      if (path) this.current = path as FilePath;
    });
  }

  /** Every card, as listed: pinned ones first. */
  private all(): Card[] {
    return [...this.pins, ...this.cards];
  }

  /**
   * The Feed's keys, matched on the character typed (so they work on any layout), only while the Feed
   * has focus and never with ⌘, Ctrl or Alt held. ↵ is the focused card's own: it's a button.
   */
  private key(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    const cards = this.all();
    const at = cards.findIndex((c) => c.path === this.current);
    const card = cards[at] ?? null;
    const targets = (): FilePath[] => (this.selected?.size ? [...this.selected] : card ? [card.path] : []);
    const dd = e.key === "d" && Date.now() - this.lastD < DD_MS;
    this.lastD = e.key === "d" && !dd ? Date.now() : 0;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        this.move(cards, at < 0 ? 0 : Math.min(cards.length - 1, at + 1));
        break;
      case "k":
      case "ArrowUp":
        this.move(cards, Math.max(0, at - 1));
        break;
      case "e":
        if (targets().length) void this.act("archive", targets());
        break;
      case "#":
        if (targets().length) void this.act("trash", targets());
        break;
      case "d":
        if (dd && targets().length) void this.act("trash", targets());
        break;
      case "p":
        if (targets().length) void this.act(cards.filter((c) => targets().includes(c.path)).every((c) => c.pinned) ? "unpin" : "pin", targets());
        break;
      case "x":
        if (!card) return;
        this.selected ??= new Set();
        if (this.selected.has(card.path)) this.selected.delete(card.path);
        else this.selected.add(card.path);
        if (!this.selected.size) this.selected = null;
        this.draw();
        break;
      case "u":
        this.env.undo();
        break;
      case "Escape":
        if (!this.selected) return;
        this.selected = null;
        this.draw();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** Put the keyboard on a card, scrolled into sight. */
  private move(cards: Card[], to: number) {
    const card = cards[to];
    if (!card) return;
    this.current = card.path;
    const body = this.root.querySelector<HTMLElement>(`.feed-card[data-path="${CSS.escape(card.path)}"] .feed-card-body`);
    body?.focus();
    body?.scrollIntoView({ block: "nearest" });
    // Near the end of what's read, the next page comes.
    if (cards.length - to < 5) void this.more();
  }

  /** Draw into the view's box: the cards as they were, where you were, and read again from the top. */
  render(box: HTMLElement): void {
    if (this.box !== box) {
      this.box?.removeEventListener("scroll", this.remember);
      this.box?.removeEventListener("keydown", this.keys);
      this.box = box;
      box.addEventListener("scroll", this.remember, { passive: true });
      // On the view's box, which has focus when the Feed opens, as well as on its cards.
      box.addEventListener("keydown", this.keys);
    }
    box.classList.add("feed-box");
    if (this.root.parentElement !== box) box.replaceChildren(this.root);
    this.draw();
    box.scrollTop = this.scroll;
    void (this.loaded ? this.refresh() : this.reload());
  }

  private keys = (e: KeyboardEvent) => this.key(e);

  private remember = () => {
    if (!this.box) return;
    this.scroll = this.box.scrollTop;
    if (this.waiting.size && this.scroll < AT_TOP_PX) void this.reload();
  };

  /** A note changed, or the archive did. At the top, the list takes it in now; scrolled down, the pill counts it. */
  changed(path: string): void {
    if (!this.loaded) return;
    if ((this.own.get(path) ?? 0) > Date.now()) return void this.refresh();
    if (this.selected || (this.box && this.box.scrollTop > AT_TOP_PX)) {
      if (path.endsWith(".md")) this.waiting.add(path);
      this.draw();
      return;
    }
    void this.refresh();
  }

  /** Changes to these notes for the next few seconds are the Feed's own doing. */
  ownChanges(paths: readonly string[]): void {
    for (const p of paths) this.own.set(p, Date.now() + 5000);
  }

  /** Read every card shown again (more as they come), from the top. */
  async reload(): Promise<void> {
    this.waiting.clear();
    await this.read(Math.max(PAGE, this.cards.length), true);
  }

  /** As reload, keeping the pill: what came in while you were scrolled down is taken in only when you ask. */
  private async refresh(): Promise<void> {
    const waiting = new Set(this.waiting);
    await this.read(Math.max(PAGE, this.cards.length), true);
    if (this.box && this.box.scrollTop > AT_TOP_PX) for (const p of waiting) this.waiting.add(p);
  }

  /** The next page, once you're near the end. */
  private async more(): Promise<void> {
    if (this.loading || this.cards.length >= this.total) return;
    await this.read(PAGE, false);
  }

  private async read(count: number, fromTop: boolean): Promise<void> {
    const turn = ++this.generation;
    const work = (async () => {
      this.problem = "";
      const offset = fromTop ? 0 : this.cards.length;
      const found: Card[] = [];
      let total = 0;
      // Search answers 100 at most at a time.
      for (let at = offset; at < offset + count; at += 100) {
        const page = await this.env.page(at, Math.min(100, offset + count - at));
        total = page.total;
        found.push(...page.cards);
        if (page.cards.length < 100) break;
      }
      const pins = fromTop ? await this.env.pinned() : this.pins;
      const known = new Map(this.all().map((c) => [c.path, c]));
      await Promise.all(
        [...found, ...(fromTop ? pins : [])].map(async (c) => {
          const was = known.get(c.path);
          c.lines = was && was.edited === c.edited && was.lines ? was.lines : previewLines(await this.env.text(c.path).catch(() => ""));
        }),
      );
      if (turn !== this.generation) return;
      this.cards = fromTop ? found : [...this.cards, ...found.filter((c) => !known.has(c.path))];
      this.pins = pins.map((c) => ({ ...c, pinned: true }));
      this.total = total;
      this.loaded = true;
      if (this.selected) this.selected = new Set([...this.selected].filter((p) => this.all().some((c) => c.path === p)));
      this.draw();
    })();
    this.loading = work;
    try {
      await work;
    } catch (err) {
      // Offline, or the server's away: what was read stays, and the Feed says why it's not up to date.
      if (turn !== this.generation) return;
      this.problem = `The Feed can't be read: ${(err as Error).message}`;
      this.draw();
    } finally {
      if (this.loading === work) this.loading = null;
    }
  }

  /** Archive or trash cards, taking them out at once when it's done; or pin or unpin them, read again into their places. */
  private async act(kind: "archive" | "trash" | "pin" | "unpin", paths: FilePath[]) {
    this.ownChanges(paths);
    // The keyboard goes on to the card after the last one acted on, so it stays in the list.
    const cards = this.all();
    const last = Math.max(...paths.map((p) => cards.findIndex((c) => c.path === p)));
    const next = cards.slice(last + 1).find((c) => !paths.includes(c.path)) ?? [...cards].reverse().find((c) => !paths.includes(c.path));
    // Whether the keyboard was in the Feed: moving a note to Trash closes its tabs, which can move focus meanwhile.
    const keyboard = !!this.box?.contains(document.activeElement);
    const done = await (kind === "archive" ? this.env.archive(paths) : kind === "trash" ? this.env.trash(paths) : this.env.pin(paths, kind === "pin"));
    if (!done) return;
    this.selected = null;
    if (kind === "pin" || kind === "unpin") return void (await this.reload());
    const gone = new Set<string>(paths);
    this.cards = this.cards.filter((c) => !gone.has(c.path));
    this.pins = this.pins.filter((c) => !gone.has(c.path));
    this.total = Math.max(0, this.total - paths.length);
    if (this.current && gone.has(this.current)) this.current = next?.path ?? null;
    this.draw();
    if (keyboard && this.current) this.move(this.all(), this.all().findIndex((c) => c.path === this.current));
  }

  private swipeAction(side: "right" | "left", card: Card): SwipeAction | undefined {
    const choice = this.env.swipe(side);
    if (choice === "none") return undefined;
    if (choice === "pin") return { label: card.pinned ? "Unpin" : "Pin", tone: "pin", run: () => this.act(card.pinned ? "unpin" : "pin", [card.path]) };
    return { ...ACTIONS[choice], run: () => this.act(choice, [card.path]) };
  }

  private toggle(path: FilePath) {
    if (!this.selected) return;
    if (this.selected.has(path)) this.selected.delete(path);
    else this.selected.add(path);
    if (!this.selected.size) this.selected = null;
    this.draw();
  }

  private draw(): void {
    const parts: HTMLElement[] = [];
    const waiting = this.waiting.size;
    if (waiting) {
      const pill = el("button", "feed-pill", `↑ ${waiting} new change${waiting === 1 ? "" : "s"}`);
      pill.type = "button";
      pill.addEventListener("click", () => {
        if (this.box) this.box.scrollTop = 0;
        void this.reload();
      });
      const row = el("div", "feed-pill-row");
      row.append(pill);
      parts.push(row);
    }
    parts.push(el("p", "feed-query", "-is:archived sort:edited"));
    if (this.problem) parts.push(el("p", "feed-problem", this.problem));
    if (this.loaded && !this.cards.length && !this.pins.length && !this.problem) {
      const empty = el("div", "feed-empty");
      empty.append(el("b", "", "Inbox zero for notes."), el("span", "", " Everything is archived or in Trash."));
      parts.push(empty);
    }
    const list = el("div", "feed-list");
    if (this.pins.length) {
      const pinned = el("ul", "feed-group pinned");
      pinned.setAttribute("aria-label", "Pinned");
      for (const card of this.pins) pinned.append(this.cardEl(card));
      list.append(el("h2", "feed-group-title", "Pinned"), pinned);
    }
    let group = "";
    let section: HTMLElement | null = null;
    for (const card of this.cards) {
      const g = dateGroup(card.edited);
      if (g !== group || !section) {
        group = g;
        section = el("ul", "feed-group");
        section.setAttribute("aria-label", g);
        list.append(el("h2", "feed-group-title", g), section);
      }
      section.append(this.cardEl(card));
    }
    parts.push(list);
    if (this.loaded && this.all().length) {
      const end = el("p", "feed-end", this.cards.length < this.total ? "Loading older notes…" : "That's everything not archived.");
      parts.push(end);
      this.observer?.disconnect();
      if (this.cards.length < this.total) {
        this.observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void this.more(), { root: this.box, rootMargin: `0px 0px ${NEAR_END_PX}px 0px` });
        this.observer.observe(end);
      }
    }
    if (this.selected) parts.push(this.selectionBar(this.selected));
    this.root.classList.toggle("selecting", !!this.selected);
    // Drawing again keeps the keyboard on its card.
    const keyboard = this.root.contains(document.activeElement);
    this.root.replaceChildren(...parts);
    if (keyboard && this.current) this.root.querySelector<HTMLElement>(`.feed-card[data-path="${CSS.escape(this.current)}"] .feed-card-body`)?.focus({ preventScroll: true });
  }

  private cardEl(card: Card): HTMLElement {
    const li = el("li", "feed-card");
    li.dataset.path = card.path;
    const picked = this.selected?.has(card.path) ?? false;
    if (picked) li.classList.add("picked");
    const body = el("button", "feed-card-body");
    body.type = "button";
    // As a row of the notes list: ⌘-click (Ctrl off a Mac) opens it in a tab of its own, a double click
    // keeps its tab, and it drags into a window (data-open, which the Workbench reads).
    body.dataset.open = JSON.stringify({ file: card.path });
    body.dataset.title = card.title;
    body.draggable = !this.selected;
    const top = el("span", "feed-card-top");
    const folder = card.path.includes("/") ? card.path.slice(0, card.path.lastIndexOf("/")) : "";
    top.append(el("span", "feed-card-title", card.title), folder ? el("span", "feed-card-folder", folder) : "", el("span", "feed-card-when", this.env.when(card.edited)));
    if (card.pinned) {
      const pin = icon("pin", "0.9em");
      pin.setAttribute("aria-label", "Pinned");
      pin.removeAttribute("aria-hidden");
      top.prepend(pin);
    }
    const who = this.env.who(card.author);
    const meta = el("span", "feed-card-meta");
    meta.append(el("span", who.agent ? "feed-who agent" : "feed-who", who.name));
    const lines = el("span", "feed-card-lines");
    for (const line of card.lines ?? []) {
      const row = el("span", `feed-line ${line.kind}`, line.text);
      if (line.kind === "task" || line.kind === "done") row.prepend(icon(line.kind === "done" ? "square-check" : "list-checks", "0.9em"));
      lines.append(row);
    }
    body.append(top, meta, lines);
    if (this.selected) body.setAttribute("aria-pressed", String(picked));
    body.addEventListener("click", (e) => {
      // The finger a long press lifts lands on the card drawn again for the selection: that isn't a tap.
      if ((e as PointerEvent).pointerId === this.held) return void (this.held = null);
      if (this.selected) this.toggle(card.path);
      else this.env.open(card.path, { newTab: IS_MAC ? e.metaKey : e.ctrlKey });
    });
    body.addEventListener("dblclick", (e) => {
      if (this.selected) return;
      e.preventDefault();
      this.env.open(card.path, { newTab: true });
    });
    li.append(body);
    swipeable(li, body, {
      right: this.selected ? undefined : this.swipeAction("right", card),
      left: this.selected ? undefined : this.swipeAction("left", card),
      long: (pointerId) => {
        this.held = pointerId;
        this.selected ??= new Set();
        this.selected.add(card.path);
        navigator.vibrate?.(10);
        this.draw();
      },
    });
    return li;
  }

  /** What a selection can do: archive or trash them all, as one undo each, or stop selecting. */
  private selectionBar(selected: Set<FilePath>): HTMLElement {
    const allPinned = this.all().filter((c) => selected.has(c.path)).every((c) => c.pinned);
    const bar = el("div", "feed-selection");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Selected notes");
    const button = (name: "x" | "archive" | "trash-2" | "pin" | "pin-off", label: string, run: () => void) => {
      const b = el("button", "feed-selection-button");
      b.type = "button";
      b.append(icon(name, "1.1em"), el("span", "", label));
      b.addEventListener("click", run);
      return b;
    };
    const paths = [...selected];
    bar.append(
      button("x", "Cancel", () => {
        this.selected = null;
        this.draw();
      }),
      el("span", "feed-selection-count", `${selected.size} selected`),
      button(allPinned ? "pin-off" : "pin", allPinned ? "Unpin" : "Pin", () => void this.act(allPinned ? "unpin" : "pin", paths)),
      button("archive", "Archive", () => void this.act("archive", paths)),
      button("trash-2", "Trash", () => void this.act("trash", paths)),
    );
    return bar;
  }
}
