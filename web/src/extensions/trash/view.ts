// The Trash view: each deleted note, newest first, with who deleted it, when, and the days it has left
// as a bar that turns red in the last three. Restore with r, the row's button, or a swipe right; delete
// forever with D, its button, or a swipe left, which asks first, as Empty Trash does. ↵ or a tap looks
// inside: the note's last version, read-only, with Restore and Delete forever. Rows are known by their delete's
// revision, so a list that changes under you never moves the selection to another note.
import { ago, describeAuthor } from "common-ink/describe";
import { icon } from "common-ink/icons";
import type { Author } from "../../../../worker/src/files.ts";
import { swipeable } from "./swipe.ts";

/** A note in Trash, as the trash operation lists it. */
export interface Trashed {
  path: string;
  title: string;
  revision: number;
  before: number;
  author: Author;
  time: number;
  daysLeft: number;
}

export interface TrashEnv {
  me: string | undefined;
  retentionDays(): number;
  restore(item: Trashed): unknown;
  /** Purge it, once the person says so. */
  deleteForever(item: Trashed): unknown;
  /** Purge everything in Trash, once the person says so. */
  empty(): unknown;
  /** The note's text as it was before it was deleted. */
  lastVersion(item: Trashed): Promise<string>;
}

export class TrashView {
  private items: Trashed[] = [];
  /** The selected note and the one open to look inside, by their delete's revision. */
  private selected: number | null = null;
  private open: number | null = null;
  private root: HTMLElement | null = null;
  /** A list that came while a row was being swiped: drawn once the finger lifts. */
  private waiting: Trashed[] | null = null;

  constructor(private env: TrashEnv) {}

  show(items: Trashed[]) {
    // The same Trash again (a change elsewhere was saved): leave the rows be.
    const key = (list: Trashed[]) => list.map((i) => `${i.revision}:${i.daysLeft}`).join(",");
    if (key(items) === key(this.items) && this.root?.isConnected) return;
    // A swipe under way keeps its row until it ends.
    if (this.root?.querySelector(".trash-row[data-swipe]:not([data-swipe=''])")) {
      if (!this.waiting) document.addEventListener("pointerup", () => setTimeout(() => this.waiting && this.show(this.waiting)), { once: true });
      this.waiting = items;
      return;
    }
    this.waiting = null;
    this.items = items;
    if (!items.some((i) => i.revision === this.selected)) this.selected = items[0]?.revision ?? null;
    if (this.root) this.render(this.root);
  }

  private index(): number {
    return Math.max(0, this.items.findIndex((i) => i.revision === this.selected));
  }

  render(root: HTMLElement) {
    this.root = root;
    const view = document.createElement("div");
    view.className = "trash-view";
    view.tabIndex = 0;
    view.addEventListener("keydown", (e) => this.key(e));
    const focused = root.contains(document.activeElement);
    if (!this.items.length) {
      const empty = document.createElement("p");
      empty.className = "trash-empty";
      empty.textContent = `Trash is empty. Deleted notes stay here for ${this.env.retentionDays()} days, then they're purged.`;
      view.append(empty);
    } else {
      const top = document.createElement("div");
      top.className = "trash-top";
      const count = document.createElement("span");
      count.textContent = `${this.items.length} ${this.items.length === 1 ? "note" : "notes"}, each deleted forever ${this.env.retentionDays()} days after it was deleted`;
      const empty = document.createElement("button");
      empty.type = "button";
      empty.className = "trash-empty-all";
      empty.append(icon("trash-2", 14), "Empty Trash");
      empty.addEventListener("click", () => void this.env.empty());
      top.append(count, empty);
      view.append(top);
      const list = document.createElement("ul");
      list.className = "trash-list";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Trash");
      this.items.forEach((item) => list.append(this.row(item)));
      view.append(list);
    }
    root.replaceChildren(view);
    if (focused) view.focus();
  }

  private row(item: Trashed): HTMLElement {
    const li = document.createElement("li");
    li.className = "trash-row";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(item.revision === this.selected));
    li.dataset.path = item.path;
    li.dataset.revision = String(item.revision);
    const body = document.createElement("div");
    body.className = "trash-row-body";
    const text = document.createElement("button");
    text.type = "button";
    text.className = "trash-look";
    const title = document.createElement("span");
    title.className = "trash-title";
    title.textContent = item.title;
    const detail = document.createElement("span");
    detail.className = "trash-detail";
    detail.textContent = `${item.path} · deleted by ${describeAuthor(item.author, this.env.me)}, ${ago(item.time)}`;
    text.append(title, detail);
    // A mouse dragged across the row (to select its text, say) isn't a click on it.
    let down: { x: number; y: number } | null = null;
    text.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
    text.addEventListener("click", (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
      this.selected = item.revision;
      this.lookInside(item);
    });
    const left = document.createElement("span");
    left.className = "trash-left";
    left.classList.toggle("soon", item.daysLeft <= 3);
    const bar = document.createElement("span");
    bar.className = "trash-bar";
    bar.style.setProperty("--left", String(Math.min(1, item.daysLeft / this.env.retentionDays())));
    left.append(bar, `${item.daysLeft} ${item.daysLeft === 1 ? "day" : "days"}`);
    left.title = `Purged in ${item.daysLeft} ${item.daysLeft === 1 ? "day" : "days"}: its text leaves history`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "trash-restore";
    restore.title = `Restore ${item.title}`;
    restore.setAttribute("aria-label", restore.title);
    restore.append(icon("rotate-ccw"));
    restore.addEventListener("click", () => void this.env.restore(item));
    const forever = document.createElement("button");
    forever.type = "button";
    forever.className = "trash-delete";
    forever.title = `Delete ${item.title} forever`;
    forever.setAttribute("aria-label", forever.title);
    forever.append(icon("trash-2"));
    forever.addEventListener("click", () => void this.env.deleteForever(item));
    body.append(text, left, restore, forever);
    li.append(body);
    if (this.open === item.revision) {
      const inside = document.createElement("div");
      inside.className = "trash-inside";
      const peek = document.createElement("pre");
      peek.className = "trash-peek";
      peek.textContent = "…";
      void this.env.lastVersion(item).then((t) => (peek.textContent = t || "(empty)"));
      const actions = document.createElement("div");
      actions.className = "trash-actions";
      const back = document.createElement("button");
      back.type = "button";
      back.append(icon("rotate-ccw", 14), "Restore");
      back.addEventListener("click", () => void this.env.restore(item));
      const gone = document.createElement("button");
      gone.type = "button";
      gone.className = "danger";
      gone.append(icon("trash-2", 14), "Delete forever");
      gone.addEventListener("click", () => void this.env.deleteForever(item));
      actions.append(back, gone);
      inside.append(peek, actions);
      li.append(inside);
    }
    swipeable(li, body, {
      right: { label: "Restore", tone: "restore", run: () => this.env.restore(item) },
      left: { label: "Delete forever", tone: "delete", run: () => this.env.deleteForever(item) },
    });
    return li;
  }

  private lookInside(item: Trashed) {
    this.open = this.open === item.revision ? null : item.revision;
    if (this.root) this.render(this.root);
  }

  private key(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || !this.items.length) return;
    const item = this.items[this.index()];
    const moves: Record<string, number> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
    if (moves[e.key]) {
      this.selected = this.items[Math.max(0, Math.min(this.items.length - 1, this.index() + moves[e.key]))].revision;
      if (this.root) this.render(this.root);
      this.root?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "r") void this.env.restore(item);
    else if (e.key === "D") void this.env.deleteForever(item);
    else if (e.key === "Enter") this.lookInside(item);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
}
