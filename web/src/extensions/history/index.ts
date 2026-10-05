// History, a built-in extension: the changes to the note on show (or to everything), who made
// each and what it changed. Select changes to see what they did together; revert just those, or
// restore a note to how it was. Labels name a note's state at one revision. Filtering to one author and
// undoing everything shown is "undo what the agent did".
import { authorKey, type Change, type FileDiff, type FilePath, type Revision, type UndoResult, type WriteResult } from "../../../../worker/src/files.ts";
import type { Label } from "../../../../worker/src/labels.ts";
import { ago, describeAuthor, diffStat, runLines } from "../../describe.ts";
import { matchKeys } from "../../keys.ts";
import type { ExtensionContext, ExtensionModule } from "../../extension-api.ts";
import { VERSION_PREFIX, versionView, versionViewId } from "../../version.ts";

const history: ExtensionModule = {
  activate(ctx) {
    const panel = new HistoryPanel(ctx);
    ctx.views.register("history", { render: (root) => panel.render(root) });
    ctx.views.provide(VERSION_PREFIX, (id) => versionView(id, (path) => void ctx.workbench.refreshFromServer([path]).then(() => ctx.views.refresh("history"))));
    const show = (scope: "file" | "all") => {
      if (ctx.views.shown() === "history" && panel.scope === scope) return ctx.views.toggle("history");
      panel.scope = scope;
      ctx.views.show("history");
    };
    ctx.commands.register("history.note", () => show("file"));
    ctx.commands.register("history.all", () => show("all"));
    ctx.commands.register("history.addLabel", () => {
      panel.scope = "file";
      panel.labelling = true;
      ctx.views.show("history");
    });
    ctx.events.onSaved(() => ctx.views.refresh("history"));
    ctx.events.onFocus(() => ctx.views.refresh("history"));
  },
};

export default history;

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

async function post<T>(route: string, body: unknown): Promise<T | null> {
  const res = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.ok ? res.json() : null;
}

/** A selection of history rows: plain, ⌘- and Shift-clicks, as in a file manager. */
export class Selection {
  readonly picked = new Set<number>();
  anchor = 0;

  only(i: number, revision: number) {
    this.picked.clear();
    this.picked.add(revision);
    this.anchor = i;
  }

  toggle(i: number, revision: number) {
    if (this.picked.has(revision)) this.picked.delete(revision);
    else this.picked.add(revision);
    this.anchor = i;
  }

  extend(i: number, revisions: number[]) {
    const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
    for (let k = a; k <= b; k++) if (revisions[k] !== undefined) this.picked.add(revisions[k]);
  }
}

class HistoryPanel {
  scope: "file" | "all" = "file";
  labelling = false;
  private root: HTMLElement | null = null;
  private listening = new WeakSet<HTMLElement>();
  private author = "";
  private changes: Change[] = [];
  private labels: Label[] = [];
  private selection = new Selection();
  private focus = 0;
  private diff: FileDiff[] = [];
  private message = "";

  constructor(private ctx: ExtensionContext) {}

  /** Draw into the panel or window it shows in. */
  async render(root: HTMLElement): Promise<void> {
    this.root = root;
    if (!this.listening.has(root)) {
      this.listening.add(root);
      root.tabIndex = -1;
      root.addEventListener("keydown", (e) => this.key(e));
    }
    await this.refresh();
    if (this.labelling) root.querySelector<HTMLInputElement>("input.label-name")?.focus();
  }

  private addLabel() {
    this.labelling = true;
    this.draw();
    this.root?.querySelector<HTMLInputElement>("input.label-name")?.focus();
  }

  private async refresh(): Promise<void> {
    if (!this.root) return;
    const path = this.scope === "file" ? this.ctx.workbench.focusedPath() : null;
    const params = new URLSearchParams({ limit: String(this.ctx.settings.get<number>("history.pageSize")) });
    if (path) params.set("path", path);
    if (this.author) params.set("author", this.author);
    const [changes, labels] = await Promise.all([
      fetch(`/api/history?${params}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/labels${path ? `?path=${encodeURIComponent(path)}` : ""}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    this.changes = changes;
    this.labels = labels;
    for (const r of [...this.selection.picked]) if (!this.changes.some((c) => c.revision === r)) this.selection.picked.delete(r);
    this.focus = Math.min(this.focus, Math.max(0, this.changes.length - 1));
    await this.loadDiff();
  }

  private async loadDiff() {
    const picked = [...this.selection.picked];
    this.diff = picked.length ? ((await post<FileDiff[]>("/api/diff", { revisions: picked })) ?? []) : [];
    this.draw();
  }

  private changed(paths: FilePath[]) {
    void this.ctx.workbench.refreshFromServer([...new Set(paths)]);
    void this.refresh();
  }

  /** Undo changes (newest first), keeping later edits where they don't overlap. */
  private async undo(revisions: number[]) {
    const results = (await post<UndoResult[]>("/api/undo", { revisions })) ?? [];
    const clashed = results.filter((r) => r.status === "conflict").length;
    this.message = clashed
      ? `${clashed === 1 ? "1 change" : `${clashed} changes`} couldn't be reverted: later edits changed the same lines, so ${clashed === 1 ? "it was" : "they were"} left as ${clashed === 1 ? "it is" : "they are"}. Restore to before instead, or edit by hand.`
      : "";
    this.changed(results.flatMap((r) => (r.file ? [r.file.path] : [])));
  }

  /** Put a note back as it was at a revision, or just before a change. */
  private async restore(path: FilePath, at: { revision: Revision } | { before: Revision }, what: string) {
    const result = await post<WriteResult>("/api/restore", { path, ...at });
    this.message = result ? `Restored ${path.replace(/\.md$/, "")} to ${what}, as a new change: undo it to get back what was there.` : `Couldn't restore ${path}.`;
    this.changed([path]);
  }

  private async saveLabel(name: string) {
    const path = this.ctx.workbench.focusedPath();
    if (!path || !name.trim()) return;
    const res = await fetch("/api/labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, name }) });
    const body = await res.json().catch(() => null);
    this.message = res.ok ? `Labelled this version “${name.trim()}”.` : ((body as { error?: string } | null)?.error ?? "Couldn't add the label.");
    this.labelling = false;
    await this.refresh();
  }

  private click(i: number, e: MouseEvent) {
    const c = this.changes[i];
    if (!c) return;
    if (e.shiftKey) this.selection.extend(i, this.changes.map((x) => x.revision));
    else if (e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest(".pick")) this.selection.toggle(i, c.revision);
    else this.selection.only(i, c.revision);
    this.focus = i;
    void this.loadDiff();
  }

  private key(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest("input:not(.pick), select, textarea") || e.metaKey || e.altKey) return;
    const move = (by: number) => {
      const i = Math.max(0, Math.min(this.changes.length - 1, this.focus + by));
      if (e.shiftKey) this.selection.extend(i, this.changes.map((x) => x.revision));
      else if (this.changes[i]) this.selection.only(i, this.changes[i].revision);
      this.focus = i;
      void this.loadDiff();
    };
    const c = this.changes[this.focus];
    const act = (() => {
      if (matchKeys(e, "j") || matchKeys(e, "ArrowDown") || matchKeys(e, "Shift-j") || matchKeys(e, "Shift-ArrowDown")) return () => move(1);
      if (matchKeys(e, "k") || matchKeys(e, "ArrowUp") || matchKeys(e, "Shift-k") || matchKeys(e, "Shift-ArrowUp")) return () => move(-1);
      if ((matchKeys(e, " ") || matchKeys(e, "x")) && c)
        return () => {
          this.selection.toggle(this.focus, c.revision);
          void this.loadDiff();
        };
      if (matchKeys(e, "Enter") && c)
        return () => {
          this.selection.only(this.focus, c.revision);
          void this.loadDiff();
        };
      return null;
    })();
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }

  private draw() {
    if (!this.root) return;
    const path = this.ctx.workbench.focusedPath();
    const scope = el<HTMLSelectElement>("select", { title: "Which changes" }, el("option", { value: "file", textContent: path ? `This note` : "This note (none open)" }), el("option", { value: "all", textContent: "Everything" }));
    scope.value = this.scope;
    scope.addEventListener("change", () => {
      this.scope = scope.value as "file" | "all";
      this.selection.picked.clear();
      void this.refresh();
    });
    const authors = new Map(this.changes.map((c) => [authorKey(c.author), describeAuthor(c.author, this.ctx.me)]));
    if (this.author && !authors.has(this.author)) authors.set(this.author, this.author);
    const who = el<HTMLSelectElement>("select", { title: "By whom" }, el("option", { value: "", textContent: "Anyone" }), ...[...authors].map(([value, textContent]) => el("option", { value, textContent })));
    who.value = this.author;
    who.addEventListener("change", () => {
      this.author = who.value;
      this.selection.picked.clear();
      void this.refresh();
    });
    const undoable = this.changes.filter((c) => !c.undoes && !c.undoneBy);
    const undoAll =
      this.author && undoable.length
        ? el("button", { className: "undo-all", textContent: `Undo all ${undoable.length} by ${authors.get(this.author)}`, onclick: () => void this.undo(undoable.map((c) => c.revision)) })
        : "";
    this.root.replaceChildren(
      el("div", { className: "filters" }, scope, who),
      this.labelForm(path),
      undoAll,
      this.message ? el("p", { className: "message", textContent: this.message }) : "",
      this.changes.length
        ? el("ol", { className: "changes", role: "listbox", ariaMultiSelectable: "true" }, ...this.changes.map((c, i) => this.item(c, i)))
        : el("p", { className: "empty", textContent: "No changes yet." }),
      this.selected(),
    );
  }

  private labelForm(path: FilePath | null): HTMLElement | string {
    if (this.scope !== "file" || !path) return "";
    if (!this.labelling) return el("button", { className: "add-label", textContent: "Add label…", title: "Name this note as it is now", onclick: () => this.addLabel() });
    const input = el<HTMLInputElement>("input", { className: "label-name", placeholder: "Label this version", maxLength: 80 });
    input.addEventListener("keydown", (e) => {
      if (matchKeys(e, "Enter")) void this.saveLabel(input.value);
      if (matchKeys(e, "Escape")) {
        this.labelling = false;
        this.draw();
      }
    });
    return el("div", { className: "label-form" }, input, el("button", { textContent: "Add", onclick: () => void this.saveLabel(input.value) }));
  }

  private item(c: Change, i: number): HTMLElement {
    const picked = this.selection.picked.has(c.revision);
    const box = el<HTMLInputElement>("input", { type: "checkbox", className: "pick", checked: picked, tabIndex: -1, title: `Select change #${c.revision}` });
    const labels = this.labels.filter((l) => l.path === c.path && l.revision === c.revision);
    const stop = (fn: () => unknown) => (e: Event) => {
      e.stopPropagation();
      void fn();
    };
    const row = el(
      "li",
      { className: `change${picked ? " picked" : ""}${i === this.focus ? " focused" : ""}`, role: "option", ariaSelected: String(picked) },
      el(
        "div",
        { className: "summary" },
        box,
        el("span", { className: "who", textContent: describeAuthor(c.author, this.ctx.me) }),
        el("span", { className: "when", textContent: ago(c.time), title: new Date(c.time).toLocaleString() }),
        el("span", { className: "stat", textContent: c.deleted ? "Deleted" : diffStat(c) }),
      ),
      // What the change means, from the extensions that know (todos: "Completed 'Pay rent' (due Oct 1)").
      ...[this.ctx.changes.summary(c)].filter((s) => s).map((s) => el("div", { className: "described", textContent: s })),
      el(
        "div",
        { className: "meta" },
        el("span", { textContent: `#${c.revision}${this.scope === "all" ? ` · ${c.path}` : ""}${c.undoes ? ` · undid #${c.undoes}` : ""}${c.undoneBy ? " · undone" : ""}` }),
        // Undo a change, or redo it by undoing its undo. An undo itself is redone from the change it undid.
        c.undoes ? "" : el("button", { className: "undo", textContent: c.undoneBy ? "Redo" : "Undo", onclick: stop(() => this.undo([c.undoneBy ?? c.revision])) }),
      ),
      ...labels.map((l) =>
        el(
          "div",
          { className: "label" },
          el("span", { className: "label-tag", textContent: l.name, title: `Label at #${l.revision}` }),
          el("button", { textContent: "Open", title: "Open the note as it was at this label, read-only", onclick: stop(() => this.ctx.views.open(versionViewId(l.path, l.revision), { newTab: true })) }),
          el("button", { textContent: "Restore", title: "Put the note back as it was at this label, as a new change", onclick: stop(() => this.restore(l.path, { revision: l.revision }, `“${l.name}”`)) }),
        ),
      ),
    );
    row.addEventListener("mousedown", (e) => e.shiftKey && e.preventDefault());
    row.addEventListener("click", (e) => this.click(i, e));
    return row;
  }

  /** What the selected changes did together, with what can be done about them. */
  private selected(): HTMLElement | string {
    const picked = [...this.selection.picked];
    if (!picked.length) return el("p", { className: "hint", textContent: "Click a change to see what it did. ⌘-click adds or skips one; Shift-click selects a range. j and k move, Space toggles." });
    const revertable = picked.filter((r) => this.changes.some((c) => c.revision === r && !c.undoes));
    return el(
      "section",
      { className: "selected" },
      el(
        "div",
        { className: "actions" },
        el("span", { textContent: picked.length === 1 ? "1 change" : `${picked.length} changes` }),
        revertable.length
          ? el("button", { textContent: picked.length === 1 ? "Revert this change" : "Revert these changes", title: "Undo just these, keeping later edits where they don't overlap", onclick: () => void this.undo(revertable) })
          : "",
      ),
      ...this.diff.map((f) =>
        el(
          "div",
          { className: "file-diff" },
          this.scope === "all" || this.diff.length > 1 ? el("h3", { textContent: f.path }) : "",
          ...f.runs.map((run) =>
            el(
              "div",
              { className: "run" },
              el(
                "div",
                { className: "run-head" },
                el("span", { textContent: run.revisions.length === 1 ? `#${run.revisions[0]}` : `#${run.revisions[0]}–#${run.revisions.at(-1)}` }),
                el("button", {
                  textContent: "Restore to before",
                  title: "Put the note back the way it was before these changes, as a new change (later changes are undone too)",
                  onclick: () => void this.restore(f.path, { before: run.revisions[0] }, "before these changes"),
                }),
              ),
              el("pre", { className: "diff" }, ...runLines(run.before, run.after).map((l) => el("span", { className: l.kind === "+" ? "add" : "del", textContent: `${l.kind} ${l.text}\n` }))),
            ),
          ),
        ),
      ),
    );
  }
}
