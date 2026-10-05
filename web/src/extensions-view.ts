// The Extensions view: every extension, built-in or from the workspace, whether it's on, what it adds
// and asks for, and what went wrong. All of that is read from its manifest, so it shows before the
// extension's code has run. Turning one on or off writes "extensions.disabled"; Customize copies a
// built-in into the workspace, and Revert or Uninstall deletes the workspace's copy. Each is an
// ordinary change, and each applies after a reload. Below them, the Catalog: extensions you can install.
import type { EditorView } from "@codemirror/view";
import type { CatalogEntry } from "../../worker/src/catalog.ts";
import { needsScope, PERMISSION_KINDS, type ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Answer } from "../../worker/src/permissions.ts";
import type { BuiltIn, ExtensionRecord } from "./extension-host.ts";

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
  /** Your answer kept for one of its declared permissions, by key ("network:api.weather.gov"). */
  answer(record: ExtensionRecord, key: string): Answer | undefined;
  /** Keep an answer, or forget it (undefined) so it asks again. */
  setAnswer(record: ExtensionRecord, key: string, answer: Answer | undefined): Promise<void>;
  /** Whether you trust it to run in the page (workspace extensions only). */
  isTrusted(record: ExtensionRecord): boolean;
  setTrusted(record: ExtensionRecord, trusted: boolean): Promise<void>;
  install(): Promise<void>;
  showActivity(): void;
  /** What the catalogs list, or null until they've been read (asking starts reading them). */
  catalog(): { entries: CatalogEntry[]; problems: string[] } | null;
  /** A command's title, for keybindings an extension adds to other extensions' or the app's commands. */
  commandTitle(command: string): string | undefined;
  installFromCatalog(entry: CatalogEntry): Promise<void>;
  /** Open an extension's details, in a tab. */
  openDetails(record: ExtensionRecord): void;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string | false | null | undefined)[]): T {
  const { dataset, ...rest } = props as { dataset?: Record<string, string> };
  const node = Object.assign(document.createElement(tag), rest) as T;
  Object.assign(node.dataset, dataset ?? {});
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

/** What a manifest says an extension adds, in words, by kind; other commands it binds keys to are named by `titleOf`. Exported for tests. */
export function contributionLines(m: ExtensionManifest, titleOf: (command: string) => string | undefined = () => undefined): Array<[string, string]> {
  const c = m.contributes;
  const title = (command: string) => c.commands.find((x) => x.command === command)?.title ?? titleOf(command) ?? command;
  const views = Object.values(c.views).flat();
  const settings = c.configuration ? Object.keys(c.configuration.properties) : [];
  const keys = c.keybindings.map((k) => `${"key" in k ? k.key : `${k.vim} (Vim${k.operator ? " operator" : ""})`} → ${title(k.command)}`);
  const menus = Object.entries(c.menus).flatMap(([menu, items]) => (items ?? []).map((i) => `${title(i.command)} (${menu === "tabMenu" ? "tab menu" : menu === "commandBar" ? "command bar" : "editor menu"})`));
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

/** Each declared permission's key, as answers are kept: one per scope. Exported for tests. */
export function permissionKeys(m: ExtensionManifest): Array<{ key: string; why: string }> {
  return PERMISSION_KINDS.flatMap((kind) => {
    const p = m.permissions[kind];
    if (!p) return [];
    if (!needsScope(kind)) return [{ key: kind, why: p.why }];
    return (p.hosts ?? p.paths ?? p.keys ?? []).map((scope) => ({ key: `${kind}:${scope}`, why: p.why }));
  });
}

/** The element that scrolls a view: its own box, or the panel or tab around it. */
const scroller = (root: HTMLElement) => (root.scrollHeight > root.clientHeight ? root : (root.parentElement ?? root));

/** Draw again without losing your place: the scroll position and the focused control come back. */
function keepingPlace(root: HTMLElement, draw: () => void) {
  const box = scroller(root);
  const top = box.scrollTop;
  const active = document.activeElement as HTMLElement | null;
  const focusId = active && root.contains(active) ? active.dataset.focus : undefined;
  draw();
  scroller(root).scrollTop = top;
  const back = focusId && root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusId)}"]`);
  if (back) back.focus({ preventScroll: true });
}

/**
 * The Extensions view, as VS Code lists them: a row each, with its name, what it does, whether it's on,
 * and where it's from, in sections (Installed, Built-in, Catalog), with a search box. A row opens the
 * extension's details: what it adds and may ask for, and what you can do with it.
 */
export function extensionsView(deps: ExtensionsViewDeps) {
  let query = "";
  const view = {
    id: "extensions",
    title: "Extensions",
    render(root: HTMLElement) {
      root.classList.add("extensions-view");
      keepingPlace(root, () => draw(root));
    },
  };

  function draw(root: HTMLElement) {
    const reload = deps.needsReload();
    const records = deps.records();
    const catalog = deps.catalog();
    const fromCatalog = new Set(catalog?.entries.map((e) => e.id) ?? []);
    const search = focusable(el<HTMLInputElement>("input", { type: "search", className: "extensions-search", placeholder: "Search extensions", ariaLabel: "Search extensions", value: query }), "search");
    search.addEventListener("input", () => {
      query = search.value;
      filter(root);
    });
    const installed = records.filter((r) => r.workspace && !r.builtIn);
    const notInstalled = (catalog?.entries ?? []).filter((e) => !records.some((r) => r.id === e.id));
    root.replaceChildren(
      deps.safe
        ? el("p", { className: "banner" }, "Safe mode: only built-in extensions are running. ", focusable(el("button", { textContent: "Leave safe mode", onclick: () => deps.reload(false) }), "leave-safe"))
        : "",
      reload.size ? el("p", { className: "banner" }, "Extension changes apply after reload. ", focusable(el("button", { textContent: "Reload", onclick: () => deps.reload() }), "reload")) : "",
      el(
        "div",
        { className: "extensions-top" },
        search,
        focusable(el("button", { textContent: "Install from URL…", onclick: () => void deps.install() }), "install"),
        focusable(el("button", { textContent: "Activity", title: "What extensions have reached and asked for this session", onclick: () => deps.showActivity() }), "activity"),
      ),
      section("Installed", installed.map((r) => row(r, reload.has(r.id), fromCatalog.has(r.id) ? "Catalog" : "Workspace"))),
      section("Built-in", records.filter((r) => r.builtIn).map((r) => row(r, reload.has(r.id), originOf(r)))),
      section(
        "Catalog",
        [
          ...(!catalog ? [el("p", { className: "extension-desc", textContent: "Reading the catalog…" })] : []),
          ...(catalog?.problems ?? []).map((p) => el("p", { className: "extension-error", role: "alert", textContent: p })),
          ...notInstalled.map(catalogRow),
        ],
        "First-party extensions that aren't on by default. Installing one copies it into this workspace, where it runs sandboxed. Catalogs you add (extensions.catalogs) list other people's: they run sandboxed too, but you install them at your own risk.",
      ),
    );
    filter(root);
  }

  /** Rows that match the search show; sections with none don't. */
  function filter(root: HTMLElement) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of root.querySelectorAll<HTMLElement>(".extension-row")) r.hidden = !words.every((w) => (r.dataset.search ?? "").includes(w));
    for (const s of root.querySelectorAll<HTMLElement>(".extension-section")) s.hidden = !!words.length && !s.querySelector(".extension-row:not([hidden])");
  }

  function section(title: string, rows: HTMLElement[], about?: string): HTMLElement {
    return el("section", { className: `extension-section ${title === "Catalog" ? "catalog" : ""}` }, el("h2", { textContent: title }), about ? el("p", { className: "extension-about", textContent: about }) : null, ...rows);
  }

  function row(r: ExtensionRecord, reloadNeeded: boolean, origin: string): HTMLElement {
    const { id, name, description } = r.manifest;
    const toggle = focusable(el<HTMLInputElement>("input", { type: "checkbox", checked: deps.isOn(id), ariaLabel: `${name} on`, title: deps.isOn(id) ? "On: turn it off" : "Off: turn it on" }), `on:${id}`);
    toggle.disabled = deps.safe && !r.builtIn;
    toggle.addEventListener("change", () => void deps.setOn(id, toggle.checked));
    const open = focusable(
      el("button", { className: "extension-open", title: `${name}: what it adds and may ask for`, onclick: () => deps.openDetails(r) }, el("span", { className: "extension-name", textContent: name }), el("span", { className: "extension-desc", textContent: description })),
      `open:${id}`,
    );
    // Failed to start, or started and then threw: its details say what happened.
    const state = r.state === "failed" ? "Failed" : r.error ? "Error" : r.state === "safe" ? "Not loaded" : "";
    return el(
      "div",
      { className: `extension-row state-${r.state}${r.error ? " has-error" : ""}`, dataset: { search: `${name} ${id} ${description}`.toLowerCase(), extension: id } },
      toggle,
      open,
      reloadNeeded && el("span", { className: "badge reload", textContent: "Reload needed" }),
      state && el("span", { className: "extension-state", textContent: state }),
      el("span", { className: "badge", textContent: origin }),
    );
  }

  function catalogRow(entry: CatalogEntry): HTMLElement {
    const install = focusable(el("button", { textContent: "Install", onclick: () => void deps.installFromCatalog(entry) }), `catalog:${entry.catalog}:${entry.id}`);
    return el(
      "div",
      { className: "extension-row catalog-entry", dataset: { search: `${entry.name} ${entry.id} ${entry.description}`.toLowerCase(), extension: entry.id } },
      el("span", { className: "extension-open static" }, el("span", { className: "extension-name", textContent: entry.name }), el("span", { className: "extension-desc", textContent: entry.description })),
      install,
      el("span", { className: "badge", textContent: entry.firstParty ? "Catalog" : `${entry.catalog} · at your own risk` }),
    );
  }

  return view;
}

/** One extension's details: what it is, what it adds and may ask for (with your answers), what went wrong, and what you can do with it. */
export function extensionDetailsView(id: string, deps: ExtensionsViewDeps) {
  const record = () => deps.records().find((r) => r.id === id);
  const view = {
    id: `extension:${id}`,
    get title() {
      return record()?.manifest.name ?? id;
    },
    render(root: HTMLElement) {
      root.classList.add("extensions-view", "extension-details");
      keepingPlace(root, () => {
        const r = record();
        root.replaceChildren(r ? details(r, deps.needsReload().has(r.id)) : el("p", { className: "extension-desc", textContent: `There's no extension "${id}" any more.` }));
      });
    },
  };

  function details(r: ExtensionRecord, reloadNeeded: boolean): HTMLElement {
    const { name, description, version } = r.manifest;
    const toggle = focusable(el<HTMLInputElement>("input", { type: "checkbox", checked: deps.isOn(id), ariaLabel: `${name} on` }), `on:${id}`);
    toggle.disabled = deps.safe && !r.builtIn;
    toggle.addEventListener("change", () => void deps.setOn(id, toggle.checked));
    const b = r.builtIn;
    const actions = [
      focusable(el("button", { textContent: "Source", title: r.workspace ? `Open ${r.manifest.main}` : `Show ${b?.folder}, read-only`, onclick: () => deps.openSource(r) }), `source:${id}`),
      r.manifest.contributes.configuration ? focusable(el("button", { textContent: "Settings", onclick: () => deps.openSettings(r) }), `settings:${id}`) : null,
      b && !r.workspace ? focusable(el("button", { textContent: "Customize", title: "Copy it into the workspace, as JavaScript you can change", onclick: () => void deps.customize(b) }), `customize:${id}`) : null,
      r.workspace ? focusable(el("button", { textContent: b ? "Revert to built-in" : "Uninstall", title: "Delete the workspace's files for it, as changes undo can take back", onclick: () => void deps.remove(r) }), `remove:${id}`) : null,
      r.workspace
        ? focusable(
            el("button", {
              textContent: deps.isTrusted(r) ? "Stop trusting" : "Trust…",
              title: deps.isTrusted(r) ? "Run it sandboxed again, after a reload" : "Let it run in the app's page, with access to note editors",
              onclick: () => void deps.setTrusted(r, !deps.isTrusted(r)),
            }),
            `trust:${id}`,
          )
        : null,
    ];
    const adds = contributionLines(r.manifest, deps.commandTitle);
    const asks = permissionKeys(r.manifest);
    const builtIn = !!b && !r.workspace;
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
      el("div", { className: "extension-actions" }, ...actions),
      r.error &&
        el(
          "p",
          { className: "extension-error", role: "alert" },
          r.error,
          " ",
          !deps.safe && r.workspace ? focusable(el("button", { textContent: "Open in safe mode", onclick: () => deps.reload(true) }), `safe:${id}`) : null,
        ),
      adds.length ? el("dl", { className: "extension-adds" }, ...adds.flatMap(([label, text]) => [el("dt", { textContent: label }), el("dd", { textContent: text })])) : null,
      asks.length
        ? el(
            "dl",
            { className: "extension-adds extension-asks" },
            el("dt", { className: "full", textContent: builtIn ? "Uses (allowed with the app; you can deny any)" : "May ask to" }),
            ...asks.flatMap(({ key, why }) => [el("dt", { textContent: key }), el("dd", {}, why, " ", answerPicker(r, key, builtIn))]),
          )
        : null,
    );
  }

  /** Your answer for one permission: Ask (none kept), Allow or Deny. */
  function answerPicker(r: ExtensionRecord, key: string, builtIn: boolean): HTMLElement {
    const now = deps.answer(r, key);
    const pick = focusable(
      el<HTMLSelectElement>(
        "select",
        { className: "answer", ariaLabel: `${r.manifest.name}: ${key}` },
        el("option", { value: "", textContent: builtIn ? "Allowed" : "Ask", selected: !now }),
        el("option", { value: "allow", textContent: "Allow", selected: now === "allow" }),
        el("option", { value: "deny", textContent: "Deny", selected: now === "deny" }),
      ),
      `answer:${r.id}:${key}`,
    );
    pick.addEventListener("change", () => void deps.setAnswer(r, key, (pick.value || undefined) as Answer | undefined));
    return pick;
  }

  return view;
}

/** A built-in extension's source, read-only, file by file, with Customize when it can run as a copy. */
export function builtInSourceView(b: BuiltIn, deps: { editor(text: string): EditorView; customize(b: BuiltIn): void }) {
  const names = [...b.files].sort((x, y) => (x === "extension.json" ? -1 : y === "extension.json" ? 1 : x.localeCompare(y)));
  let showing = names.includes(b.manifest.main) ? b.manifest.main : names[0];
  const view = {
    id: `extension-source:${b.manifest.id}`,
    title: `${b.manifest.name} (built-in)`,
    async render(root: HTMLElement) {
      root.classList.add("extension-source");
      const pick = el<HTMLSelectElement>("select", { ariaLabel: "File" }, ...names.map((n) => el("option", { value: n, textContent: n, selected: n === showing })));
      pick.addEventListener("change", () => {
        showing = pick.value;
        void view.render(root);
      });
      const bar = el(
        "div",
        { className: "version-bar" },
        el("span", { textContent: `${b.folder}, read-only: this is the code that runs.` }),
        pick,
        el("button", { textContent: "Customize", onclick: () => deps.customize(b) }),
      );
      root.replaceChildren(bar, deps.editor(await b.source(showing)).dom);
    },
  };
  return view;
}
