import assert from "node:assert/strict";
import { test } from "node:test";
import { Files, type FilePath } from "../worker/src/files.ts";
import { Session, type SaveStatus } from "../web/src/session.ts";
import { memoryDb } from "./sqlite.ts";

const PATH = "Plan.md" as FilePath;
const you = { kind: "user" as const, email: "you@example.com" };
const them = { kind: "agent" as const, name: "Helper" };

/** An editor and a server: the session talks to real Notes, through a write that can be held open. */
function setup(text: string) {
  const notes = new Files(memoryDb());
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

test("a failed request leaves the edit unsaved for the next try, sent again with the same id", async () => {
  const editor = { text: "a" };
  let fail = true;
  const sent: string[] = [];
  const session = new Session({ path: PATH, text: "a", revision: 1 }, { text: () => editor.text, replace: () => {} }, async (path, text, _base, edit) => {
    sent.push(edit);
    if (fail) throw new Error("offline");
    return { status: "saved", file: { path, text, revision: 2 } };
  });
  editor.text = "ab";
  await session.save();
  assert.equal(session.status, "offline");
  assert.deepEqual(session.unsaved, { path: PATH, text: "ab", base: 1, edit: sent[0] });
  // The same text is the same edit, so the server can tell it's had it; new text is a new one.
  await session.save();
  assert.equal(sent[1], sent[0]);
  editor.text = "abc";
  const next = session.unsaved?.edit;
  assert.notEqual(next, sent[0]);
  fail = false;
  await session.save();
  assert.equal(sent[2], next);
  assert.equal(session.status, "saved");
  assert.equal(session.unsaved, null);
});

test("a session opened on a kept edit sends it with the id it was kept with", async () => {
  const sent: string[] = [];
  const session = new Session(
    { path: PATH, text: "a", revision: 1 },
    { text: () => "ab", replace: () => {} },
    async (path, text, _base, edit) => {
      sent.push(edit);
      return { status: "saved", file: { path, text, revision: 2 } };
    },
    undefined,
    "saved",
    { id: "kept", text: "ab" },
  );
  await session.save();
  assert.deepEqual(sent, ["kept"]);
});

test("someone else's change reaches a note with unsaved typing, and the typing stays", async () => {
  const { notes, editor, session } = setup("one\ntwo\nthree\n");
  editor.text = "one\ntwo\nthree\nmine\n";
  notes.write({ path: PATH, text: "ONE\ntwo\nthree\n", base: 1, author: them });
  await session.absorb(notes.read(PATH)!);
  assert.equal(editor.text, "ONE\ntwo\nthree\nmine\n");
  assert.equal(session.status, "unsaved");
  await session.save();
  assert.equal(notes.read(PATH)?.text, "ONE\ntwo\nthree\nmine\n");
});

test("a remote change to the lines being typed on keeps the typing and says it clashes", async () => {
  const { notes, editor, session } = setup("one\n");
  editor.text = "mine\n";
  notes.write({ path: PATH, text: "theirs\n", base: 1, author: them });
  await session.absorb(notes.read(PATH)!);
  assert.equal(editor.text, "mine\n");
  assert.equal(session.status, "conflict");
});

test("news of a change this session already has, such as its own save, changes nothing", async () => {
  const { notes, editor, session } = setup("one\n");
  editor.text = "one\ntwo\n";
  await session.save();
  const before = editor.text;
  await session.absorb(notes.read(PATH)!);
  assert.equal(editor.text, before);
  assert.equal(session.status, "saved");
});

test("after a clash, adopting the server's version keeps the editor's text, and a save puts it over theirs", async () => {
  const { notes, editor, session, statuses } = setup("a\nb\nc\n");
  editor.text = "a\nb mine\nc\n";
  session.edited();
  notes.write({ path: PATH, text: "a\nb theirs\nc\n", base: 1, author: them });
  await session.absorb(notes.read(PATH)!);
  assert.equal(statuses.at(-1), "conflict");
  await session.save();
  assert.equal(notes.read(PATH)!.text, "a\nb theirs\nc\n", "no save while it clashes");
  await session.adopt(notes.read(PATH)!);
  assert.deepEqual([editor.text, statuses.at(-1)], ["a\nb mine\nc\n", "unsaved"]);
  await session.save(true);
  assert.deepEqual(notes.read(PATH), { path: PATH, text: "a\nb mine\nc\n", revision: 3 });
  assert.equal(statuses.at(-1), "saved");
});

test("text put back after it was saved is a new edit, with a new id: the server doesn't take it for the old one", async () => {
  const editor = { text: "a" };
  const sent: string[] = [];
  const session = new Session({ path: PATH, text: "a", revision: 1 }, { text: () => editor.text, replace: (t) => (editor.text = t) }, async (path, text, base, edit) => {
    sent.push(edit);
    return { status: "saved", file: { path, text, revision: base + 1 } };
  });
  editor.text = "ab";
  await session.save();
  editor.text = "a";
  await session.save();
  editor.text = "ab";
  await session.save();
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 3);
});

test("a clash undone back to what it was based on is no clash: the session is saved", async () => {
  const editor = { text: "one\ntwo\n" };
  const session = new Session({ path: PATH, text: "one\ntwo\n", revision: 1 }, { text: () => editor.text, replace: (t) => (editor.text = t) }, async (path) => ({ status: "conflict", file: { path, text: "ONE\ntwo\n", revision: 2 } }));
  editor.text = "uno\ntwo\n";
  session.edited();
  await session.save();
  assert.equal(session.status, "conflict");
  editor.text = "one\ntwo\n";
  session.edited();
  assert.equal(session.status, "saved");
});
