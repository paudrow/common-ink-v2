// The Extensions view: a row for each extension, built-in or from the workspace, with whether it's on
// and where it's from, in sections, with a search box. A row opens the extension's details in a modal:
// what it adds and may ask for, what went wrong, and what you can do with it. All of that is read from
// its manifest, so it shows before the extension's code has run. Turning one on or off writes
// "extensions.disabled"; Customize copies a built-in into the workspace, and Revert or Uninstall
// deletes the workspace's copy. Each is an ordinary change, and each applies after a reload. Each
// permission shows your answer (Ask, Always allow or Don't allow), in the words prompts use. Below
// them, the Catalog: extensions you can install.
import type { EditorView } from "@codemirror/view";
import type { CatalogEntry } from "../../worker/src/catalog.ts";
import type { ExtensionManifest } from "../../worker/src/extensions.ts";
import type { Answer } from "../../worker/src/permissions.ts";
import type { BuiltIn, ExtensionRecord } from "./extension-host.ts";
import { openModal, type Modal } from "./modal.ts";
import { ANSWER_WORDS, declaredPermissions, plain } from "./permission-words.ts";

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
  /** Forget every answer kept for it, so it asks again: one change, by you. */
  resetAnswers(record: ExtensionRecord): Promise<void>;
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

/** Where an extension comes from, as the view and its prompts say it. */
export function originOf(r: Pick<ExtensionRecord, "builtIn" | "workspace" | "installedFrom" | "catalog">): "Built-in" | "Customized" | "Catalog" | "From URL" | "Workspace" {
  if (r.builtIn) return r.workspace ? "Customized" : "Built-in";
  if (r.catalog) return "Catalog";
  return r.installedFrom ? "From URL" : "Workspace";
}

const STATE_TEXT: Record<ExtensionRecord["state"], string> = { active: "On", inactive: "On, starts when used", off: "Off", failed: "Failed", safe: "Not loaded: safe mode" };

/** What a manifest says an extension adds, in words, by kind; other commands it binds keys to are named by `titleOf`. Exported for tests. */
export function contributionLines(m: ExtensionManifest, titleOf: (command: string) => string | undefined = () => undefined): Array<[string, string]> {
  const c = m.contributes;
  const title = (command: string) => c.commands.find((x) => x.command === command)?.title ?? titleOf(command) ?? command;
  const views = Object.values(c.views).flat();
  const settings = c.configuration ? Object.keys(c.configuration.properties) : [];
  const keys = c.keybindings.map((k) => `${"key" in k ? k.key : `${k.vim} (Vim${k.operator ? " operator" : ""})`} → ${title(k.command)}`);
  const menus = Object.entries(c.menus).flatMap(([menu, items]) => (items ?? []).map((i) => `${title(i.command)} (${{ tabMenu: "tab menu", commandBar: "command bar", editorContext: "editor menu", quickOpen: "⌘P" }[menu] ?? menu})`));
  const lines: Array<[string, string[]]> = [
    ["Commands", c.commands.map((x) => x.title)],
    ["Keybindings", keys],
    ["Menus", menus],
    ["Views", views.map((v) => v.name)],
    ["Settings", settings],
    ["Status bar", c.statusBarItems.map((s) => s.id)],
    ["Embeds", c.embeds.map((e) => `${e.title} (\`\`\`${e.language})`)],
    ["Link embeds", c.urlEmbeds.map((e) => e.title)],
    ["Data sources", c.dataSources.map((d) => d.title)],
  ];
  return lines.filter(([, items]) => items.length).map(([label, items]) => [label, items.join(", ")]);
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
 * A press in the panel, while the pointer is down. Drawn again under it, a button's down and up would
 * land on different elements and its click would be lost: the drawing waits until the press is over.
 */
let pressed: Element | null = null;
let afterPress: (() => void) | null = null;
/** How long a press holds the drawing back at most, in case its release never reaches the page. */
const PRESS_MS = 2000;
let longest = 0;
/** Counts presses, so a release's late work doesn't end the press after it (input can come before a timer). */
let presses = 0;
if (typeof document !== "undefined") {
  const released = () => {
    clearTimeout(longest);
    const press = presses;
    // After the click the press makes, which comes after pointerup.
    setTimeout(() => {
      if (press !== presses) return;
      pressed = null;
      const draw = afterPress;
      afterPress = null;
      draw?.();
    });
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      pressed = e.target instanceof Element ? e.target : null;
      presses++;
      clearTimeout(longest);
      longest = window.setTimeout(released, PRESS_MS);
    },
    true,
  );
  document.addEventListener("pointerup", released, true);
  document.addEventListener("pointercancel", released, true);
  // The release can happen where the page doesn't hear it: another tab, another window.
  window.addEventListener("blur", released);
  document.addEventListener("visibilitychange", () => document.hidden && released());
}

/** Whether a press under way is in one of these, so drawing them now would lose its click. */
const pressIn = (...boxes: Array<Element | undefined>) => !!pressed && boxes.some((b) => b?.contains(pressed!));

export function extensionsView(deps: ExtensionsViewDeps) {
  let query = "";
  /** The extension whose details are showing, and their modal. */
  let details: { id: string; modal: Modal } | null = null;

  const view = {
    id: "extensions",
    title: "Extensions",
    render(root: HTMLElement) {
      root.classList.add("extensions-view");
      if (pressIn(root, details?.modal.box)) return void (afterPress = () => view.render(root));
      keepingPlace(root, () => draw(root));
      drawDetails();
    },
    /** Show an extension's details over the app. Focus goes back to what had it when they close. */
    showDetails(id: string) {
      details?.modal.close();
      const name = deps.records().find((r) => r.id === id)?.manifest.name ?? id;
      const modal = openModal({
        label: name,
        className: "extension-details",
        closeOnOutside: true,
        // What opened them may have been drawn again since: its row, then.
        returnTo: () => document.querySelector<HTMLElement>(`.extensions-view [data-focus="open:${CSS.escape(id)}"]`),
        onClose: () => {
          if (details?.modal === modal) details = null;
        },
      });
      details = { id, modal };
      drawDetails();
    },
  };

  function draw(root: HTMLElement) {
    const reload = deps.needsReload();
    const records = deps.records();
    const search = focusable(el<HTMLInputElement>("input", { type: "search", className: "extensions-search", placeholder: "Search extensions", ariaLabel: "Search extensions", value: query }), "search");
    search.addEventListener("input", () => {
      query = search.value;
      filter(root);
    });
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
      section("Installed", records.filter((r) => r.workspace && !r.builtIn).map((r) => row(r, reload.has(r.id)))),
      section("Built-in", records.filter((r) => r.builtIn).map((r) => row(r, reload.has(r.id)))),
      catalogSection(),
    );
    filter(root);
  }

  /** Rows that match the search show; sections with none don't. */
  function filter(root: HTMLElement) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of root.querySelectorAll<HTMLElement>(".extension-row")) r.hidden = !words.every((w) => (r.dataset.search ?? "").includes(w));
    for (const s of root.querySelectorAll<HTMLElement>(".extension-section")) s.hidden = !!words.length && !s.querySelector(".extension-row:not([hidden])");
  }

  function section(title: string, rows: HTMLElement[]): HTMLElement | "" {
    return rows.length ? el("section", { className: "extension-section" }, el("h2", { textContent: title }), ...rows) : "";
  }

  /** Extensions the catalogs list that aren't installed: the app's own first-party ones that aren't on by default, then any others you've added. */
  function catalogSection(): HTMLElement {
    const catalog = deps.catalog();
    const records = deps.records();
    return el(
      "section",
      { className: "extension-section catalog" },
      el("h2", { textContent: "Catalog" }),
      el(
        "p",
        { className: "extension-about" },
        "Extensions made with Common Ink that aren't on by default. Installing one copies its files into this workspace, where it runs sandboxed. Catalogs you add (the extensions.catalogs setting) list other people's extensions: they run sandboxed too, but you install them at your own risk.",
      ),
      !catalog ? el("p", { className: "extension-about", textContent: "Reading the catalog…" }) : null,
      ...(catalog?.problems ?? []).map((p) => el("p", { className: "extension-error", role: "alert", textContent: p })),
      ...(catalog?.entries ?? []).filter((e) => !records.some((r) => r.id === e.id)).map(catalogRow),
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

  function row(r: ExtensionRecord, reloadNeeded: boolean): HTMLElement {
    const { id, name, description } = r.manifest;
    const toggle = focusable(el<HTMLInputElement>("input", { type: "checkbox", checked: deps.isOn(id), ariaLabel: `${name} on`, title: deps.isOn(id) ? "On: turn it off" : "Off: turn it on" }), `on:${id}`);
    toggle.disabled = deps.safe && !r.builtIn;
    toggle.addEventListener("change", () => void deps.setOn(id, toggle.checked));
    const open = focusable(
      el(
        "button",
        { className: "extension-open", title: `${name}: what it adds and may ask for`, ariaHasPopup: "dialog", onclick: () => view.showDetails(id) },
        el("span", { className: "extension-name", textContent: name }),
        el("span", { className: "extension-desc", textContent: description }),
      ),
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
      el("span", { className: "badge", textContent: originOf(r) }),
    );
  }

  /** The details showing, drawn again with what's true now. */
  function drawDetails() {
    if (!details) return;
    if (pressIn(details.modal.box)) return void (afterPress = drawDetails);
    const { id, modal } = details;
    const r = deps.records().find((x) => x.id === id);
    keepingPlace(modal.box, () =>
      modal.box.replaceChildren(
        ...(r
          ? detailsOf(r, deps.needsReload().has(id), modal)
          : [el("p", { className: "extension-desc", textContent: `There's no extension "${id}" any more.` }), el("div", { className: "extension-actions" }, el("button", { textContent: "Close", onclick: () => modal.close() }))]),
      ),
    );
  }

  /** One extension's details: what it is, what you can do with it, what went wrong, and what it adds and may ask for. */
  function detailsOf(r: ExtensionRecord, reloadNeeded: boolean, modal: Modal): HTMLElement[] {
    const { id, name, description, version } = r.manifest;
    const toggle = focusable(el<HTMLInputElement>("input", { type: "checkbox", checked: deps.isOn(id) }), `details-on:${id}`);
    toggle.disabled = deps.safe && !r.builtIn;
    toggle.addEventListener("change", () => void deps.setOn(id, toggle.checked));
    const b = r.builtIn;
    const actions = [
      focusable(el("button", { textContent: "Source", title: r.workspace ? `Open ${r.manifest.main}` : `Show ${b?.folder}, read-only`, onclick: () => (modal.close(), deps.openSource(r)) }), `source:${id}`),
      r.manifest.contributes.configuration ? focusable(el("button", { textContent: "Settings", onclick: () => (modal.close(), deps.openSettings(r)) }), `settings:${id}`) : null,
      b && !r.workspace ? focusable(el("button", { textContent: "Customize", title: "Copy it into the workspace, as JavaScript you can change", onclick: () => (modal.close(), void deps.customize(b)) }), `customize:${id}`) : null,
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
    const asks = declaredPermissions(r.manifest);
    const builtIn = !!b && !r.workspace;
    const kept = asks.some((p) => deps.answer(r, p.key));
    return [
      el(
        "header",
        { className: "details-head" },
        el("h2", { textContent: name }),
        el("span", { className: "badge", textContent: originOf(r) }),
        reloadNeeded && el("span", { className: "badge reload", textContent: "Reload needed" }),
        focusable(el("button", { className: "modal-close", textContent: "×", title: "Close (Esc)", ariaLabel: "Close", onclick: () => modal.close() }), "close"),
      ),
      el("p", { className: "extension-meta" }, el("code", { className: "extension-id", textContent: version ? `${id} ${version}` : id }), el("span", { className: "extension-state", textContent: STATE_TEXT[r.state] })),
      description && el("p", { className: "extension-desc", textContent: description }),
      el("label", { className: "extension-toggle" }, toggle, deps.isOn(id) ? "On" : "Off"),
      r.error &&
        el(
          "p",
          { className: "extension-error", role: "alert" },
          r.error,
          " ",
          !deps.safe && r.workspace ? focusable(el("button", { textContent: "Open in safe mode", onclick: () => deps.reload(true) }), `safe:${id}`) : null,
        ),
      el("div", { className: "extension-actions" }, ...actions),
      adds.length ? el("section", {}, el("h3", { textContent: "Adds" }), el("dl", { className: "extension-adds" }, ...adds.flatMap(([label, text]) => [el("dt", { textContent: label }), el("dd", { textContent: text })]))) : null,
      asks.length
        ? el(
            "section",
            {},
            el("h3", { textContent: "Permissions" }),
            el(
              "p",
              { className: "perm-about" },
              builtIn ? "It came with the app, so it has these without asking. Choose Don't allow to take one back." : "It asks before it uses each one. Your answers are kept in your user settings.",
            ),
            el(
              "ul",
              { className: "extension-perms" },
              ...asks.map((p) => el("li", {}, el("span", { className: "perm-can", textContent: plain(p.can) }), answerPicker(r, p.key, plain(p.can), builtIn), el("p", { className: "perm-why", textContent: `${name} says: “${p.why}”` }))),
            ),
            kept ? focusable(el("button", { textContent: "Reset permissions", title: `Forget your answers, so ${name} asks again`, onclick: () => void deps.resetAnswers(r) }), `reset:${id}`) : null,
          )
        : null,
    ].filter((x): x is HTMLElement => !!x);
  }

  /** Your answer for one permission: Ask (none kept), Always allow or Don't allow. A built-in has it unless you say Don't allow. */
  function answerPicker(r: ExtensionRecord, key: string, can: string, builtIn: boolean): HTMLElement {
    const now = deps.answer(r, key) ?? "";
    const choices: Array<[Answer | "", string]> = builtIn
      ? [
          ["", ANSWER_WORDS.allow],
          ["deny", ANSWER_WORDS.deny],
        ]
      : [
          ["", ANSWER_WORDS.ask],
          ["allow", ANSWER_WORDS.allow],
          ["deny", ANSWER_WORDS.deny],
        ];
    const pick = focusable(
      el<HTMLSelectElement>("select", { className: "answer", ariaLabel: `${r.manifest.name}: ${can}` }, ...choices.map(([value, text]) => el("option", { value, textContent: text, selected: value === now || (builtIn && value === "" && now === "allow") }))),
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
