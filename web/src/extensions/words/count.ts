// How many words a note has, as a reader would count them: markdown's marks, link addresses, HTML tags,
// code, math and widget lines aren't words. Words are what the browser's word breaker says they are, so
// CJK text counts too. Kept line by line, so an edit reads again only the lines it touched.
import { Text, type ChangeSet } from "@codemirror/state";

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
/** A quote's >, a list item's bullet or number, and a task's checkbox: "> 1. ", "- [x] ". */
const MARKS = /^[ \t>]*(?:(?:\d+[.)]|[-*+])[ \t]+)?(?:\[[ xX]\][ \t])?/;
const AUTOLINK = /<https?:\/\/[^\s>]*>/g;
const TAG = /<!--.*?-->|<\/?[A-Za-z][^>]*>/g;
const LINK_TARGET = /\]\([^)]*\)/g;
const URL = /\bhttps?:\/\/\S+/g;
/** Quotes' >, then at most three spaces: indented four, it's not a fence (CommonMark). */
const LEAD = String.raw`^(?:[ ]{0,3}>[ ]?)*[ ]{0,3}`;
const FENCE = new RegExp(`${LEAD}(\`{3,}|~{3,})(.*)$`);
const FENCE_END = new RegExp(`${LEAD}(\`{3,}|~{3,})[ \t]*$`);
/** `$$` alone opens a math block; `$$ … $$` alone on a line is one. A line that only starts with $$ is prose. */
const MATH_OPEN = new RegExp(`${LEAD}\\$\\$[ \t]*$`);
const MATH_LINE = new RegExp(`${LEAD}\\$\\$.*\\$\\$[ \t]*$`);
/** `::timer{duration=25m}`, `:::kanban`, and the `:::` that closes it. */
const DIRECTIVE = /^[ \t]*:{2,}(?:[A-Za-z][\w-]*)?(?:\[[^\]]*\])?(?:\{.*\})?[ \t]*$/;

/** What a line leaves open for the next: "" for nothing, a code fence's marker, or "$$" for math. */
type Block = string;

function countProse(line: string): number {
  const text = line.replace(MARKS, "").replace(AUTOLINK, " link ").replace(TAG, " ").replace(LINK_TARGET, "]").replace(URL, "link");
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
}

/** A line's words, given the block it's in, and the block it leaves open. */
function readLine(text: string, block: Block): [number, Block] {
  if (block === "$$") return [0, text.includes("$$") ? "" : "$$"];
  if (block) {
    const end = FENCE_END.exec(text);
    return [0, end && end[1][0] === block[0] && end[1].length >= block.length ? "" : block];
  }
  const fence = FENCE.exec(text);
  // A backtick fence's language can't have a backtick in it: "```a``` b" is inline code.
  if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) return [0, fence[1]];
  if (MATH_OPEN.test(text)) return [0, "$$"];
  if (MATH_LINE.test(text)) return [0, ""];
  if (DIRECTIVE.test(text)) return [0, ""];
  return [countProse(text), ""];
}

/** Replace `remove` items at `at` with `add` copies of `value`, a chunk at a time: a big paste would overflow one call's arguments. */
function splice<T>(list: T[], at: number, remove: number, add: number, value: T) {
  list.splice(at, remove);
  for (let done = 0; done < add; done += 10_000) list.splice(at + done, 0, ...new Array<T>(Math.min(10_000, add - done)).fill(value));
}

/** A note's word count, kept up to date edit by edit. */
export class WordTally {
  total = 0;
  /** Each line's words, and the block it leaves open; null while a line waits to be read again. */
  private words: number[] = [];
  private blocks: Array<Block | null> = [];

  constructor(public doc: Text) {
    let block: Block = "";
    for (const iter = doc.iterLines(); !iter.next().done; ) {
      const [n, after] = readLine(iter.value, block);
      this.words.push(n);
      this.blocks.push((block = after));
      this.total += n;
    }
  }

  /**
   * Bring the count up to `doc`, the text after `changes`. Only the lines they touched are read again,
   * and the lines after those whose block they changed (a code fence opened, say). Returns how many lines it read.
   */
  update(changes: ChangeSet, doc: Text): number {
    const old = this.doc;
    // The old and new lines each change covers, merged where two changes share a line.
    const spans: Array<[number, number, number, number]> = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      const [a1, a2, b1, b2] = [old.lineAt(fromA).number, old.lineAt(toA).number, doc.lineAt(fromB).number, doc.lineAt(toB).number];
      const last = spans.at(-1);
      if (last && a1 <= last[1]) [last[1], last[3]] = [a2, b2];
      else spans.push([a1, a2, b1, b2]);
    });
    // Last first, so the line numbers of the spans before it stay right.
    for (const [a1, a2, b1, b2] of [...spans].reverse()) {
      for (let i = a1 - 1; i < a2; i++) this.total -= this.words[i];
      // The lines after saw the block the old last line left open: the new last line keeps it, to compare.
      const end = this.blocks[a2 - 1];
      splice(this.words, a1 - 1, a2 - a1 + 1, b2 - b1 + 1, 0);
      splice<Block | null>(this.blocks, a1 - 1, a2 - a1 + 1, b2 - b1 + 1, null);
      this.blocks[a1 - 1 + b2 - b1] = end;
    }
    let read = 0;
    let next = 1;
    for (const [, , b1, b2] of spans) {
      for (let n = Math.max(b1, next); n <= doc.lines; n++) {
        const [words, after] = readLine(doc.line(n).text, n > 1 ? this.blocks[n - 2]! : "");
        const was = this.blocks[n - 1];
        this.total += words - this.words[n - 1];
        this.words[n - 1] = words;
        this.blocks[n - 1] = after;
        read++;
        next = n + 1;
        // Past the change, a line that leaves the same block open as before leaves the lines after it as they were.
        if (n >= b2 && after === was) break;
      }
    }
    this.doc = doc;
    return read;
  }
}

export function countWords(markdown: string): number {
  return new WordTally(Text.of(markdown.split("\n"))).total;
}
