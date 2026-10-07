// The settings editor: every setting in the catalog, the app's and each extension's in its own
// section, searchable, with the right control for its type. It's a view of the JSON files, which stay
// the source of truth: a change here writes just that one key, as an ordinary change, and Reset
// removes the key.
import type { FilePath, Revision, WriteResult } from "../../worker/src/files.ts";
import { settingProblem, type SettingDeclaration, type SettingsCatalog } from "../../worker/src/settings.ts";
import { setTopLevelKey } from "./json-edit.ts";
import type { View } from "./workbench.ts";

export type Level = "user" | "workspace";

/** What the switch at the top shows: a level of settings, or this device. */
export type Shown = Level | "device";

export const SETTINGS_VIEW = "settings";

export interface SettingsUiDeps {
  pathFor(level: Level): FilePath | null;
  read(path: FilePath): Promise<{ text: string; revision: Revision }>;
  write(path: FilePath, text: string, base: Revision): Promise<WriteResult>;
  /** Every setting there is: the app's and installed extensions'. */
  catalog(): SettingsCatalog;
  openJson(level: Level): void;
  /** A settings file changed: apply it. */
  changed(): void;
  /** Settings › This device: drawn by the device's own panel (device-ui.ts). */
  device?(root: HTMLElement): void;
}

interface Property {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  appliesAfterReload?: boolean;
}

/** "editor.fontSize" → section "Editor", title "Font size". */
export function describeKey(key: string): { section: string; title: string } {
  const [head, ...rest] = key.split(".");
  const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { section: cap(words(head)), title: cap(words(rest.length ? rest.join(" ") : head)) };
}

/** A setting's section and title as the editor shows them: an extension's settings under its section. */
function placeOf(d: SettingDeclaration): { section: string; title: string } {
  return { section: d.section, title: describeKey(d.key).title };
}

/** A declaration as the controls read it: its JSON Schema with its description and default. */
const propertyOf = (d: SettingDeclaration): Property => ({ ...(d.schema as Property), description: d.description, default: d.default, appliesAfterReload: d.reload });

/** The settings file to start from when there isn't one. */
const EMPTY = `{\n  "$schema": "/schema/settings.json"\n}\n`;

/** One key set (or removed, with undefined) in a settings file's text. Null if the file isn't a JSON object. */
export const withSetting = (text: string, key: string, value: unknown) => setTopLevelKey(text.trim() ? text : EMPTY, key, value);

/**
 * Change one key of a settings file from what that file has for it (not the settings combined from all
 * of them, which take the whole key from one file), as one change; nothing when it comes out the same.
 * If the file changes in between, it's read again and the change made again.
 */
export async function editSetting(io: Pick<SettingsUiDeps, "read" | "write">, path: FilePath, key: string, change: (current: unknown) => unknown): Promise<void> {
  for (let tries = 0; tries < 3; tries++) {
    const latest = await io.read(path);
    let current: unknown;
    try {
      current = latest.text.trim() ? (JSON.parse(latest.text) as Record<string, unknown>)[key] : undefined;
    } catch {
      return;
    }
    const value = change(current);
    if (JSON.stringify(value) === JSON.stringify(current)) return;
    const text = withSetting(latest.text, key, value);
    if (text === null || text === latest.text) return;
    const result = await io.write(path, text, latest.revision);
    if (result.status !== "conflict") return;
  }
}

/**
 * Write one key of a settings file (or remove it, with undefined), on top of whatever the file says
 * now, as one change. If the file changes in between, it's read again and the key applied again.
 */
export async function writeSetting(io: Pick<SettingsUiDeps, "read" | "write">, path: FilePath, key: string, value: unknown): Promise<void> {
  for (let tries = 0; tries < 3; tries++) {
    const latest = await io.read(path);
    const text = withSetting(latest.text, key, value);
    if (text === null || text === latest.text) return;
    const result = await io.write(path, text, latest.revision);
    if (result.status !== "conflict") return;
  }
}

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** Marks a control so the keyboard comes back to it when the view is drawn again. */
function focusable<T extends HTMLElement>(node: T, id: string): T {
  node.dataset.focus = id;
  return node;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** What each level is, said under the switch and on it. */
const ABOUT: Record<Level, string> = {
  user: "Your settings, in every workspace. This workspace's settings win over them.",
  workspace: "This workspace's settings, for everyone in it. They win over each person's own.",
};

/** A settings file's settings, and whether it's broken (not a JSON object). */
async function valuesIn(deps: SettingsUiDeps, path: FilePath | null): Promise<{ values: Record<string, unknown>; broken: boolean }> {
  const file = path ? await deps.read(path) : { text: "", revision: 0 };
  try {
    const data: unknown = file.text.trim() ? JSON.parse(file.text) : {};
    if (data && typeof data === "object" && !Array.isArray(data)) return { values: data as Record<string, unknown>, broken: false };
  } catch {
    // Not JSON: broken, below.
  }
  return { values: {}, broken: true };
}

/** The settings editor, one view with a User | Workspace switch, as in VSCode. Set `level` (and `query`, to search) before showing it. */
export function settingsEditor(deps: SettingsUiDeps): View & { level: Shown; query: string } {
  /** Why the last change didn't save, shown once. */
  let failed = "";
  /** The latest drawing of each element the editor is drawn in. */
  const drawings = new WeakMap<HTMLElement, number>();
  const view = {
    id: SETTINGS_VIEW,
    title: "Settings",
    level: "user" as Shown,
    query: "",
    async render(root: HTMLElement) {
      // Each drawing is the latest: one still reading its files when another starts (This device picked
      // while User was being read) gives way, rather than drawing over it when its reads come back.
      const turn = (drawings.get(root) ?? 0) + 1;
      drawings.set(root, turn);
      const shown = view.level;
      if (shown === "device") return renderDeviceLevel(root);
      const level = shown;
      // It's drawn again after every change: keep the keyboard where it was.
      const active = document.activeElement as HTMLElement | null;
      const focusId = active && root.contains(active) ? active.dataset.focus : undefined;
      const path = deps.pathFor(level);
      const { values, broken } = await valuesIn(deps, path);
      // The other level, to say where a value that isn't set here comes from, or what wins over it.
      const user = level === "user" ? values : (await valuesIn(deps, deps.pathFor("user"))).values;
      const workspace = level === "workspace" ? values : (await valuesIn(deps, deps.pathFor("workspace"))).values;
      if (drawings.get(root) !== turn) return;

      const set = async (key: string, value: unknown) => {
        if (!path) return;
        try {
          await writeSetting(deps, path, key, value);
        } catch (err) {
          failed = `Not saved: ${(err as Error).message}. Try again when you're back online.`;
        }
        deps.changed();
      };

      const levelSwitch = switchOf(root, level);
      const search = focusable(el<HTMLInputElement>("input", { type: "search", className: "search", placeholder: "Search settings", value: view.query, ariaLabel: "Search settings" }), "search");
      search.addEventListener("input", () => {
        view.query = search.value;
        filter();
      });
      const toJson = focusable(el("button", { className: "to-json", textContent: "Open JSON", title: "Edit this settings file as JSON", onclick: () => deps.openJson(level) }), "json");

      const sections = new Map<string, HTMLElement[]>();
      for (const d of deps.catalog().values()) {
        const { key } = d;
        const prop = propertyOf(d);
        const { section, title } = placeOf(d);
        const here = Object.hasOwn(values, key);
        // What this level has: its own value; or, in workspace settings, yours; or the default.
        const inherited = level === "workspace" && !here && Object.hasOwn(user, key);
        const current = here ? values[key] : inherited ? user[key] : d.default;
        const overridden = level === "user" && Object.hasOwn(workspace, key);
        const note = inherited
          ? `Not set here: your user setting, ${show(user[key])}, applies.`
          : overridden
            ? `This workspace sets it to ${show(workspace[key])}, which wins here.`
            : "";
        const row = el(
          "div",
          { className: `setting${here ? " modified" : ""}` },
          el(
            "div",
            { className: "setting-head" },
            el("span", { className: "setting-title", textContent: title }),
            el("code", { className: "setting-key", textContent: key }),
            prop.appliesAfterReload ? el("span", { className: "badge reload", textContent: "Applies after reload" }) : "",
            here ? el("span", { className: "badge", textContent: "Modified", title: `Set in ${level} settings` }) : "",
            here ? focusable(el("button", { className: "reset", textContent: "Reset", title: `Remove "${key}" from ${level} settings`, onclick: () => void set(key, undefined) }), `reset:${key}`) : "",
          ),
          el("p", { className: "setting-desc", textContent: prop.description ?? "" }),
          note ? el("p", { className: "setting-note", textContent: note }) : "",
          focusable(controlFor(key, prop, current, (v) => void set(key, v), () => deps.openJson(level)), `control:${key}`),
          el("p", { className: "setting-default", textContent: `Default: ${show(prop.default)}` }),
        );
        const problem = here && settingProblem(key, values[key], deps.catalog());
        if (problem) row.append(el("p", { className: "setting-problem", role: "status", textContent: `${problem}, so it's ignored.` }));
        row.dataset.search = `${key} ${title} ${section} ${prop.description ?? ""}`.toLowerCase();
        sections.set(section, [...(sections.get(section) ?? []), row]);
      }
      const groups = [...sections].map(([name, rows]) => el("section", { className: "setting-group" }, el("h3", { textContent: name }), ...rows));
      const none = el("p", { className: "message", textContent: "No setting matches." });
      const filter = () => {
        const q = view.query.trim().toLowerCase();
        let any = false;
        for (const g of groups) {
          let shown = 0;
          for (const row of g.querySelectorAll<HTMLElement>(".setting")) {
            row.hidden = !!q && !row.dataset.search!.includes(q);
            if (!row.hidden) shown++;
          }
          g.hidden = shown === 0;
          any ||= shown > 0;
        }
        none.hidden = any;
      };
      root.classList.add("settings-editor");
      root.replaceChildren(
        el("div", { className: "settings-top" }, levelSwitch, search, toJson),
        el("p", { className: "settings-level", textContent: ABOUT[level] }),
        path ? "" : el("p", { className: "message", textContent: "User settings need you signed in." }),
        failed ? el("p", { className: "setting-problem", role: "alert", textContent: failed }) : "",
        broken ? el("p", { className: "message", textContent: "This settings file isn't a JSON object, so changes here can't be saved. Fix it in the JSON." }) : "",
        ...groups,
        none,
      );
      filter();
      failed = "";
      // A Reset button goes once it's used: the keyboard goes to its setting's control.
      const find = (id: string) => root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(id)}"]`);
      const back = focusId && (find(focusId) ?? find(focusId.replace(/^reset:/, "control:")));
      if (back) back.focus();
    },
  };
  /** The User | Workspace | This device switch, with `on` showing. */
  function switchOf(root: HTMLElement, on: Shown): HTMLElement {
    const levels: Shown[] = deps.device ? ["user", "workspace", "device"] : ["user", "workspace"];
    return el(
      "div",
      { className: "levels", role: "tablist", ariaLabel: "Which settings" },
      ...levels.map((l) =>
        focusable(
          el("button", {
            role: "tab",
            ariaSelected: String(l === on),
            textContent: l === "user" ? "User" : l === "workspace" ? "Workspace" : "This device",
            title: l === "device" ? "What this device has, and what's on here" : ABOUT[l],
            onclick: () => {
              view.level = l;
              void view.render(root);
            },
          }),
          `level:${l}`,
        ),
      ),
    );
  }

  function renderDeviceLevel(root: HTMLElement) {
    const active = document.activeElement as HTMLElement | null;
    const focusId = active && root.contains(active) ? active.dataset.focus : undefined;
    root.classList.add("settings-editor");
    root.replaceChildren(el("div", { className: "settings-top" }, switchOf(root, "device")));
    deps.device?.(root);
    const back = focusId && root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusId)}"]`);
    if (back) back.focus();
  }

  return view;
}

/** The control for a setting's type. Anything that isn't a simple value is edited in the JSON. */
function controlFor(key: string, prop: Property, current: unknown, set: (v: unknown) => void, openJson: () => void): HTMLElement {
  if (prop.enum) {
    const select = el<HTMLSelectElement>("select", { ariaLabel: key }, ...prop.enum.map((v) => el("option", { value: show(v), textContent: show(v) })));
    select.value = show(current);
    select.addEventListener("change", () => set(prop.enum!.find((v) => show(v) === select.value)));
    return select;
  }
  if (prop.type === "boolean") {
    const box = el<HTMLInputElement>("input", { type: "checkbox", checked: current === true, ariaLabel: key });
    box.addEventListener("change", () => set(box.checked));
    return box;
  }
  if (prop.type === "integer" || prop.type === "number") {
    const input = el<HTMLInputElement>("input", { type: "number", value: String(current ?? ""), step: prop.type === "integer" ? "1" : "any", ariaLabel: key });
    if (prop.minimum !== undefined) input.min = String(prop.minimum);
    if (prop.maximum !== undefined) input.max = String(prop.maximum);
    input.addEventListener("change", () => {
      const n = Number(input.value);
      const ok = input.value !== "" && Number.isFinite(n) && (prop.type !== "integer" || Number.isInteger(n)) && !(n < (prop.minimum ?? -Infinity)) && !(n > (prop.maximum ?? Infinity));
      input.setAttribute("aria-invalid", String(!ok));
      input.title = ok ? "" : `From ${prop.minimum} to ${prop.maximum}`;
      if (ok && n !== current) set(n);
    });
    return input;
  }
  if (prop.type === "string") {
    const input = el<HTMLInputElement>("input", { type: "text", value: String(current ?? ""), ariaLabel: key });
    input.addEventListener("change", () => set(input.value));
    return input;
  }
  return el("button", { className: "to-json", textContent: "Edit in settings.json", onclick: openJson });
}
