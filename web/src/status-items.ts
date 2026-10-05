// Extensions' items in the status bar (contributes.statusBarItems): each declared in its manifest with
// a side and a priority, placed when the app loads, and empty (so hidden) until its extension sets it.
import type { StatusBarItemContribution } from "../../worker/src/extensions.ts";

export class StatusItems {
  private items = new Map<string, { el: HTMLElement; owner: string }>();

  constructor(
    private left: HTMLElement,
    private right: HTMLElement,
    private run: (command: string) => void,
  ) {}

  /** Place every declared item, highest priority outermost, as VS Code does. Items already placed are left alone. */
  declare(items: ReadonlyArray<StatusBarItemContribution & { owner: string }>): void {
    const sorted = [...items].sort((a, b) => b.priority - a.priority);
    for (const item of sorted) {
      if (this.items.has(item.id)) continue;
      const el = document.createElement(item.command ? "button" : "span");
      el.className = "status-item";
      el.dataset.item = item.id;
      el.hidden = true;
      if (item.command) el.addEventListener("click", () => this.run(item.command!));
      if (item.alignment === "left") this.left.append(el);
      else this.right.prepend(el);
      this.items.set(item.id, { el, owner: item.owner });
    }
  }

  /** Show `text` in an item `owner` declared, or hide it with "". */
  set(owner: string, id: string, text: string, tooltip?: string): void {
    const item = this.items.get(id);
    if (!item || item.owner !== owner) throw new Error(`Status bar item "${id}" isn't declared in ${owner}'s contributes.statusBarItems`);
    item.el.textContent = text;
    item.el.hidden = !text;
    if (tooltip) item.el.title = tooltip;
    else item.el.removeAttribute("title");
  }
}
