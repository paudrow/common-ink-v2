// The side panel: one plugin view at a time (History, and later others), with a title and a close button.
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
