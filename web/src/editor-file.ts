// Which file an editor shows, for what's drawn in it (embeds, extensions' widgets) to know.
import { Facet } from "@codemirror/state";
import type { FilePath } from "../../worker/src/files.ts";

/** The file an editor shows, or null. */
export const editorFile = Facet.define<FilePath | null, FilePath | null>({ combine: (values) => values.at(-1) ?? null });
