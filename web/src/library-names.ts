// The libraries extension code may import by name (ADR 0006): CodeMirror for trusted extensions that
// change editors, and a few of the app's own helpers. Built-ins import them like any package; a
// customized copy in the workspace imports the same names, which the Worker points at /lib/<name>.js,
// a module that hands over the app's own instance (CodeMirror must be one copy). Each common-ink
// module's exports are listed here; a test checks the list against the module.

/** Packages, whose exports are read at build time. */
// Not @codemirror/lang-markdown: offering all of it would keep its markdown(), which brings HTML, CSS and
// JavaScript parsers, in the app's first download. Extensions add to the markdown language through the API.
export const PACKAGES = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/language",
  "@codemirror/language-data",
  "@codemirror/commands",
  "@codemirror/autocomplete",
  "@lezer/highlight",
  "@lezer/markdown",
  "@replit/codemirror-vim",
  "katex",
] as const;

/** The app's own modules, by the name extensions import them as, with what they export. */
export const APP_MODULES = {
  "common-ink/live-preview": { file: "web/src/live-preview.ts", exports: ["blockHeight", "blockPreview", "collapsedBlockAt", "livePreview", "measureBlock", "previewEnabled", "revealedLines", "touches"] },
  "common-ink/describe": { file: "web/src/describe.ts", exports: ["ago", "describeAuthor", "diffLines", "diffStat", "docLabel", "runLines"] },
  "common-ink/layout": { file: "web/src/layout.ts", exports: ["LAYOUT_PATH", "activeFile", "activeTab", "closeTab", "closeTabs", "cycleGroup", "cycleTab", "emptyLayout", "equalize", "fileTab", "focusDirection", "focusGroup", "focused", "groups", "insertTab", "keepFile", "keepTab", "moveTab", "moveTabDirection", "neighbor", "onShow", "only", "openTab", "openableKey", "openableOf", "parseLayout", "rects", "resizeFocused", "resizeSplit", "selectTab", "shiftTab", "showInTab", "split", "splitAt"] },
  "common-ink/editor-file": { file: "web/src/editor-file.ts", exports: ["editorFile"] },
  "common-ink/keys": { file: "web/src/keys.ts", exports: ["IS_MAC", "chord", "formatKeys", "learnLayout", "matchKeys"] },
  "common-ink/recurrence": {
    file: "worker/src/recurrence.ts",
    exports: ["DAY_NAMES", "MONTH_NAMES", "daysBetween", "endsLabel", "formatRule", "isInterval", "nextDue", "nth", "occurrences", "parseRule", "recLabel", "ruleDays", "ruleLabel", "ruleProblem", "shiftDate", "toRRule"],
  },
  "common-ink/calendar": {
    file: "worker/src/calendar.ts",
    exports: ["basicStart", "findTarget", "fullWall", "instantOf", "isTimeZone", "mergeEvents", "newEventId", "occurrenceId", "occurrences", "parseEvent", "parseTiming", "planDelete", "planRevert", "planUpdate", "splitOccurrenceId", "wallTimeAt"],
  },
  "common-ink/query": { file: "worker/src/query.ts", exports: ["FILTERS", "asksFor", "format", "holds", "matches", "matchesWords", "parse", "problems", "select", "sortOf", "titleOf", "tokens"] },
  "common-ink/files": { file: "worker/src/files.ts", exports: ["Files", "SEED_AUTHOR", "authorKey", "isExtensionScript", "isNote", "merge", "parseFilePath"] },
  "common-ink/uploads": {
    file: "worker/src/uploads.ts",
    exports: ["MAX_UPLOAD_BYTES", "UPLOADS_PATH", "addUpload", "blobKey", "cleanName", "findUpload", "isImage", "parseUploads", "placeName", "sha256", "showsInline", "typeFor", "uploadUrl", "uploadsText"],
  },
} as const;

export type LibraryName = (typeof PACKAGES)[number] | keyof typeof APP_MODULES;

export const LIBRARY_NAMES: readonly string[] = [...PACKAGES, ...Object.keys(APP_MODULES)];

/** Where a customized copy's import of a library goes: one of the app's /lib/ modules. */
export const libraryUrl = (name: string) => `/lib/${name}.js`;
