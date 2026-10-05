// Dialogs the app asks you things in: an extension's permission prompt, confirming you trust an
// extension, and an address to install one from. Each is modal and keyboard-first: focus starts on the
// first choice, Tab stays inside, Escape backs out, and focus goes back where it was.
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Ask } from "../../worker/src/permissions.ts";
import { describeAsk, type Choice } from "./broker.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** Show a dialog until `settle` is called; resolve with what it was called with. */
function modal<T>(build: (settle: (value: T) => void) => { body: HTMLElement[]; escape: T }): Promise<T> {
  const returnTo = document.activeElement as HTMLElement | null;
  return new Promise<T>((resolve) => {
    const box = el("div", { className: "dialog", role: "alertdialog", ariaModal: "true" });
    const scrim = el("div", { className: "dialog-scrim" }, box);
    const settle = (value: T) => {
      scrim.remove();
      returnTo?.focus();
      resolve(value);
    };
    const { body, escape } = build(settle);
    box.append(...body);
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(escape);
      }
      // Tab stays in the dialog.
      if (e.key === "Tab") {
        const stops = [...box.querySelectorAll<HTMLElement>("button, input")];
        const at = stops.indexOf(document.activeElement as HTMLElement);
        const to = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at + 1) % stops.length;
        e.preventDefault();
        stops[to]?.focus();
      }
    });
    document.body.append(scrim);
    box.querySelector<HTMLElement>("input, button")?.focus();
  });
}

/** "Weather wants to connect to api.weather.gov: Fetch forecasts". Allow once, Always allow, or Don't allow. */
export function askPermission(extension: ExtensionManifest, asks: Array<{ ask: Ask; key: string }>, joined: (fn: (a: { ask: Ask; key: string }) => void) => void): Promise<Choice> {
  return modal<Choice>((settle) => {
    // The answer covers the declared scope the ask falls in ("Journal/**"), so that's what's shown.
    const item = ({ ask, key }: { ask: Ask; key: string }) =>
      el("li", {}, el("strong", { textContent: describeAsk({ kind: ask.kind, scope: key.slice(ask.kind.length + 1) || undefined }) }), el("span", { textContent: ` · ${extension.permissions[ask.kind]?.why ?? ""}` }));
    const list = el("ul", { className: "dialog-asks" }, ...asks.map(item));
    // More from the same extension while this is up: one prompt, one answer for all of it.
    joined((a) => list.append(item(a)));
    return {
      body: [
        el("h2", { textContent: `${extension.name} wants to` }),
        list,
        el("p", { className: "dialog-note", textContent: "You can change your answer later in the Extensions view." }),
        el(
          "div",
          { className: "dialog-actions" },
          el("button", { textContent: "Allow once", onclick: () => settle("once") }),
          el("button", { textContent: "Always allow", onclick: () => settle("always") }),
          el("button", { textContent: "Don't allow", onclick: () => settle("deny") }),
        ),
      ],
      escape: "dismiss",
    };
  });
}

/** Yes or no, with what yes means spelled out. */
export function confirmDialog(title: string, text: string, yes: string): Promise<boolean> {
  return modal<boolean>((settle) => ({
    body: [
      el("h2", { textContent: title }),
      el("p", { textContent: text }),
      el("div", { className: "dialog-actions" }, el("button", { textContent: "Cancel", onclick: () => settle(false) }), el("button", { textContent: yes, onclick: () => settle(true) })),
    ],
    escape: false,
  }));
}

/** One line of text, or null if you back out. */
export function textDialog(title: string, text: string, placeholder: string, yes: string): Promise<string | null> {
  return modal<string | null>((settle) => {
    const input = el<HTMLInputElement>("input", { type: "url", placeholder, ariaLabel: title });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) settle(input.value.trim());
    });
    return {
      body: [
        el("h2", { textContent: title }),
        el("p", { textContent: text }),
        input,
        el("div", { className: "dialog-actions" }, el("button", { textContent: "Cancel", onclick: () => settle(null) }), el("button", { textContent: yes, onclick: () => input.value.trim() && settle(input.value.trim()) })),
      ],
      escape: null,
    };
  });
}
