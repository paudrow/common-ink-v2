import assert from "node:assert/strict";
import { test } from "node:test";
import * as M from "../../web/src/extensions/lists/model.ts";
import { forAll, type Rng } from "./gen.ts";

/**
 * A well-formed outline: lists of bullets ("-" or "*"), numbers or todos, one kind per list, with each
 * item's children indented to where its text starts, blank lines between some items, and paragraphs
 * around the lists (and, with `between`, between top-level lists). Numbers count up from a random first
 * number when `ordered`, and are random otherwise. Every item's text is unique: "t0", "t1"…
 */
function outline(r: Rng, { between = false, ordered = true } = {}): string[] {
  const lines: string[] = [];
  let word = 0;
  const list = (indent: number, depth: number) => {
    const style = r.pick(["-", "*", "number", "todo"]);
    let n = r.int(1, 9);
    for (let k = r.int(1, 4); k > 0; k--) {
      const marker = style === "number" ? `${ordered ? n++ : r.int(1, 12)}.` : style === "*" ? "*" : "-";
      lines.push(`${" ".repeat(indent)}${marker} ${style === "todo" ? r.pick(["[ ] ", "[x] "]) : ""}t${word++}`);
      if (depth < 3 && r.bool(0.35)) list(indent + marker.length + 1, depth + 1);
      if (r.bool(0.15)) lines.push("");
    }
  };
  const paragraph = () => lines.push(...(lines.length && lines.at(-1) !== "" ? [""] : []), `Paragraph ${word++}`, "");
  if (r.bool(0.3)) paragraph();
  for (let k = between ? r.int(1, 3) : 1; k > 0; k--) {
    list(0, 0);
    if (k > 1) paragraph();
  }
  if (r.bool(0.3)) paragraph();
  return lines;
}

const textOf = (line: string) => line.slice(M.parseItem(line)?.contentStart ?? 0).trim();
const items = (lines: readonly string[]) => lines.flatMap((line, i) => (M.parseItem(line) ? [i] : []));
const texts = (lines: readonly string[]) => lines.filter((l) => !M.isBlank(l)).map(textOf).sort();

/**
 * Each item's parent and the item before it in its list, read from indentation alone; a paragraph ends
 * every list. `shallow` names the children indented less than their parent's text (its markerEnd).
 */
function tree(lines: readonly string[]) {
  const parent = new Map<string, string | null>();
  const previous = new Map<string, string | null>();
  const shallow: string[] = [];
  let open: Array<{ indent: number; text: string; markerEnd: number }> = [];
  for (const line of lines) {
    const item = M.parseItem(line);
    if (!item) {
      if (!M.isBlank(line)) open = [];
      continue;
    }
    let before: string | null = null;
    while (open.length && open.at(-1)!.indent >= item.indent) {
      const closed = open.pop()!;
      if (closed.indent === item.indent) before = closed.text;
    }
    parent.set(textOf(line), open.at(-1)?.text ?? null);
    previous.set(textOf(line), before);
    if (open.length && item.indent < open.at(-1)!.markerEnd) shallow.push(textOf(line));
    open.push({ indent: item.indent, text: textOf(line), markerEnd: item.markerEnd });
  }
  const next = new Map([...previous].flatMap(([t, p]) => (p === null ? [] : [[p, t] as const])));
  return { parent: Object.fromEntries(parent), previous, next, shallow };
}

type Case = { lines: string[]; i: number; j: number; kind: M.Kind };
const outlineCase = (options: Parameters<typeof outline>[1]) => (r: Rng): Case => {
  const lines = outline(r, options);
  const all = items(lines);
  return { lines, i: r.pick(all), j: r.int(0, lines.length - 1), kind: r.pick(["bullet", "number", "todo"] as const) };
};

test("indenting, dedenting, moving, converting and renumbering keep every item's text, the number of lines, and children indented as far as their parent's text", () => {
  forAll(outlineCase({ between: true, ordered: false }), ({ lines, i, j, kind }) => {
    const [from, to] = [Math.min(i, j), Math.max(i, j)];
    const results = {
      indent: M.indent(lines, i)?.lines,
      dedent: M.dedent(lines, i)?.lines,
      moveUp: M.moveUp(lines, i)?.lines,
      moveDown: M.moveDown(lines, i)?.lines,
      convert: M.convert(lines, from, to, kind),
      renumberAround: M.renumberAround(lines, [i, j]),
    };
    for (const [op, out] of Object.entries(results)) {
      if (!out) continue;
      assert.equal(out.length, lines.length, `${op} keeps the number of lines`);
      assert.deepEqual(texts(out), texts(lines), `${op} keeps every item's text`);
      assert.deepEqual(tree(out).shallow, [], `${op} keeps children indented as far as their parent's text`);
    }
  });
});

for (const between of [false, true]) {
  test(
    `indent, dedent, move up and move down take an item's children with it and change only its own place${between ? ", with paragraphs between lists" : ""}`,
    () => {
      forAll(outlineCase({ between }), ({ lines, i }) => {
        const before = tree(lines);
        const t = textOf(lines[i]);
        const prev = before.previous.get(t) ?? null;
        const next = before.next.get(t) ?? null;

        const indented = M.indent(lines, i);
        assert.equal(!!indented, prev !== null, "indent works when the item has one before it in its list");
        if (indented) assert.deepEqual(tree(indented.lines).parent, { ...before.parent, [t]: prev }, "indent puts it under the item before it");

        const dedented = M.dedent(lines, i);
        const parent = before.parent[t];
        assert.equal(!!dedented, parent !== null, "dedent works when the item is in a parent");
        if (dedented) {
          const after = tree(dedented.lines);
          assert.deepEqual(after.parent, { ...before.parent, [t]: before.parent[parent!] }, "dedent takes it out of its parent, whose other children stay");
          assert.equal(after.previous.get(t), parent, "it comes right after its old parent");
        }

        const up = M.moveUp(lines, i);
        assert.equal(!!up, prev !== null, "move up works when the item has one before it in its list");
        if (up) {
          const after = tree(up.lines);
          assert.deepEqual(after.parent, before.parent, "moving up changes no item's parent");
          assert.deepEqual([after.previous.get(prev!), after.previous.get(t)], [t, before.previous.get(prev!)], "it swaps places with the item before it");
          assert.equal(textOf(up.lines[up.at]), t, "the edit says where it went");
        }

        const down = M.moveDown(lines, i);
        assert.equal(!!down, next !== null, "move down works when the item has one after it in its list");
        if (down) {
          const after = tree(down.lines);
          assert.deepEqual(after.parent, before.parent, "moving down changes no item's parent");
          assert.deepEqual([after.previous.get(next!), after.previous.get(t)], [prev, next], "it swaps places with the item after it");
          assert.equal(textOf(down.lines[down.at]), t, "the edit says where it went");
        }
      });
    },
  );

  test(
    `indenting an item and dedenting it straight back, or moving it up and back down, leaves the outline as it was${between ? ", with paragraphs between lists" : ""}`,
    () => {
      forAll(outlineCase({ between }), ({ lines, i }) => {
        const indented = M.indent(lines, i);
        if (indented) assert.deepEqual(M.dedent(indented.lines, indented.at)?.lines, lines, "indent, then dedent");
        const up = M.moveUp(lines, i);
        if (up) assert.deepEqual(M.moveDown(up.lines, up.at)?.lines, lines, "move up, then down");
        const down = M.moveDown(lines, i);
        if (down) assert.deepEqual(M.moveUp(down.lines, down.at)?.lines, lines, "move down, then up");
      });
    },
  );

  test(
    `renumbering every line counts each numbered list up from its first number, and renumbering again changes nothing${between ? ", with paragraphs between lists" : ""}`,
    () => {
      forAll(outlineCase({ between, ordered: false }), ({ lines, i, j }) => {
        const out = M.renumberAround(lines, lines.map((_, k) => k));
        const { previous, next } = tree(out);
        const numberOf = new Map(items(out).map((k) => [textOf(out[k]), M.parseItem(out[k])!.number]));
        for (const k of items(out)) {
          const t = textOf(out[k]);
          const starts = numberOf.get(t) !== undefined && numberOf.get(previous.get(t) ?? "") === undefined;
          if (!starts) continue;
          const run: Array<number | undefined> = [];
          for (let at: string | undefined = t; at !== undefined && numberOf.get(at) !== undefined; at = next.get(at)) run.push(numberOf.get(at));
          const first = M.parseItem(lines[k])!.number!;
          assert.deepEqual(run, run.map((_, n) => first + n), `the list starting at ${t}`);
        }
        assert.deepEqual(M.renumberAround(out, [i, j]), out);
        const some = M.renumberAround(lines, [i, j]);
        assert.deepEqual(M.renumberAround(some, [i, j]), some);
      });
    },
  );
}

test("converting items makes each one in the range the kind asked for, keeping its children under it", () => {
  forAll(outlineCase({ between: true, ordered: false }), ({ lines, i, j, kind }) => {
    const [from, to] = [Math.min(i, j), Math.max(i, j)];
    const out = M.convert(lines, from, to, kind);
    for (const k of items(lines).filter((k) => k >= from && k <= to)) assert.equal(M.parseItem(out[k])?.kind, kind, `line ${k}`);
    assert.deepEqual(tree(out).parent, tree(lines).parent);
  });
});
