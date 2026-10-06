// Change one top-level key of a JSON settings file without touching the rest of it: its order, its
// spacing and every other value stay exactly as they were, so the file's history shows just that key.

interface Span {
  key: string;
  /** From the key's opening quote to the end of its value. */
  start: number;
  end: number;
  valueStart: number;
}

/** The top-level keys of an object, and where each sits. Null if the text isn't a JSON object. */
export function topLevelKeys(text: string): { keys: Span[]; open: number; close: number } | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const string = () => {
    i++; // the opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
  };
  // Skip one value: a string, or anything nested up to its matching bracket, or a bare word or number.
  const value = () => {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{" || text[i] === "[") {
      let depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === '"') {
          string();
          continue;
        }
        if (c === "{" || c === "[") depth++;
        if (c === "}" || c === "]") depth--;
        i++;
        if (depth === 0) return;
      }
      return;
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  };
  ws();
  if (text[i] !== "{") return null;
  const open = i++;
  const keys: Span[] = [];
  for (;;) {
    ws();
    if (text[i] === "}") return { keys, open, close: i };
    if (text[i] !== '"') return null;
    const start = i;
    string();
    let key: string;
    try {
      key = JSON.parse(text.slice(start, i));
    } catch {
      return null;
    }
    ws();
    if (text[i] !== ":") return null;
    i++;
    ws();
    const valueStart = i;
    value();
    if (i === valueStart) return null;
    keys.push({ key, start, end: i, valueStart });
    ws();
    if (text[i] === ",") i++;
    else if (text[i] !== "}") return null;
  }
}

/**
 * Set a top-level key to `value`, or remove it with `undefined`. A key that's there keeps its place;
 * a new one goes at the end, indented like the others. Null if the text isn't a JSON object.
 */
export function setTopLevelKey(text: string, key: string, value: unknown): string | null {
  const source = text.trim() ? text : "{}\n";
  const parsed = topLevelKeys(source);
  if (!parsed) return null;
  const { keys, close } = parsed;
  // Written twice, JSON.parse reads the last copy: the later ones go, so the one set is the one read.
  const copies = keys.flatMap((k, i) => (k.key === key ? [i] : []));
  if (copies.length > 1) return setTopLevelKey(removeAt(source, parsed, copies.at(-1)!), key, value);
  const at = copies[0] ?? -1;
  const indent = keys.length ? (/\n([ \t]*)$/.exec(source.slice(0, keys[0].start))?.[1] ?? "  ") : "  ";
  const json = JSON.stringify(value, null, 2)?.replace(/\n/g, `\n${indent}`);
  if (at >= 0) {
    if (value !== undefined) return source.slice(0, keys[at].valueStart) + json + source.slice(keys[at].end);
    return removeAt(source, parsed, at);
  }
  if (value === undefined) return source;
  const entry = `${JSON.stringify(key)}: ${json}`;
  if (!keys.length) return `${source.slice(0, close).replace(/\s*$/, "")}\n${indent}${entry}\n${source.slice(close)}`;
  const last = keys.at(-1)!;
  return `${source.slice(0, last.end)},\n${indent}${entry}${source.slice(last.end)}`;
}

/** The text without its `at`th top-level key, and the comma that went with it: the one after it, or before it if it's the last. */
function removeAt(source: string, parsed: NonNullable<ReturnType<typeof topLevelKeys>>, at: number): string {
  const { keys } = parsed;
  const k = keys[at];
  if (at < keys.length - 1) return source.slice(0, k.start) + source.slice(keys[at + 1].start);
  const prevEnd = at > 0 ? keys[at - 1].end : parsed.open + 1;
  return source.slice(0, prevEnd) + source.slice(k.end).replace(/^[\s,]*(?=\s*\})/, "\n");
}
