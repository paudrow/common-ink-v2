// The line at the top of an archived note: it says the note is archived, with Unarchive. Every note's
// editor has the panel; it shows only while its note is in the archive.
import { showPanel, type EditorView, type Panel } from "@codemirror/view";
import { editorFile } from "common-ink/editor-file";
import { icon } from "common-ink/icons";

export interface BannerEnv {
  archived(path: string): boolean;
  unarchive(path: string): void;
}

/** Each banner on screen, told when the archive changes. */
const banners = new Set<() => void>();

export const refreshBanners = () => banners.forEach((fn) => fn());

export function archiveBanner(env: BannerEnv) {
  return showPanel.of((view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "archive-banner";
    const button = document.createElement("button");
    button.type = "button";
    button.append(icon("archive-restore", 14), "Unarchive");
    button.addEventListener("click", () => {
      const path = view.state.facet(editorFile);
      if (path) env.unarchive(path);
    });
    const text = document.createElement("span");
    text.textContent = "Archived: out of the Feed, and last in search.";
    dom.append(icon("archive", 14), text, button);
    const draw = () => {
      const path = view.state.facet(editorFile);
      dom.hidden = !path || !env.archived(path);
    };
    draw();
    return {
      dom,
      top: true,
      mount: () => void banners.add(draw),
      update: draw,
      destroy: () => void banners.delete(draw),
    };
  });
}
