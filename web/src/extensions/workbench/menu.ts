// A context menu: a short list of actions at the pointer, worked by mouse or keyboard (arrows or
// Ctrl-N and Ctrl-P to move, Enter or Space to choose, Escape to close).
import { matchKeys } from "common-ink/keys";

export interface MenuItem {
  label: string;
  /** The shortcut that does the same, as shown (⌘\, say). */
  detail?: string;
  disabled?: boolean;
  run(): unknown;
}

/** A line between groups of items. */
export const SEPARATOR = null;

let open: { root: HTMLElement; close: () => void } | null = null;

export function showMenu(x: number, y: number, items: Array<MenuItem | typeof SEPARATOR>): void {
  open?.close();
  const returnFocus = document.activeElement as HTMLElement | null;
  const root = document.createElement("div");
  root.className = "menu";
  root.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === SEPARATOR) {
      const hr = document.createElement("div");
      hr.className = "separator";
      hr.setAttribute("role", "separator");
      root.append(hr);
      continue;
    }
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.disabled = !!item.disabled;
    b.setAttribute("aria-disabled", String(!!item.disabled));
    const label = document.createElement("span");
    label.textContent = item.label;
    b.append(label);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = item.detail;
      b.append(detail);
    }
    b.addEventListener("click", () => {
      close();
      void item.run();
    });
    buttons.push(b);
    root.append(b);
  }
  const enabled = () => buttons.filter((b) => !b.disabled);
  const move = (by: number) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(at + by + list.length) % list.length]?.focus();
  };
  const close = () => {
    root.remove();
    document.removeEventListener("pointerdown", outside, true);
    open = null;
    returnFocus?.focus();
  };
  const outside = (e: Event) => {
    if (!root.contains(e.target as Node)) close();
  };
  root.addEventListener("keydown", (e) => {
    if (matchKeys(e, "ArrowDown") || matchKeys(e, "Ctrl-n")) move(1);
    else if (matchKeys(e, "ArrowUp") || matchKeys(e, "Ctrl-p")) move(-1);
    else if (matchKeys(e, "Home")) enabled()[0]?.focus();
    else if (matchKeys(e, "End")) enabled().at(-1)?.focus();
    else if (matchKeys(e, "Escape") || matchKeys(e, "Tab")) close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.body.append(root);
  // Keep it on screen.
  const box = root.getBoundingClientRect();
  root.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
  root.style.top = `${Math.max(4, Math.min(y, innerHeight - box.height - 4))}px`;
  document.addEventListener("pointerdown", outside, true);
  open = { root, close };
  enabled()[0]?.focus();
}
