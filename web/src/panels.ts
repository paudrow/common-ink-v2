// The side panel: one plugin view at a time (History, and later others), with a title and a close
// button. Any panel also opens in a window as a tab (workbench.ts).
import { endDrag, startDrag } from "./dnd.ts";
import type { Panel } from "./plugins.ts";

export class Panels {
  private panels = new Map<string, Panel>();
  private showing: string | null = null;
  private body = document.createElement("div");
  private title = document.createElement("h2");

  constructor(private root: HTMLElement) {
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Close the panel";
    close.addEventListener("click", () => this.hide());
    const header = document.createElement("header");
    header.append(this.title, close);
    // Drag the title into a window to open the panel there.
    this.title.draggable = true;
    this.title.title = "Drag into a window to open it there";
    this.title.addEventListener("dragstart", (e) => {
      if (this.showing) startDrag(e, { item: { view: this.showing } }, this.title.textContent ?? "");
    });
    this.title.addEventListener("dragend", endDrag);
    this.body.className = "panel-body";
    root.append(header, this.body);
    root.hidden = true;
  }

  register(panel: Panel): void {
    this.panels.set(panel.id, panel);
  }

  shown(): string | null {
    return this.showing;
  }

  show(id: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    this.showing = id;
    this.title.textContent = panel.title;
    this.root.hidden = false;
    void panel.render(this.body);
  }

  toggle(id: string): void {
    if (this.showing === id) this.hide();
    else this.show(id);
  }

  refresh(id: string): void {
    if (this.showing === id) void this.panels.get(id)!.render(this.body);
  }

  hide(): void {
    this.showing = null;
    this.root.hidden = true;
  }
}
