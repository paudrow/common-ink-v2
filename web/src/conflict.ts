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
}

const KEEP = "Save your version over theirs. Theirs stays in History.";
const USE = "Put their version in the editor. u brings yours back.";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

export function showClash(c: Clash): void {
  const modal = openModal({ label: "Your version and theirs", className: "dialog clash", role: "alertdialog", returnTo: c.returnTo });
  const choose = (fn: () => void) => () => {
    modal.close();
    fn();
  };
  modal.box.append(
    el("h2", { textContent: "Your version and theirs" }),
    el("p", { textContent: `${c.who} changed ${c.where} in the same place you were editing.` }),
    el("p", { className: "clash-key" }, el("span", { className: "del", textContent: "− only in theirs" }), " ", el("span", { className: "add", textContent: "+ only in yours" })),
    el("pre", { className: "diff" }, ...runLines(c.theirs, c.mine).map((l) => el("span", { className: l.kind === "+" ? "add" : "del", textContent: `${l.kind} ${l.text}\n` }))),
    el(
      "div",
      { className: "dialog-actions" },
      el("button", { type: "button", className: "primary", textContent: "Keep mine", title: KEEP, onclick: choose(c.keepMine) }),
      el("button", { type: "button", textContent: "Use theirs", title: USE, onclick: choose(c.useTheirs) }),
      el("button", { type: "button", textContent: "Not now", onclick: () => modal.close() }),
    ),
  );
  focusFirst(modal, "button");
}
