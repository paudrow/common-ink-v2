// The side panel: one extension view at a time (History, and later others), with a title and a close
// button. Any panel also opens in a window as a tab (workbench.ts); its title says what it opens
// (data-open), for the Workbench extension's dragging.
import type { View as Panel } from "./workbench.ts";
import { drawSafely } from "./boundary.ts";

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
    // Drag the title into a window to open the panel there (with the Workbench extension).
    this.title.draggable = true;
    this.title.title = "Drag into a window to open it there";
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

  /** Where a panel shows instead, when the app has no room beside the windows (the phone shell): true if it did. */
  elsewhere: (id: string) => boolean = () => false;

  show(id: string): void {
    const panel = this.panels.get(id);
    if (!panel || this.elsewhere(id)) return;
    this.showing = id;
    this.title.textContent = panel.title;
    this.title.dataset.open = JSON.stringify({ view: id });
    this.root.hidden = false;
    drawSafely(this.body, panel.title, () => panel.render(this.body));
  }

  toggle(id: string): void {
    if (this.showing === id) this.hide();
    else this.show(id);
  }

  refresh(id: string): void {
    const panel = this.showing === id ? this.panels.get(id)! : null;
    if (panel) drawSafely(this.body, panel.title, () => panel.render(this.body));
  }

  hide(): void {
    this.showing = null;
    this.root.hidden = true;
  }
}
