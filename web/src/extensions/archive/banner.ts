// The line at the top of an archived note: it says the note is archived, with Unarchive. The panel is
// there only while its note is in the archive, so other notes' editors are as they were.
import { StateEffect, StateField } from "@codemirror/state";
import { showPanel, ViewPlugin, type EditorView, type Panel } from "@codemirror/view";
import { editorFile } from "common-ink/editor-file";
import { icon } from "common-ink/icons";

export interface BannerEnv {
  archived(path: string): boolean;
  unarchive(path: string): void;
}

const setArchived = StateEffect.define<boolean>();

/** Every note's editor, to tell when the archive changes. */
const views = new Set<EditorView>();

/** Tell each editor whether its note is archived now. */
export function refreshBanners(env: BannerEnv) {
  for (const view of views) {
    const path = view.state.facet(editorFile);
    const archived = !!path && env.archived(path);
    if (archived !== view.state.field(shown, false)) view.dispatch({ effects: setArchived.of(archived) });
  }
}

const shown = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setArchived) ? e.value : v), value),
});

function panel(view: EditorView, env: BannerEnv): Panel {
  const dom = document.createElement("div");
  dom.className = "archive-banner";
  const text = document.createElement("span");
  text.textContent = "Archived: out of the Feed, and last in search.";
  const button = document.createElement("button");
  button.type = "button";
  button.append(icon("archive-restore", 14), "Unarchive");
  button.addEventListener("click", () => {
    const path = view.state.facet(editorFile);
    if (path) env.unarchive(path);
  });
  dom.append(icon("archive", 14), text, button);
  return { dom, top: true };
}

export function archiveBanner(env: BannerEnv) {
  return [
    shown,
    showPanel.compute([shown], (state) => (state.field(shown) ? (view) => panel(view, env) : null)),
    ViewPlugin.define((view) => {
      views.add(view);
      // The editor's note may be set after it's made: say whether it's archived once it's there.
      queueMicrotask(() => refreshBanners(env));
      return { destroy: () => views.delete(view) };
    }),
  ];
}
