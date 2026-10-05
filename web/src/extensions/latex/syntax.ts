// Math in markdown, as Pandoc and GitHub write it: $…$ inline, and $$…$$ as a block, on one line or
// with the $$ on lines of their own. Inline math follows Pandoc's rule so prices aren't math: no space
// just inside the dollars, and no digit right after the closing one ("$5 and $10" is text).
import type { MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

const DOLLAR = 36;
const BACKSLASH = 92;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === -1;
const isDigit = (c: number) => c >= 48 && c <= 57;

export const math: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: t.special(t.string) },
    { name: "InlineMathMark", style: t.processingInstruction },
    { name: "BlockMath", block: true, style: t.special(t.string) },
    { name: "BlockMathMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR || isSpace(cx.char(pos + 1))) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === BACKSLASH) i++;
          else if (c === DOLLAR) {
            if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) return -1;
            return cx.addElement(cx.elt("InlineMath", pos, i + 1, [cx.elt("InlineMathMark", pos, pos + 1), cx.elt("InlineMathMark", i, i + 1)]));
          }
        }
        return -1;
      },
      before: "Escape",
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx, line) {
        const text = line.text.slice(line.pos);
        if (!text.startsWith("$$")) return false;
        const from = cx.lineStart + line.pos;
        const rest = text.slice(2);
        const close = rest.indexOf("$$");
        // $$ … $$ on one line: a block only if nothing follows it.
        if (close >= 0) {
          if (rest.slice(close + 2).trim()) return false;
          const end = from + 2 + close + 2;
          cx.addElement(cx.elt("BlockMath", from, end, [cx.elt("BlockMathMark", from, from + 2), cx.elt("BlockMathMark", end - 2, end)]));
          cx.nextLine();
          return true;
        }
        const marks = [cx.elt("BlockMathMark", from, from + 2)];
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          const at = line.text.indexOf("$$");
          end = cx.lineStart + line.text.length;
          if (at >= 0) {
            marks.push(cx.elt("BlockMathMark", cx.lineStart + at, cx.lineStart + at + 2));
            end = cx.lineStart + at + 2;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("BlockMath", from, end, marks));
        return true;
      },
      // A line of its own that's $$ (or $$ … $$) ends a paragraph above it.
      endLeaf: (_cx, line) => /^\$\$(.*\$\$)?\s*$/.test(line.text.slice(line.pos)),
      before: "FencedCode",
    },
  ],
};

/** The TeX in a math node's text: what's between its dollars. */
export function texOf(source: string, block: boolean): string {
  const marks = block ? 2 : 1;
  const inner = source.slice(marks);
  return (inner.endsWith("$".repeat(marks)) ? inner.slice(0, -marks) : inner).trim();
}
