// A line diff that stays quick on long notes. node-diff3's diffPatch slows to seconds on thousands
// of lines when many repeat (blank lines do): the lines that match at either end are left out of it.
import { diffPatch } from "node-diff3";

export function linePatch(a: string[], b: string[]): ReturnType<typeof diffPatch<string>> {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return diffPatch(a.slice(start, a.length - end), b.slice(start, b.length - end)).map(({ buffer1, buffer2 }) => ({
    buffer1: { ...buffer1, offset: buffer1.offset + start },
    buffer2: { ...buffer2, offset: buffer2.offset + start },
  }));
}
