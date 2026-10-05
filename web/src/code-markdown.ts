// What a ```markdown code block parses with: the notes' own markdown language. The build points
// @codemirror/language-data's Markdown entry here (vite.config.ts) instead of at lang-markdown's
// markdown(), which would bring HTML, CSS and JavaScript parsers into the app's first download.
import { markdownLanguageSupport } from "./editor.ts";

export const markdown = () => markdownLanguageSupport();
