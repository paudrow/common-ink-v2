// What ticking a task did, said at once and out of the way: a stack of small notices at the bottom of
// the window, newest last, each with its actions (Undo, Open log) and a close. They don't take focus;
// Tab reaches them, Escape closes the focused one, and each goes after a while unless it's hovered or
// focused. Screen readers hear each as it comes.
import { el, icon } from "./dom.ts";

/** At most this many show; the oldest goes when another comes. */
const MAX = 3;
const STAYS_MS = 8000;

let region: HTMLElement | null = null;

function stack(): HTMLElement {
  if (region?.isConnected) return region;
  region = el("div", { class: "task-toasts", role: "region", "aria-label": "Task notices" });
  document.body.append(region);
  return region;
}

/** Show a notice; returns how to take it away. */
export function toast(message: string, actions: Array<{ label: string; run(): unknown }> = []): () => void {
  const root = stack();
  const close = () => {
    clearTimeout(timer);
    box.remove();
  };
  const buttons = actions.map((a) => el("button", { type: "button", class: "task-toast-action", onclick: () => (close(), void a.run()) }, a.label));
  const box = el(
    "div",
    { class: "task-toast", role: "status", "aria-live": "polite" },
    el("span", { class: "task-toast-text" }, message),
    ...buttons,
    el("button", { type: "button", class: "task-toast-close", title: "Close", "aria-label": "Close", onclick: close }, icon("close", 12)),
  );
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  });
  let timer = 0;
  const wait = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => (box.matches(":hover, :focus-within") ? wait() : close()), STAYS_MS);
  };
  root.append(box);
  while (root.children.length > MAX) root.firstElementChild!.remove();
  wait();
  return close;
}
