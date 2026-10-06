// An edit of yours that clashes with someone else's in the same place: the two versions as a diff,
// and Keep mine (yours is saved over theirs, which stays in History) or Use theirs (the editor
// changes to theirs as an edit of yours, so `u` brings yours back).
import { runLines } from "./describe.ts";
import { focusFirst, openModal } from "./modal.ts";

export interface Clash {
  /** The note, as people see it. */
  where: string;
  /** Who made the other change: "Claude (for you)". */
  who: string;
  mine: string;
  theirs: string;
  keepMine(): void;
  useTheirs(): void;
  /** Where the keyboard goes back to when it closes: the note's editor, so u works at once. */
  returnTo(): HTMLElement | null;
  /**
   * When yours is an edit this browser kept that never reached the server (the page went first, or
   * it couldn't be sent): when it was kept, as "10:42 PM". It's offered to restore or discard.
   */
  keptAt?: string;
}

const KEEP = "Save your version over theirs. Theirs stays in History.";
const USE = "Put their version in the editor. u brings yours back.";
const RESTORE = "Save your edit over the note as it is now. The note as it is stays in History.";
const DISCARD = "Put the note as it is now in the editor. u brings your edit back.";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** When an edit was kept, to the minute: "10:42 PM" today, or its day before that. */
export function keptWhen(time: number, now = Date.now()): string {
  const d = new Date(time);
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function showClash(c: Clash): void {
  const title = c.keptAt ? `Unsaved edit from ${c.keptAt}` : "Your version and theirs";
  const modal = openModal({ label: title, className: "dialog clash", role: "alertdialog", returnTo: c.returnTo });
  const choose = (fn: () => void) => () => {
    modal.close();
    fn();
  };
  modal.box.append(
    el("h2", { textContent: title }),
    el("p", { textContent: c.keptAt ? `It never reached the server, and ${c.where} has changed since: ${c.who} made its latest change.` : `${c.who} changed ${c.where} in the same place you were editing.` }),
    el("p", { className: "clash-key" }, el("span", { className: "del", textContent: "− only in theirs" }), " ", el("span", { className: "add", textContent: "+ only in yours" })),
    el("pre", { className: "diff" }, ...runLines(c.theirs, c.mine).map((l) => el("span", { className: l.kind === "+" ? "add" : "del", textContent: `${l.kind} ${l.text}\n` }))),
    el(
      "div",
      { className: "dialog-actions" },
      el("button", { type: "button", className: "primary", textContent: c.keptAt ? "Restore" : "Keep mine", title: c.keptAt ? RESTORE : KEEP, onclick: choose(c.keepMine) }),
      el("button", { type: "button", textContent: c.keptAt ? "Discard" : "Use theirs", title: c.keptAt ? DISCARD : USE, onclick: choose(c.useTheirs) }),
      el("button", { type: "button", textContent: "Not now", onclick: () => modal.close() }),
    ),
  );
  focusFirst(modal, "button");
}
