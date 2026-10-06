// Settings › This device: what the app thinks this device has and why, the keyboard switch (Auto, Yes,
// No) for when it guessed wrong, and the extensions that are on or off here other than by default, each
// with its override. It all comes from the device file, which "Open device.json" shows.
import { hereText, WIDTH_MIN, type Here, type KeyboardChoice, type Override } from "../../worker/src/devices.ts";
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Device } from "./device.ts";

export interface DeviceUiDeps {
  device: Device;
  /** Every installed extension, and whether it's on here. */
  extensions(): Array<{ manifest: ExtensionManifest; here: Here }>;
  setOverride(id: string, value: Override | undefined): Promise<void>;
  openFile(): void;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string | null | false)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...(children.filter((c) => c !== null && c !== false) as (Node | string)[]));
  return node;
}

function focusable<T extends HTMLElement>(node: T, id: string): T {
  node.dataset.focus = id;
  return node;
}

function select<V extends string>(label: string, value: V, choices: Array<[V, string]>, change: (v: V) => void, focus: string): HTMLSelectElement {
  const s = focusable(el<HTMLSelectElement>("select", { ariaLabel: label }, ...choices.map(([v, text]) => el("option", { value: v, textContent: text, selected: v === value }))), focus);
  s.addEventListener("change", () => change(s.value as V));
  return s;
}

/** A device in one line, as the Extensions view's box says it: "Phone · compact width (375px) · touch · keyboard: no (no key has been pressed yet)". */
export function deviceSummary(device: Device): string {
  const f = device.facts;
  return [
    device.file.name,
    `${f.width} width (${f.px}px)`,
    f.touch ? "touch" : "no touch",
    f.pointer === "fine" ? "mouse or trackpad" : "no mouse or trackpad",
    `keyboard: ${f.keyboard ? "yes" : "no"} (${device.why("keyboard")})`,
  ].join(" · ");
}

export function renderDevice(root: HTMLElement, deps: DeviceUiDeps): void {
  const { device } = deps;
  const f = device.facts;
  const fact = (label: string, value: string, why: string, control?: HTMLElement) =>
    el("div", { className: "device-fact" }, el("dt", { textContent: label }), el("dd", {}, el("span", { textContent: value }), el("span", { className: "device-why", textContent: why }), control ?? null));
  const keyboard = select<KeyboardChoice>("Keyboard", device.file.keyboard, [["auto", "Auto"], ["yes", "Yes"], ["no", "No"]], (v) => void device.setKeyboard(v), "device:keyboard");
  const special = deps.extensions().filter((x) => x.here.by !== "default" || device.override(x.manifest.id));
  root.append(
    el(
      "section",
      { className: "device-panel" },
      el(
        "p",
        { className: "settings-level" },
        "What this device has decides which extensions are on here. The app works it out; when it's wrong, say so here. ",
        device.path ? "It's kept in this device's file, with history, so your agents can read it too." : "Sign in to keep it: until then it lasts as long as the page.",
      ),
      el(
        "div",
        { className: "device-head" },
        el("h3", { textContent: device.file.name }),
        device.path ? el("code", { className: "setting-key", textContent: device.path }) : null,
        device.path ? focusable(el("button", { textContent: "Open device.json", onclick: () => deps.openFile() }), "device:file") : null,
      ),
      el(
        "dl",
        { className: "device-facts" },
        fact("Width", `${f.width}, ${f.px}px`, `${device.why("width")}. Tabs need ${WIDTH_MIN.medium}px, windows side by side ${WIDTH_MIN.expanded}px.`),
        fact("Pointer", f.pointer === "fine" ? "Mouse or trackpad" : "Touch only", device.why("pointer")),
        fact("Touch", f.touch ? "Yes" : "No", device.why("touch")),
        fact("Keyboard", f.keyboard ? "Yes" : "No", device.why("keyboard"), keyboard),
      ),
      el("h3", { className: "device-sub", textContent: "Extensions on this device" }),
      special.length
        ? el(
            "ul",
            { className: "device-extensions" },
            ...special.map(({ manifest: m, here }) =>
              el(
                "li",
                {},
                el("span", { className: "extension-name", textContent: m.name }),
                el("span", { className: "device-why", textContent: hereText(here) ?? "On" }),
                select<"auto" | Override>(`${m.name} on this device`, device.override(m.id) ?? "auto", [["auto", "Auto"], ["on", "On here"], ["off", "Off here"]], (v) => void deps.setOverride(m.id, v === "auto" ? undefined : v), `device:ext:${m.id}`),
              ),
            ),
          )
        : el("p", { className: "device-why", textContent: "Every extension that's on is on here too. Turn one off here, or on whatever it needs, from its details in the Extensions view." }),
    ),
  );
}
