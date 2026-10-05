// The app's instances of the libraries extensions may import (library-names.ts), loaded on first use.
// The /lib/<name>.js modules a customized extension imports ask for them through
// globalThis.__commonInkLibrary, so every extension shares the app's one copy of CodeMirror.
import type { LibraryName } from "./library-names.ts";

const LOADERS: Record<LibraryName, () => Promise<unknown>> = {
  "@codemirror/state": () => import("@codemirror/state"),
  "@codemirror/view": () => import("@codemirror/view"),
  "@codemirror/language": () => import("@codemirror/language"),
  "@codemirror/language-data": () => import("@codemirror/language-data"),
  "@lezer/markdown": () => import("@lezer/markdown"),
  katex: () => import("katex"),
  "@codemirror/commands": () => import("@codemirror/commands"),
  "@codemirror/autocomplete": () => import("@codemirror/autocomplete"),
  "@lezer/highlight": () => import("@lezer/highlight"),
  "@replit/codemirror-vim": () => import("@replit/codemirror-vim"),
  "common-ink/live-preview": () => import("./live-preview.ts"),
  "common-ink/describe": () => import("./describe.ts"),
  "common-ink/keys": () => import("./keys.ts"),
  "common-ink/editor-file": () => import("./editor-file.ts"),
  "common-ink/layout": () => import("./layout.ts"),
  "common-ink/files": () => import("../../worker/src/files.ts"),
  "common-ink/uploads": () => import("../../worker/src/uploads.ts"),
};

/** Offer the libraries to the /lib/ modules. */
export function offerLibraries(): void {
  (globalThis as { __commonInkLibrary?: (name: string) => Promise<unknown> }).__commonInkLibrary = (name) => {
    const load = LOADERS[name as LibraryName];
    return load ? load() : Promise.reject(new Error(`No library "${name}"`));
  };
}
