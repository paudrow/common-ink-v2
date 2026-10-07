// The Feed's view: cards, newest change first, under date groups, read a page at a time as you scroll.
// By touch a card swipes (common-ink/swipe) to archive or trash it, as the feed.swipe settings say, and a
// long press starts a selection that the bar at the bottom acts on. Changes that arrive while you're
// scrolled down don't move the list: a pill says how many, and a tap on it brings them in at the top.
import type { Author, FilePath } from "common-ink/files";
import { icon } from "common-ink/icons";
import { swipeable, type SwipeAction } from "common-ink/swipe";
import { dateGroup, previewLines, type PreviewLine } from "./cards.ts";

/** A note as the Feed lists it: what search says of it, and its first lines once they're read. */
export interface Card {
  path: FilePath;
  title: string;
  edited: number;
  author: Author;
  lines?: PreviewLine[];
}

export type SwipeChoice = "archive" | "trash" | "none";

export interface FeedEnv {
  /** A page of cards, in the Feed's order, and how many there are in all. */
  page(offset: number, limit: number): Promise<{ cards: Card[]; total: number }>;
  /** A note's text, for its card's lines. */
  text(path: FilePath): Promise<string>;
  open(path: FilePath): void;
  archive(paths: FilePath[]): Promise<boolean>;
  trash(paths: FilePath[]): Promise<boolean>;
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

const ACTIONS: Record<Exclude<SwipeChoice, "none">, { label: string; tone: string }> = {
  archive: { label: "Archive", tone: "archive" },
  trash: { label: "Trash", tone: "delete" },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class FeedView {
  private cards: Card[] = [];
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
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.selected) {
        this.selected = null;
        this.draw();
        e.stopPropagation();
      }
    });
  }

  /** Draw into the view's box: the cards as they were, where you were, and read again from the top. */
  render(box: HTMLElement): void {
    if (this.box !== box) {
      this.box?.removeEventListener("scroll", this.remember);
      this.box = box;
      box.addEventListener("scroll", this.remember, { passive: true });
    }
    box.classList.add("feed-box");
    if (this.root.parentElement !== box) box.replaceChildren(this.root);
    this.draw();
    box.scrollTop = this.scroll;
    void (this.loaded ? this.refresh() : this.reload());
  }

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
      const known = new Map(this.cards.map((c) => [c.path, c]));
      await Promise.all(
        found.map(async (c) => {
          const was = known.get(c.path);
          c.lines = was && was.edited === c.edited && was.lines ? was.lines : previewLines(await this.env.text(c.path).catch(() => ""));
        }),
      );
      if (turn !== this.generation) return;
      this.cards = fromTop ? found : [...this.cards, ...found.filter((c) => !known.has(c.path))];
      this.total = total;
      this.loaded = true;
      if (this.selected) this.selected = new Set([...this.selected].filter((p) => this.cards.some((c) => c.path === p)));
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

  /** Archive or trash cards, taking them out at once when it's done. */
  private async act(kind: "archive" | "trash", paths: FilePath[]) {
    this.ownChanges(paths);
    const done = await (kind === "archive" ? this.env.archive(paths) : this.env.trash(paths));
    if (!done) return;
    const gone = new Set<string>(paths);
    this.cards = this.cards.filter((c) => !gone.has(c.path));
    this.total = Math.max(0, this.total - paths.length);
    this.selected = null;
    this.draw();
  }

  private swipeAction(side: "right" | "left", card: Card): SwipeAction | undefined {
    const choice = this.env.swipe(side);
    if (choice === "none") return undefined;
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
    if (this.loaded && !this.cards.length && !this.problem) {
      const empty = el("div", "feed-empty");
      empty.append(el("b", "", "Inbox zero for notes."), el("span", "", " Everything is archived or in Trash."));
      parts.push(empty);
    }
    const list = el("div", "feed-list");
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
    if (this.loaded && this.cards.length) {
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
    this.root.replaceChildren(...parts);
  }

  private cardEl(card: Card): HTMLElement {
    const li = el("li", "feed-card");
    li.dataset.path = card.path;
    const picked = this.selected?.has(card.path) ?? false;
    if (picked) li.classList.add("picked");
    const body = el("button", "feed-card-body");
    body.type = "button";
    const top = el("span", "feed-card-top");
    const folder = card.path.includes("/") ? card.path.slice(0, card.path.lastIndexOf("/")) : "";
    top.append(el("span", "feed-card-title", card.title), folder ? el("span", "feed-card-folder", folder) : "", el("span", "feed-card-when", this.env.when(card.edited)));
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
      else this.env.open(card.path);
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
    const bar = el("div", "feed-selection");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Selected notes");
    const button = (name: "x" | "archive" | "trash-2", label: string, run: () => void) => {
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
      button("archive", "Archive", () => void this.act("archive", paths)),
      button("trash-2", "Trash", () => void this.act("trash", paths)),
    );
    return bar;
  }
}
