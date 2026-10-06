// The Trash view: each deleted note, newest first, with who deleted it, when, and the days it has left
// as a bar that turns red in the last three. Restore with r, the row's button, or a swipe right. ↵ or a
// tap looks inside: the note's last version, read-only.
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
  /** The note's text as it was before it was deleted. */
  lastVersion(item: Trashed): Promise<string>;
}

export class TrashView {
  private items: Trashed[] = [];
  private selected = 0;
  private open: string | null = null;
  private root: HTMLElement | null = null;

  constructor(private env: TrashEnv) {}

  show(items: Trashed[]) {
    // The same Trash again (a change elsewhere was saved): leave the rows be, so a swipe under way goes on.
    const key = (list: Trashed[]) => list.map((i) => `${i.revision}:${i.daysLeft}`).join(",");
    if (key(items) === key(this.items) && this.root?.isConnected) return;
    this.items = items;
    this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
    if (this.root) this.render(this.root);
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
      const list = document.createElement("ul");
      list.className = "trash-list";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Trash");
      this.items.forEach((item, i) => list.append(this.row(item, i)));
      view.append(list);
    }
    root.replaceChildren(view);
    if (focused) view.focus();
  }

  private row(item: Trashed, i: number): HTMLElement {
    const li = document.createElement("li");
    li.className = "trash-row";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === this.selected));
    li.dataset.path = item.path;
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
    text.addEventListener("click", () => {
      this.selected = i;
      void this.lookInside(item);
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
    body.append(text, left, restore);
    li.append(body);
    if (this.open === item.path) {
      const peek = document.createElement("pre");
      peek.className = "trash-peek";
      peek.textContent = "…";
      void this.env.lastVersion(item).then((t) => (peek.textContent = t || "(empty)"));
      li.append(peek);
    }
    swipeable(li, body, { right: { label: "Restore", tone: "restore", run: () => this.env.restore(item) } });
    return li;
  }

  private lookInside(item: Trashed) {
    this.open = this.open === item.path ? null : item.path;
    if (this.root) this.render(this.root);
  }

  private key(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || !this.items.length) return;
    const item = this.items[this.selected];
    const moves: Record<string, number> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
    if (moves[e.key]) {
      this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + moves[e.key]));
      if (this.root) this.render(this.root);
      this.root?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "r") void this.env.restore(item);
    else if (e.key === "Enter") this.lookInside(item);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
}
