// The Plugins view: every plugin, built-in or from the workspace, whether it's on, what it adds and
// what went wrong. Turning one on or off writes "plugins.disabled"; Customize copies a built-in into
// the workspace, and Revert deletes the copy. Both are ordinary changes, and both apply after a reload.
import type { EditorView } from "@codemirror/view";
import { isSelfContained, type BuiltIn, type PluginEntry } from "./plugin-host.ts";

export interface PluginsViewDeps {
  entries(): readonly PluginEntry[];
  /** Plugins whose files or settings changed since the app started. */
  needsReload(): ReadonlySet<string>;
  /** Whether settings turn the plugin on, now (not as it started). */
  isOn(id: string): boolean;
  setOn(id: string, on: boolean): Promise<void>;
  safe: boolean;
  openSource(entry: PluginEntry): void;
  customize(builtIn: BuiltIn): Promise<void>;
  revert(entry: PluginEntry): Promise<void>;
  reload(safe?: boolean): void;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string | false | null | undefined)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...(children.filter((c) => c !== false && c !== null && c !== undefined) as (Node | string)[]));
  return node;
}

function focusable<T extends HTMLElement>(node: T, id: string): T {
  node.dataset.focus = id;
  return node;
}

/** Where a plugin comes from, as the view says it. */
export function originOf(e: PluginEntry): "Built-in" | "Workspace" | "Customized" {
  return e.builtIn && e.workspace ? "Customized" : e.workspace ? "Workspace" : "Built-in";
}

const STATE_TEXT: Record<PluginEntry["state"], string> = { on: "On", off: "Off", failed: "Failed", safe: "Not loaded: safe mode" };

export function pluginsView(deps: PluginsViewDeps) {
  const view = {
    id: "plugins",
    title: "Plugins",
    render(root: HTMLElement) {
      const active = document.activeElement as HTMLElement | null;
      const focusId = active && root.contains(active) ? active.dataset.focus : undefined;
      const reload = deps.needsReload();
      root.classList.add("plugins-view");
      root.replaceChildren(
        deps.safe
          ? el(
              "p",
              { className: "banner" },
              "Safe mode: only built-in plugins are running. ",
              focusable(el("button", { textContent: "Leave safe mode", onclick: () => deps.reload(false) }), "leave-safe"),
            )
          : "",
        reload.size
          ? el("p", { className: "banner" }, "Plugin changes apply after reload. ", focusable(el("button", { textContent: "Reload", onclick: () => deps.reload() }), "reload"))
          : "",
        ...deps.entries().map((e) => row(e, reload.has(e.manifest.id))),
      );
      const back = focusId && root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusId)}"]`);
      if (back) back.focus();
    },
  };

  function row(e: PluginEntry, reloadNeeded: boolean): HTMLElement {
    const { id, name, description } = e.manifest;
    const on = deps.isOn(id);
    const toggle = focusable(el<HTMLInputElement>("input", { type: "checkbox", checked: on, ariaLabel: `${name} on` }), `on:${id}`);
    toggle.disabled = deps.safe && !e.builtIn;
    toggle.addEventListener("change", () => void deps.setOn(id, toggle.checked));
    const b = e.builtIn;
    const actions = [
      focusable(el("button", { textContent: "Source", title: e.workspace ? "Open its index.js" : `Show ${b?.file}, read-only`, onclick: () => deps.openSource(e) }), `source:${id}`),
      b && !e.workspace
        ? isSelfContained(b.source)
          ? focusable(el("button", { textContent: "Customize", title: "Copy it into the workspace, where you can change it", onclick: () => void deps.customize(b) }), `customize:${id}`)
          : el("button", { textContent: "Customize", disabled: true, title: `${name} uses the app's own modules, so a copy of it can't run on its own yet` })
        : null,
      b && e.workspace ? focusable(el("button", { textContent: "Revert to built-in", title: "Delete the workspace's copy", onclick: () => void deps.revert(e) }), `revert:${id}`) : null,
    ];
    return el(
      "section",
      { className: `plugin state-${e.state}` },
      el(
        "div",
        { className: "plugin-head" },
        el("label", { className: "plugin-toggle" }, toggle, el("span", { className: "plugin-name", textContent: name })),
        el("code", { className: "plugin-id", textContent: id }),
        el("span", { className: "badge", textContent: originOf(e) }),
        el("span", { className: "plugin-state", textContent: STATE_TEXT[e.state] }),
        reloadNeeded && el("span", { className: "badge reload", textContent: "Reload needed" }),
      ),
      description && el("p", { className: "plugin-desc", textContent: description }),
      contributions(e),
      e.error &&
        el(
          "p",
          { className: "plugin-error", role: "alert" },
          e.error,
          " ",
          !deps.safe && e.workspace ? focusable(el("button", { textContent: "Open in safe mode", onclick: () => deps.reload(true) }), `safe:${id}`) : null,
        ),
      el("div", { className: "plugin-actions" }, ...actions),
    );
  }

  return view;
}

function contributions(e: PluginEntry): HTMLElement {
  const c = e.contributions;
  if (!c) return el("p", { className: "plugin-adds muted", textContent: e.state === "safe" ? "Its code isn't loaded, so what it adds isn't known." : e.state === "failed" ? "It didn't start, so it adds nothing." : "Turn it on and reload to see what it adds." });
  const parts: Array<[string, string[]]> = [
    ["Commands", c.commands],
    ["Views", c.views],
    ["Command bar", c.commandBar],
    ["Keybindings", c.keybindings],
    ["Editor", c.editor],
  ];
  const shown = parts.filter(([, items]) => items.length);
  if (!shown.length) return el("p", { className: "plugin-adds muted", textContent: e.state === "failed" ? "It didn't start, so it adds nothing." : "Adds nothing yet." });
  return el("dl", { className: "plugin-adds" }, ...shown.flatMap(([label, items]) => [el("dt", { textContent: label }), el("dd", { textContent: items.join(", ") })]));
}

/** A built-in plugin's source, read-only, with Customize when it can run as a copy. */
export function builtInSourceView(b: BuiltIn, deps: { editor(text: string): EditorView; customize(b: BuiltIn): void }) {
  return {
    id: `plugin-source:${b.id}`,
    title: `${b.name} (built-in)`,
    render(root: HTMLElement) {
      root.classList.add("plugin-source");
      const bar = el(
        "div",
        { className: "version-bar" },
        el("span", { textContent: `${b.file}, read-only: this is the code that runs.` }),
        isSelfContained(b.source) ? el("button", { textContent: "Customize", onclick: () => deps.customize(b) }) : null,
      );
      const editor = deps.editor(b.source);
      root.replaceChildren(bar, editor.dom);
    },
  };
}
