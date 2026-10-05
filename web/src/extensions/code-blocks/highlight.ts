// Colours for code, in light and dark, kept to a few so a block reads as code, not confetti.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const c = (light: string, dark: string) => `light-dark(${light}, ${dark})`;

export const codeHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], color: c("#8a2fa8", "#d19bf2") },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: c("#2f7a3a", "#9fd39a") },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--muted)", fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: c("#b0480f", "#f2a96b") },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: c("#1f6d8f", "#79c6e8") },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: c("#2f5fd0", "#8fb0ff") },
    { tag: [t.attributeName, t.propertyName], color: c("#7a5a0f", "#e3c27a") },
    { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--muted)" },
    { tag: t.invalid, color: "#c2410c" },
  ]),
);
