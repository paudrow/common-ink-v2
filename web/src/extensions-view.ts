// The Extensions view: every extension, built-in or from the workspace, whether it's on, what it adds
// and asks for, and what went wrong. All of that is read from its manifest, so it shows before the
// extension's code has run. Turning one on or off writes "extensions.disabled"; Customize copies a
// built-in into the workspace, and Revert or Uninstall deletes the workspace's copy. Each is an
// ordinary change, and each applies after a reload.
import type { EditorView } from "@codemirror/view";
import { PERMISSION_KINDS, type ExtensionManifest } from "../../worker/src/extensions.ts";
import { isSelfContained, type BuiltIn, type ExtensionRecord } from "./extension-host.ts";

export interface ExtensionsViewDeps {
  records(): readonly ExtensionRecord[];
  /** Extensions whose files or settings changed since the app started. */
  needsReload(): ReadonlySet<string>;
  /** Whether settings turn the extension on, now (not as it started). */
  isOn(id: string): boolean;
  setOn(id: string, on: boolean): Promise<void>;
  safe: boolean;
  openSource(record: ExtensionRecord): void;
  /** Open the settings editor at the extension's section. */
  openSettings(record: ExtensionRecord): void;
  customize(builtIn: BuiltIn): Promise<void>;
  /** Delete the workspace's files for it: a customized built-in goes back to the built-in, a workspace extension goes. */
  remove(record: ExtensionRecord): Promise<void>;
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

/** Where an extension comes from, as the view says it. */
export function originOf(r: Pick<ExtensionRecord, "builtIn" | "workspace">): "Built-in" | "Workspace" | "Customized" {
  return r.builtIn && r.workspace ? "Customized" : r.workspace ? "Workspace" : "Built-in";
}

const STATE_TEXT: Record<ExtensionRecord["state"], string> = { active: "On", inactive: "On, starts when used", off: "Off", failed: "Failed", safe: "Not loaded: safe mode" };

/** What a manifest says an extension adds, in words, by kind. Exported for tests. */
export function contributionLines(m: ExtensionManifest): Array<[string, string]> {
  const c = m.contributes;
  const views = Object.values(c.views).flat();
  const settings = c.configuration ? Object.keys(c.configuration.properties) : [];
  const keys = c.keybindings.map((k) => `${"key" in k ? k.key : `${k.vim} (Vim)`} → ${c.commands.find((x) => x.command === k.command)?.title ?? k.command}`);
  const menus = Object.entries(c.menus).flatMap(([menu, items]) => (items ?? []).map((i) => `${c.commands.find((x) => x.command === i.command)?.title ?? i.command} (${menu === "tabMenu" ? "tab menu" : menu === "commandBar" ? "command bar" : "editor menu"})`));
  const lines: Array<[string, string[]]> = [
    ["Commands", c.commands.map((x) => x.title)],
    ["Keybindings", keys],
    ["Menus", menus],
    ["Views", views.map((v) => v.name)],
    ["Settings", settings],
    ["Status bar", c.statusBarItems.map((s) => s.id)],
    ["Embeds", c.embeds.map((e) => `${e.title} (\`\`\`${e.language})`)],
    ["Link embeds", c.urlEmbeds.map((e) => e.title)],
  ];
  return lines.filter(([, items]) => items.length).map(([label, items]) => [label, items.join(", ")]);
}

/** What a manifest says an extension may ask for, with why, in the order permissions are listed. Exported for tests. */
export function permissionLines(m: ExtensionManifest): Array<[string, string]> {
  return PERMISSION_KINDS.flatMap((kind) => {
    const p = m.permissions[kind];
    if (!p) return [];
    const scope = p.hosts ?? p.paths ?? p.keys;
    return [[scope?.length ? `${kind} ${scope.join(", ")}` : kind, p.why] as [string, string]];
  });
}

export function extensionsView(deps: ExtensionsViewDeps) {
  const view = {
    id: "extensions",
    title: "Extensions",
    render(root: HTMLElement) {
      const active = document.activeElement as HTMLElement | null;
      const focusId = active && root.contains(active) ? active.dataset.focus : undefined;
      const reload = deps.needsReload();
      root.classList.add("extensions-view");
      root.replaceChildren(
        deps.safe
          ? el(
              "p",
              { className: "banner" },
              "Safe mode: only built-in extensions are running. ",
              focusable(el("button", { textContent: "Leave safe mode", onclick: () => deps.reload(false) }), "leave-safe"),
            )
          : "",
        reload.size
          ? el("p", { className: "banner" }, "Extension changes apply after reload. ", focusable(el("button", { textContent: "Reload", onclick: () => deps.reload() }), "reload"))
          : "",
        ...deps.records().map((r) => row(r, reload.has(r.id))),
      );
      const back = focusId && root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusId)}"]`);
      if (back) back.focus();
    },
  };

  function row(r: ExtensionRecord, reloadNeeded: boolean): HTMLElement {
    const { id, name, description, version } = r.manifest;
    const toggle = focusable(el<HTMLInputElement>("input", { type: "checkbox", checked: deps.isOn(id), ariaLabel: `${name} on` }), `on:${id}`);
    toggle.disabled = deps.safe && !r.builtIn;
    toggle.addEventListener("change", () => void deps.setOn(id, toggle.checked));
    const b = r.builtIn;
    const actions = [
      focusable(el("button", { textContent: "Source", title: r.workspace ? `Open ${r.manifest.main}` : `Show ${b?.folder}, read-only`, onclick: () => deps.openSource(r) }), `source:${id}`),
      r.manifest.contributes.configuration ? focusable(el("button", { textContent: "Settings", onclick: () => deps.openSettings(r) }), `settings:${id}`) : null,
      b && !r.workspace
        ? isSelfContained(b)
          ? focusable(el("button", { textContent: "Customize", title: "Copy it into the workspace, where you can change it", onclick: () => void deps.customize(b) }), `customize:${id}`)
          : el("button", { textContent: "Customize", disabled: true, title: `${name} uses the app's own modules, so a copy of it can't run on its own yet` })
        : null,
      r.workspace ? focusable(el("button", { textContent: b ? "Revert to built-in" : "Uninstall", title: "Delete the workspace's files for it, as changes undo can take back", onclick: () => void deps.remove(r) }), `remove:${id}`) : null,
    ];
    const adds = contributionLines(r.manifest);
    const asks = permissionLines(r.manifest);
    return el(
      "section",
      { className: `extension state-${r.state}` },
      el(
        "div",
        { className: "extension-head" },
        el("label", { className: "extension-toggle" }, toggle, el("span", { className: "extension-name", textContent: name })),
        el("code", { className: "extension-id", textContent: version ? `${id} ${version}` : id }),
        el("span", { className: "badge", textContent: originOf(r) }),
        el("span", { className: "extension-state", textContent: STATE_TEXT[r.state] }),
        reloadNeeded && el("span", { className: "badge reload", textContent: "Reload needed" }),
      ),
      description && el("p", { className: "extension-desc", textContent: description }),
      adds.length ? el("dl", { className: "extension-adds" }, ...adds.flatMap(([label, text]) => [el("dt", { textContent: label }), el("dd", { textContent: text })])) : null,
      asks.length
        ? el("dl", { className: "extension-adds extension-asks" }, el("dt", { className: "full", textContent: "May ask to" }), ...asks.flatMap(([what, why]) => [el("dt", { textContent: what }), el("dd", { textContent: why })]))
        : null,
      r.error &&
        el(
          "p",
          { className: "extension-error", role: "alert" },
          r.error,
          " ",
          !deps.safe && r.workspace ? focusable(el("button", { textContent: "Open in safe mode", onclick: () => deps.reload(true) }), `safe:${id}`) : null,
        ),
      el("div", { className: "extension-actions" }, ...actions),
    );
  }

  return view;
}

/** A built-in extension's source, read-only, file by file, with Customize when it can run as a copy. */
export function builtInSourceView(b: BuiltIn, deps: { editor(text: string): EditorView; customize(b: BuiltIn): void }) {
  const names = Object.keys(b.sources).sort((x, y) => (x === "extension.json" ? -1 : y === "extension.json" ? 1 : x.localeCompare(y)));
  let showing = names.includes(b.manifest.main) ? b.manifest.main : names[0];
  const view = {
    id: `extension-source:${b.manifest.id}`,
    title: `${b.manifest.name} (built-in)`,
    render(root: HTMLElement) {
      root.classList.add("extension-source");
      const pick = el<HTMLSelectElement>("select", { ariaLabel: "File" }, ...names.map((n) => el("option", { value: n, textContent: n, selected: n === showing })));
      pick.addEventListener("change", () => {
        showing = pick.value;
        view.render(root);
      });
      const bar = el(
        "div",
        { className: "version-bar" },
        el("span", { textContent: `${b.folder}, read-only: this is the code that runs.` }),
        pick,
        isSelfContained(b) ? el("button", { textContent: "Customize", onclick: () => deps.customize(b) }) : null,
      );
      root.replaceChildren(bar, deps.editor(b.sources[showing] ?? "").dom);
    },
  };
  return view;
}
