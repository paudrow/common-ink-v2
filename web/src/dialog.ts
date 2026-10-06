// Dialogs the app asks you things in: an extension's permission prompt, confirming you trust an
// extension, and an address to install one from. Each is a modal (modal.ts): focus starts inside, Tab
// stays inside, Escape backs out, and focus goes back where it was.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Ask } from "../../worker/src/permissions.ts";
import type { Choice } from "./broker.ts";
import { openModal } from "./modal.ts";
import { askWords, capitalized, changeIn, nodes, scopeWords, triggerWords, type Phrase, type Trigger } from "./permission-words.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string | false | null | undefined)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...(children.filter((c) => c !== false && c !== null && c !== undefined) as (Node | string)[]));
  return node;
}

function focusable<T extends HTMLElement>(node: T, id: string): T {
  node.dataset.focus = id;
  return node;
}

/** Show a dialog until `settle` is called; resolve with what it was called with. */
function dialog<T>(label: string, build: (settle: (value: T) => void) => { body: HTMLElement[]; escape: T }, role: "dialog" | "alertdialog" = "alertdialog"): Promise<T> {
  return new Promise<T>((resolve) => {
    let value: T;
    const modal = openModal({ label, className: "dialog", role, onEscape: () => settle(escape), onClose: () => resolve(value) });
    const settle = (v: T) => {
      value = v;
      modal.close();
    };
    const { body, escape } = build(settle);
    modal.box.append(...body);
  });
}

/** Who's asking, as a prompt says: its name (to open its details), where it's from, and who made it. */
export interface Asker {
  name: string;
  /** "Built-in", "Workspace", "From URL", … */
  origin: string;
  publisher?: string;
  showDetails(): void;
}

/** A button that reads as a link, opening an extension's details on top. */
const detailsLink = (who: Asker, text: string, id: string) => focusable(el("button", { type: "button", className: "link", textContent: text, onclick: () => who.showDetails() }), id);

/**
 * "Boards wants to read the note This week", answering, in order: who's asking, what exactly (the
 * technical scope behind a Details disclosure), why now (what you did that it's acting on), and why at
 * all (its own reason, as it says it). Then Allow this time, Always allow, or Don't allow.
 */
export function askPermission(who: Asker, extension: ExtensionManifest, asks: Array<{ ask: Ask; key: string }>, joined: (fn: (a: { ask: Ask; key: string }) => void) => void, trigger: Trigger | null): Promise<Choice> {
  return dialog<Choice>(`${who.name} wants permission`, (settle) => {
    const body = el("div", { className: "prompt" });
    const draw = () => {
      // An answer covers the declared scope each ask falls in ("all your notes"), so Always allow says that.
      const scopes = [...new Map(asks.map((a) => [a.key, scopeWords(a.ask.kind, a.key.slice(a.ask.kind.length + 1) || undefined)])).values()];
      const always: Phrase = scopes.length === 1 ? [`Always allow ${who.name} to `, ...scopes[0]] : ["Always allow all of these"];
      const reasons = [...new Set(asks.map((a) => extension.permissions[a.ask.kind]?.why).filter((w): w is string => !!w))];
      const active = document.activeElement as HTMLElement | null;
      const focused = active && body.contains(active) ? active.dataset.focus : undefined;
      body.replaceChildren(
        el(
          "h2",
          {},
          detailsLink(who, who.name, "who"),
          " ",
          el("span", { className: "badge", textContent: who.origin }),
          who.publisher ? el("span", { className: "muted", textContent: ` by ${who.publisher}` }) : null,
          " wants to",
        ),
        el("ul", { className: "dialog-asks" }, ...asks.map(({ ask }) => el("li", {}, ...nodes(capitalized(askWords(ask)))))),
        el(
          "details",
          { className: "dialog-details" },
          el("summary", { textContent: "Details" }),
          el("ul", {}, ...asks.map(({ ask, key }) => el("li", {}, el("code", { textContent: `${ask.kind} ${ask.target ?? ask.scope ?? ""}`.trim() }), " · an answer covers ", el("code", { textContent: key })))),
        ),
        el("p", { className: "dialog-why-now" }, "It's asking ", ...nodes(triggerWords(trigger)), "."),
        ...reasons.map((why) => el("p", { className: "dialog-why" }, `${who.name} says: “${why}”`)),
        el(
          "div",
          { className: "dialog-actions" },
          focusable(el("button", { textContent: "Allow this time", title: "Until you reload the app", onclick: () => settle("once") }), "once"),
          focusable(el("button", { onclick: () => settle("always") }, ...nodes(always)), "always"),
          focusable(el("button", { textContent: "Don't allow", onclick: () => settle("deny") }), "deny"),
        ),
        el("p", { className: "dialog-note" }, "You can change this anytime in ", detailsLink(who, changeIn(who.name), "change"), "."),
      );
      if (focused) body.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus();
    };
    draw();
    // More from the same extension while this is up: one prompt, one answer for all of it.
    joined((a) => {
      asks = [...asks, a];
      draw();
    });
    return { body: [body], escape: "dismiss" };
  });
}

/** Yes or no, with what yes means spelled out. */
export function confirmDialog(title: string, text: string, yes: string, danger = false): Promise<boolean> {
  return dialog<boolean>(title, (settle) => ({
    body: [
      el("h2", { textContent: title }),
      el("p", { textContent: text }),
      // Something that can't be undone says so in red.
      el("div", { className: "dialog-actions" }, el("button", { textContent: "Cancel", onclick: () => settle(false) }), el("button", { textContent: yes, className: danger ? "danger" : "", onclick: () => settle(true) })),
    ],
    escape: false,
  }));
}

/** One line of text, or null if you back out. */
export function textDialog(title: string, text: string, placeholder: string, yes: string): Promise<string | null> {
  return dialog<string | null>(
    title,
    (settle) => {
      const input = el<HTMLInputElement>("input", { type: "url", placeholder, ariaLabel: title });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) settle(input.value.trim());
      });
      queueMicrotask(() => input.focus());
      return {
        body: [
          el("h2", { textContent: title }),
          el("p", { textContent: text }),
          input,
          el("div", { className: "dialog-actions" }, el("button", { textContent: "Cancel", onclick: () => settle(null) }), el("button", { textContent: yes, onclick: () => input.value.trim() && settle(input.value.trim()) })),
        ],
        escape: null,
      };
    },
    "dialog",
  );
}
