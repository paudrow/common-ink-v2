// The history panel, a built-in plugin: the changes to the note on show (or to everything), who made
// each and what it changed, with undo and redo. Filtering to one author and undoing everything shown
// is "undo what the agent did".
import { authorKey, type Change, type UndoResult } from "../../../worker/src/docs.ts";
import { ago, describeAuthor, diffLines, diffStat } from "../describe.ts";
import type { Plugin, PluginContext } from "../plugins.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

export const historyPlugin: Plugin = {
  id: "history",
  description: "The history panel: changes with authors and diffs, undo and redo.",
  activate(ctx) {
    const panel = new HistoryPanel(ctx);
    ctx.panels.register({ id: "history", title: "History", render: (root) => panel.render(root) });
    const show = (scope: "doc" | "all") => {
      if (ctx.panels.shown() === "history" && panel.scope === scope) return ctx.panels.toggle("history");
      panel.scope = scope;
      ctx.panels.show("history");
    };
    ctx.commands.register(
      { id: "history.note", title: "Show history of this note", run: () => show("doc") },
      { id: "history.all", title: "Show history of everything", run: () => show("all") },
    );
    ctx.events.onSaved(() => ctx.panels.refresh("history"));
    ctx.events.onFocus(() => ctx.panels.refresh("history"));
  },
};

class HistoryPanel {
  scope: "doc" | "all" = "doc";
  private author = "";
  private changes: Change[] = [];
  private open = new Set<number>();
  private message = "";
  private root: HTMLElement | null = null;

  constructor(private ctx: PluginContext) {}

  async render(root: HTMLElement): Promise<void> {
    this.root = root;
    const path = this.scope === "doc" ? this.ctx.workbench.focusedPath() : null;
    const params = new URLSearchParams({ limit: "200" });
    if (path) params.set("path", path);
    if (this.author) params.set("author", this.author);
    const res = await fetch(`/api/history?${params}`);
    this.changes = res.ok ? await res.json() : [];
    this.draw();
  }

  private refresh() {
    if (this.root) void this.render(this.root);
  }

  private async undo(revisions: number[]) {
    const res = await fetch("/api/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revisions }) });
    const results: UndoResult[] = res.ok ? await res.json() : [];
    const clashed = results.filter((r) => r.status === "conflict").length;
    this.message = clashed ? `${clashed} couldn't be undone: the same lines have changed since.` : "";
    await this.ctx.workbench.refreshFromServer([...new Set(results.flatMap((r) => (r.doc ? [r.doc.path] : [])))]);
    this.refresh();
  }

  private draw() {
    const path = this.ctx.workbench.focusedPath();
    const scope = el<HTMLSelectElement>("select", { title: "Which changes" }, el("option", { value: "doc", textContent: path ? `This note` : "This note (none open)" }), el("option", { value: "all", textContent: "Everything" }));
    scope.value = this.scope;
    scope.addEventListener("change", () => {
      this.scope = scope.value as "doc" | "all";
      this.refresh();
    });
    const authors = new Map(this.changes.map((c) => [authorKey(c.author), describeAuthor(c.author, this.ctx.me)]));
    if (this.author && !authors.has(this.author)) authors.set(this.author, this.author);
    const who = el<HTMLSelectElement>("select", { title: "By whom" }, el("option", { value: "", textContent: "Anyone" }), ...[...authors].map(([value, textContent]) => el("option", { value, textContent })));
    who.value = this.author;
    who.addEventListener("change", () => {
      this.author = who.value;
      this.refresh();
    });
    const undoable = this.changes.filter((c) => !c.undoes && !c.undoneBy);
    const undoAll =
      this.author && undoable.length
        ? el("button", { className: "undo-all", textContent: `Undo all ${undoable.length} by ${authors.get(this.author)}`, onclick: () => void this.undo(undoable.map((c) => c.revision)) })
        : "";
    this.root?.replaceChildren(
      el("div", { className: "filters" }, scope, who),
      undoAll,
      this.message ? el("p", { className: "message", textContent: this.message }) : "",
      this.changes.length ? el("ol", {}, ...this.changes.map((c) => this.item(c))) : el("p", { className: "empty", textContent: "No changes yet." }),
    );
  }

  private item(c: Change): HTMLElement {
    const expanded = this.open.has(c.revision);
    const summary = el(
      "button",
      {
        className: "summary",
        ariaExpanded: String(expanded),
        onclick: () => {
          if (expanded) this.open.delete(c.revision);
          else this.open.add(c.revision);
          this.draw();
        },
      },
      el("span", { className: "who", textContent: describeAuthor(c.author, this.ctx.me) }),
      el("span", { className: "when", textContent: ago(c.time), title: new Date(c.time).toLocaleString() }),
      el("span", { className: "stat", textContent: diffStat(c) }),
    );
    const details = expanded
      ? el(
          "pre",
          { className: "diff" },
          ...diffLines(c).map((l) => el("span", { className: l.kind === "+" ? "add" : "del", textContent: `${l.kind} ${l.text}\n` })),
        )
      : "";
    return el(
      "li",
      {},
      summary,
      el(
        "div",
        { className: "meta" },
        el("span", { textContent: `#${c.revision}${this.scope === "all" ? ` · ${c.path}` : ""}${c.undoes ? ` · undid #${c.undoes}` : ""}${c.undoneBy ? " · undone" : ""}` }),
        // Undo a change, or redo it by undoing its undo. An undo itself is redone from the change it undid.
        c.undoes ? "" : el("button", { className: "undo", textContent: c.undoneBy ? "Redo" : "Undo", onclick: () => void this.undo([c.undoneBy ?? c.revision]) }),
      ),
      details,
    );
  }
}
