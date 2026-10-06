// How many words a note has, as a reader would count them: markdown's marks and link addresses aren't
// words. Words are what the browser's word breaker says they are, so CJK text counts too.

const words = new Intl.Segmenter(undefined, { granularity: "word" });
/** A list item's number, and a task's checkbox: "1. ", "- [x] ". Bullets and # aren't word-like anyway. */
const MARKS = /^[ \t>]*(?:(?:\d+[.)]|[-*+])[ \t]+)?(?:\[[ xX]\][ \t])?/gm;
const LINK_TARGET = /\]\([^)]*\)/g;
const URL = /\bhttps?:\/\/\S+/g;

export function countWords(markdown: string): number {
  const text = markdown.replace(LINK_TARGET, "]").replace(URL, "link").replace(MARKS, "");
  let n = 0;
  for (const s of words.segment(text)) if (s.isWordLike) n++;
  return n;
}
