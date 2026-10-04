// The history panel: the changes to the note on show (or to everything), who made each and what it
// changed, with undo and redo. Filtering to one author and undoing everything shown is "undo what
// the agent did".
import { authorKey, type Change, type DocPath, type UndoResult } from "../../worker/src/docs.ts";
import { ago, describeAuthor, diffLines, diffStat } from "./describe.ts";

export interface HistoryDeps {
  me: string | undefined;
  focusedPath(): DocPath | null;
  /** Undo changed these docs on the server. */
  undone(paths: DocPath[]): void;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

export class HistoryPanel {
  private scope: "doc" | "all" = "doc";
  private author = "";
  private changes: Change[] = [];
  private open = new Set<number>();
  private message = "";

  constructor(
    private root: HTMLElement,
    private deps: HistoryDeps,
  ) {}

  get shown(): boolean {
    return !this.root.hidden;
  }

  toggle(scope?: "doc" | "all"): void {
    if (this.shown && (!scope || scope === this.scope)) {
      this.root.hidden = true;
      return;
    }
    if (scope) this.scope = scope;
    this.root.hidden = false;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.shown) return;
    const path = this.scope === "doc" ? this.deps.focusedPath() : null;
    const params = new URLSearchParams({ limit: "200" });
    if (path) params.set("path", path);
    if (this.author) params.set("author", this.author);
    const res = await fetch(`/api/history?${params}`);
    this.changes = res.ok ? await res.json() : [];
    this.render();
  }

  private async undo(revisions: number[]) {
    const res = await fetch("/api/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revisions }) });
    const results: UndoResult[] = res.ok ? await res.json() : [];
    const clashed = results.filter((r) => r.status === "conflict").length;
    this.message = clashed ? `${clashed} couldn't be undone: the same lines have changed since.` : "";
    this.deps.undone([...new Set(results.flatMap((r) => (r.doc ? [r.doc.path] : [])))]);
    await this.refresh();
  }

  private render() {
    const path = this.deps.focusedPath();
    const scope = el<HTMLSelectElement>("select", { title: "Which changes" }, el("option", { value: "doc", textContent: path ? `This note` : "This note (none open)" }), el("option", { value: "all", textContent: "Everything" }));
    scope.value = this.scope;
    scope.addEventListener("change", () => {
      this.scope = scope.value as "doc" | "all";
      void this.refresh();
    });
    const authors = new Map(this.changes.map((c) => [authorKey(c.author), describeAuthor(c.author, this.deps.me)]));
    if (this.author && !authors.has(this.author)) authors.set(this.author, this.author);
    const who = el<HTMLSelectElement>("select", { title: "By whom" }, el("option", { value: "", textContent: "Anyone" }), ...[...authors].map(([value, textContent]) => el("option", { value, textContent })));
    who.value = this.author;
    who.addEventListener("change", () => {
      this.author = who.value;
      void this.refresh();
    });
    const undoable = this.changes.filter((c) => !c.undoes && !c.undoneBy);
    const undoAll =
      this.author && undoable.length
        ? el("button", { className: "undo-all", textContent: `Undo all ${undoable.length} by ${authors.get(this.author)}`, onclick: () => void this.undo(undoable.map((c) => c.revision)) })
        : "";
    const close = el("button", { className: "close", textContent: "×", title: "Close history", onclick: () => this.toggle() });
    this.root.replaceChildren(
      el("header", {}, el("h2", { textContent: "History" }), close),
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
          this.render();
        },
      },
      el("span", { className: "who", textContent: describeAuthor(c.author, this.deps.me) }),
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
