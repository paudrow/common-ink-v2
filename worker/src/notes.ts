// A workspace's notes, on any SQLite: the Durable Object's in production, node:sqlite in tests.

export type SqlValue = string | number | null;

export interface Db {
  all<T>(sql: string, ...params: SqlValue[]): T[];
  run(sql: string, ...params: SqlValue[]): void;
  tx<T>(fn: () => T): T;
}

export interface NoteSummary {
  path: string;
}

/** Notes a Preview starts with. `replace` rewrites a note that exists; otherwise only missing notes are added. */
export interface Seed {
  id: string;
  notes: Array<{ path: string; text: string; replace: boolean }>;
}

export class Notes {
  constructor(private db: Db) {
    db.run("CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, text TEXT NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  list(): NoteSummary[] {
    return this.db.all<NoteSummary>("SELECT path FROM notes ORDER BY path");
  }

  /** Apply a seed once: running it again with the same id changes nothing. */
  seed(seed: Seed): void {
    this.db.tx(() => {
      const [applied] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'seed'");
      if (applied?.value === seed.id) return;
      for (const note of seed.notes) {
        const conflict = note.replace ? "DO UPDATE SET text = excluded.text" : "DO NOTHING";
        this.db.run(`INSERT INTO notes(path, text) VALUES (?, ?) ON CONFLICT(path) ${conflict}`, note.path, note.text);
      }
      this.db.run("INSERT INTO meta(key, value) VALUES ('seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", seed.id);
    });
  }
}
