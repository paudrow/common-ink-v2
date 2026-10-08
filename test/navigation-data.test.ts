// A workspace database navigation-1-14 wrote (the navigation redesign, taken out for now) opens and
// works here. test/fixtures/navigation-workspace.sql is one, written by that branch's own code: a note
// archived, one pinned, one in Trash, one deleted forever by hand and one by Trash retention, places.json,
// a device's files, trash.retentionDays, and its search index (an FTS5 table) and its columns of history.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emptyWorkspace, openWorkspace, undoChanges } from "../worker/src/data-sources.ts";
import type { Author, FilePath } from "../worker/src/files.ts";
import { memoryDb } from "./sqlite.ts";

const ada: Author = { kind: "user", email: "ada@example.com" };

function navigationWorkspace() {
  const db = memoryDb();
  db.raw.exec(readFileSync(new URL("./fixtures/navigation-workspace.sql", import.meta.url), "utf8"));
  return { db, ...openWorkspace(db, { fixtures: false, google: null }) };
}

test("a workspace navigation wrote lists and reads every file it has, its archive, pins, places and device files as plain JSON", () => {
  const { files } = navigationWorkspace();
  assert.deepEqual(
    files.list().map((f) => f.path),
    [
      ".common-ink/archive.json",
      ".common-ink/pins.json",
      ".common-ink/places.json",
      ".common-ink/settings.json",
      ".common-ink/users/ada@example.com/devices/laptop-1/device.json",
      ".common-ink/users/ada@example.com/devices/laptop-1/layout.json",
      "Archived.md",
      "Keep.md",
      "Pinned.md",
    ],
  );
  assert.equal(files.read("Archived.md" as FilePath)?.text, "# Archived\n\nOut of the Feed.\n");
  assert.equal(files.read(".common-ink/archive.json" as FilePath)?.text, '{\n  "archived": [\n    "Archived.md"\n  ]\n}\n');
});

test("in a workspace navigation wrote, notes are edited, made and deleted as ever", () => {
  const { files } = navigationWorkspace();
  const keep = files.read("Keep.md" as FilePath)!;
  assert.equal(files.write({ path: keep.path, text: `${keep.text}More.\n`, base: keep.revision, author: ada }).status, "saved");
  const made = files.write({ path: "New.md" as FilePath, text: "# New\n", base: 0, author: ada });
  assert.equal(made.status, "saved");
  assert.equal(files.write({ path: "New.md" as FilePath, text: "", base: made.file!.revision, author: ada, delete: true }).status, "saved");
  assert.deepEqual(
    files.history("Keep.md" as FilePath).map((c) => files.versionAt(c.path, c.revision)),
    ["# Keep\n\nA note that stays.\n", "# Keep\n\nA note that stays.\nMore.\n"],
  );
});

test("a note navigation had in Trash is a deleted note here, and undoing its delete brings it back", async () => {
  const { files, sources } = navigationWorkspace();
  const [deleted] = files.history("Trashed.md" as FilePath).filter((c) => c.deleted);
  assert.deepEqual(
    (await undoChanges(files, sources, [deleted.revision], ada)).map((u) => [u.status, u.file?.text]),
    [["undone", "# Trashed\n\nIn Trash.\n"]],
  );
});

test("a note navigation deleted forever stays gone: no text of it in history, and its edit isn't taken again", () => {
  const { db, files } = navigationWorkspace();
  assert.equal(files.read("Purged.md" as FilePath), null);
  assert.equal(files.read("Expired.md" as FilePath), null);
  assert.deepEqual(db.all("SELECT revision FROM changes WHERE diff LIKE '%quokkamarker%' OR diff LIKE '%zebramarker%'"), []);
  const resent = files.write({ path: "Purged.md" as FilePath, text: "# Purged\n\nquokkamarker\n", base: 0, author: ada, edit: "edit-of-a-purged-note" });
  assert.equal(resent.status, "conflict");
  assert.equal(files.read("Purged.md" as FilePath), null);
});

test("the test levers' reset empties a workspace navigation wrote, search index and all", () => {
  const { db } = navigationWorkspace();
  emptyWorkspace(db);
  assert.deepEqual(db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"), []);
  const { files } = openWorkspace(db, { fixtures: false, google: null });
  assert.deepEqual(files.list(), []);
});

test("navigation's note of each change goes, so it works them out again if it comes back; its purge marks stay, and so does a new workspace's shape", () => {
  const { db, files } = navigationWorkspace();
  const columns = () => db.all<{ name: string }>("SELECT name FROM pragma_table_info('changes')").map((c) => c.name);
  const indexes = () => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'changes'").map((i) => i.name);
  assert.deepEqual(columns(), ["revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges"]);
  assert.deepEqual(indexes(), ["changes_by_path"]);
  assert.deepEqual(
    db.all<{ path: string }>("SELECT path FROM changes WHERE purges = 1 ORDER BY revision").map((c) => c.path),
    ["Purged.md", "Expired.md"],
  );
  const made = files.write({ path: "After.md" as FilePath, text: "# After\n", base: 0, author: ada }).file!;
  assert.deepEqual(Object.keys(db.all("SELECT * FROM changes WHERE revision = ?", made.revision)[0]), columns());
  openWorkspace(db, { fixtures: false, google: null });
  assert.deepEqual(columns(), ["revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges"], "a second start changes nothing");
  const fresh = memoryDb();
  openWorkspace(fresh, { fixtures: false, google: null });
  assert.deepEqual(
    fresh.all<{ name: string }>("SELECT name FROM pragma_table_info('changes')").map((c) => c.name),
    ["revision", "path", "author", "base", "diff", "time", "undoes", "deletes"],
  );
});
