import assert from "node:assert/strict";
import { test } from "node:test";
import { Docs, type DocPath } from "../worker/src/docs.ts";
import { Session, type SaveStatus } from "../web/src/session.ts";
import { memoryDb } from "./sqlite.ts";

const PATH = "Plan.md" as DocPath;
const you = { kind: "user" as const, email: "you@example.com" };
const them = { kind: "agent" as const, name: "Helper" };

/** An editor and a server: the session talks to real Notes, through a write that can be held open. */
function setup(text: string) {
  const notes = new Docs(memoryDb());
  notes.write({ path: PATH, text, base: 0, author: them });
  const editor = { text: notes.read(PATH)!.text };
  const statuses: SaveStatus[] = [];
  let hold: Promise<void> | null = null;
  const session = new Session(
    notes.read(PATH)!,
    { text: () => editor.text, replace: (t) => (editor.text = t) },
    async (path, text, base) => {
      await hold;
      return notes.write({ path, text, base, author: you });
    },
    (s) => statuses.push(s),
  );
  return { notes, editor, session, statuses, holdNextWrite: (until: Promise<void>) => (hold = until) };
}

test("a save sends the edit and moves to the new revision", async () => {
  const { notes, editor, session, statuses } = setup("one\n");
  editor.text = "one\ntwo\n";
  session.edited();
  await session.save();
  editor.text = "one\ntwo\nthree\n";
  await session.save();
  assert.deepEqual(notes.read(PATH), { path: PATH, text: "one\ntwo\nthree\n", revision: 3 });
  assert.deepEqual(
    notes.history(PATH).map((c) => [c.base, c.author]),
    [
      [0, them],
      [1, you],
      [2, you],
    ],
  );
  assert.deepEqual(statuses, ["unsaved", "saving", "saved", "saving", "saved"]);
});

test("nothing to save sends nothing", async () => {
  const { notes, session } = setup("one\n");
  await session.save();
  assert.equal(notes.history(PATH).length, 1);
});

test("an edit made elsewhere is merged in and shows up in the editor", async () => {
  const { notes, editor, session } = setup("one\ntwo\n");
  notes.write({ path: PATH, text: "ONE\ntwo\n", base: 1, author: them });
  editor.text = "one\ntwo\nthree\n";
  await session.save();
  assert.equal(editor.text, "ONE\ntwo\nthree\n");
  assert.equal(session.dirty, false);
  assert.equal(session.status, "saved");
});

test("typing during a merged save is kept, with the merged-in edit added around it", async () => {
  const { notes, editor, session, holdNextWrite } = setup("one\ntwo\n");
  notes.write({ path: PATH, text: "ONE\ntwo\n", base: 1, author: them });
  let release!: () => void;
  holdNextWrite(new Promise((r) => (release = r)));
  editor.text = "one\ntwo\nthree\n";
  const saving = session.save();
  await new Promise((r) => setTimeout(r));
  editor.text = "one\ntwo\nthree\nfour\n";
  release();
  await saving;
  assert.equal(editor.text, "ONE\ntwo\nthree\nfour\n");
  assert.equal(session.status, "unsaved");
  await session.save();
  assert.deepEqual(notes.read(PATH), { path: PATH, text: "ONE\ntwo\nthree\nfour\n", revision: 4 });
  assert.deepEqual(notes.history(PATH).at(-1)?.base, 3);
});

test("a conflict keeps your text, stops saving on pauses, and :e! loads the saved version", async () => {
  const { notes, editor, session } = setup("one\n");
  notes.write({ path: PATH, text: "uno\n", base: 1, author: them });
  editor.text = "ein\n";
  await session.save();
  assert.equal(session.status, "conflict");
  assert.equal(editor.text, "ein\n");
  await session.save();
  assert.equal(notes.history(PATH).length, 2);
  session.reload(notes.read(PATH)!);
  assert.equal(editor.text, "uno\n");
  assert.equal(session.status, "saved");
});

test("a failed request leaves the edit unsaved for the next try", async () => {
  const editor = { text: "a" };
  let fail = true;
  const session = new Session({ path: PATH, text: "a", revision: 1 }, { text: () => editor.text, replace: () => {} }, async (path, text) => {
    if (fail) throw new Error("offline");
    return { status: "saved", doc: { path, text, revision: 2 } };
  });
  editor.text = "ab";
  await session.save();
  assert.equal(session.status, "offline");
  assert.deepEqual(session.unsaved, { path: PATH, text: "ab", base: 1 });
  fail = false;
  await session.save();
  assert.equal(session.status, "saved");
  assert.equal(session.unsaved, null);
});
