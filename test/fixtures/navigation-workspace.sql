CREATE TABLE records(path TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, collection TEXT NOT NULL,
        id TEXT NOT NULL, starts INTEGER, ends INTEGER, repeats INTEGER NOT NULL DEFAULT 0, series TEXT);
CREATE INDEX records_by_time ON records(source, kind, starts);
CREATE INDEX records_by_series ON records(source, collection, series);
CREATE VIRTUAL TABLE search USING fts5(words, content = '', contentless_delete = 1, tokenize = "unicode61 remove_diacritics 0 categories 'L* N* Co M*'");
CREATE TABLE search_docs(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL);
CREATE TABLE search_mark(revision INTEGER NOT NULL);
CREATE TABLE search_merge(since INTEGER NOT NULL);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files(path TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE changes(revision INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
        author TEXT NOT NULL, base INTEGER NOT NULL, diff TEXT NOT NULL, time INTEGER NOT NULL, undoes INTEGER, deletes INTEGER NOT NULL DEFAULT 0, purges INTEGER NOT NULL DEFAULT 0, purge_by_hand INTEGER NOT NULL DEFAULT 0, note INTEGER);
CREATE INDEX changes_by_path ON changes(path, revision);
CREATE TABLE connections(email TEXT NOT NULL, provider TEXT NOT NULL, refresh_token TEXT NOT NULL, scopes TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY(email, provider));
CREATE TABLE edits(path TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, hash TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY(path, id));
CREATE INDEX edits_by_time ON edits(time);
CREATE INDEX changes_by_note ON changes(note, revision);
CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, author TEXT NOT NULL, time INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, base TEXT, unreadable INTEGER);
CREATE TABLE etags(path TEXT PRIMARY KEY, etag TEXT NOT NULL);
CREATE TABLE source_state(source TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO "search_docs" ("id", "path", "title") VALUES (1, 'Keep.md', 'Keep');
INSERT INTO "search_docs" ("id", "path", "title") VALUES (2, 'Archived.md', 'Archived');
INSERT INTO "search_docs" ("id", "path", "title") VALUES (3, 'Pinned.md', 'Pinned');
INSERT INTO "search_mark" ("revision") VALUES (17);
INSERT INTO "search_merge" ("since") VALUES (11);
INSERT INTO "meta" ("key", "value") VALUES ('retention-next', '1791564480695');
INSERT INTO "files" ("path", "text", "revision") VALUES ('Keep.md', '# Keep

A note that stays.
', 1);
INSERT INTO "files" ("path", "text", "revision") VALUES ('Archived.md', '# Archived

Out of the Feed.
', 2);
INSERT INTO "files" ("path", "text", "revision") VALUES ('Pinned.md', '# Pinned

First in the Feed.
', 3);
INSERT INTO "files" ("path", "text", "revision") VALUES ('.common-ink/archive.json', '{
  "archived": [
    "Archived.md"
  ]
}
', 7);
INSERT INTO "files" ("path", "text", "revision") VALUES ('.common-ink/pins.json', '{
  "pinned": [
    "Pinned.md"
  ]
}
', 8);
INSERT INTO "files" ("path", "text", "revision") VALUES ('.common-ink/places.json', '{
  "bar": ["feed", "daily.today", "calendar.calendar"],
  "saved": { "Agents this week": "from:agent edited:<7d" }
}
', 14);
INSERT INTO "files" ("path", "text", "revision") VALUES ('.common-ink/users/ada@example.com/devices/laptop-1/device.json', '{
  "name": "Chrome on a Mac",
  "seen": { "width": "large", "pointer": "fine", "touch": false, "keyboard": true },
  "keyboard": "auto",
  "extensions": { "vim": "on" }
}
', 15);
INSERT INTO "files" ("path", "text", "revision") VALUES ('.common-ink/users/ada@example.com/devices/laptop-1/layout.json', '{
  "root": { "kind": "group", "id": "g1", "tabs": [{ "file": "Keep.md" }], "active": 0 },
  "focus": "g1"
}
', 16);
INSERT INTO "files" ("path", "text", "revision") VALUES ('.common-ink/settings.json', '{
  "trash.retentionDays": 14
}
', 17);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (1, 'Keep.md', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":1,"chunk":["# Keep"]}},{"buffer1":{"offset":1,"length":0,"chunk":[]},"buffer2":{"offset":2,"length":2,"chunk":["A note that stays.",""]}}]', 1791478080691, NULL, 0, 0, 0, 1);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (2, 'Archived.md', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":1,"chunk":["# Archived"]}},{"buffer1":{"offset":1,"length":0,"chunk":[]},"buffer2":{"offset":2,"length":2,"chunk":["Out of the Feed.",""]}}]', 1791478080692, NULL, 0, 0, 0, 2);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (3, 'Pinned.md', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":1,"chunk":["# Pinned"]}},{"buffer1":{"offset":1,"length":0,"chunk":[]},"buffer2":{"offset":2,"length":2,"chunk":["First in the Feed.",""]}}]', 1791478080693, NULL, 0, 0, 0, 3);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (4, 'Trashed.md', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":1,"chunk":["# Trashed"]}},{"buffer1":{"offset":1,"length":0,"chunk":[]},"buffer2":{"offset":2,"length":2,"chunk":["In Trash.",""]}}]', 1791478080693, NULL, 0, 0, 0, 4);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (7, '.common-ink/archive.json', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":5,"chunk":["{","  \"archived\": [","    \"Archived.md\"","  ]","}"]}}]', 1791478080693, NULL, 0, 0, 0, 7);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (8, '.common-ink/pins.json', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":5,"chunk":["{","  \"pinned\": [","    \"Pinned.md\"","  ]","}"]}}]', 1791478080694, NULL, 0, 0, 0, 8);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (9, 'Trashed.md', '{"kind":"user","email":"ada@example.com"}', 4, '[{"buffer1":{"offset":0,"length":1,"chunk":["# Trashed"]},"buffer2":{"offset":0,"length":0,"chunk":[]}},{"buffer1":{"offset":2,"length":2,"chunk":["In Trash.",""]},"buffer2":{"offset":1,"length":0,"chunk":[]}}]', 1791478080694, NULL, 1, 0, 0, 4);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (11, 'Purged.md', '{"kind":"user","email":"ada@example.com"}', 0, '[]', 1791478080694, NULL, 0, 1, 0, NULL);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (13, 'Expired.md', '{"kind":"retention"}', 0, '[]', 1791478080695, NULL, 0, 1, 0, NULL);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (14, '.common-ink/places.json', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":4,"chunk":["{","  \"bar\": [\"feed\", \"daily.today\", \"calendar.calendar\"],","  \"saved\": { \"Agents this week\": \"from:agent edited:<7d\" }","}"]}}]', 1791478080695, NULL, 0, 0, 0, 14);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (15, '.common-ink/users/ada@example.com/devices/laptop-1/device.json', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":6,"chunk":["{","  \"name\": \"Chrome on a Mac\",","  \"seen\": { \"width\": \"large\", \"pointer\": \"fine\", \"touch\": false, \"keyboard\": true },","  \"keyboard\": \"auto\",","  \"extensions\": { \"vim\": \"on\" }","}"]}}]', 1791478080695, NULL, 0, 0, 0, 15);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (16, '.common-ink/users/ada@example.com/devices/laptop-1/layout.json', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":4,"chunk":["{","  \"root\": { \"kind\": \"group\", \"id\": \"g1\", \"tabs\": [{ \"file\": \"Keep.md\" }], \"active\": 0 },","  \"focus\": \"g1\"","}"]}}]', 1791478080695, NULL, 0, 0, 0, 16);
INSERT INTO "changes" ("revision", "path", "author", "base", "diff", "time", "undoes", "deletes", "purges", "purge_by_hand", "note") VALUES (17, '.common-ink/settings.json', '{"kind":"user","email":"ada@example.com"}', 0, '[{"buffer1":{"offset":0,"length":0,"chunk":[]},"buffer2":{"offset":0,"length":3,"chunk":["{","  \"trash.retentionDays\": 14","}"]}}]', 1791478080695, NULL, 0, 0, 0, 17);
INSERT INTO "sqlite_sequence" ("name", "seq") VALUES ('changes', 17);
INSERT INTO "edits" ("path", "id", "revision", "hash", "time") VALUES ('Purged.md', 'edit-of-a-purged-note', 5, 'purged', 1791478080693);
INSERT INTO sqlite_sequence (name, seq) VALUES ('changes', 17);
