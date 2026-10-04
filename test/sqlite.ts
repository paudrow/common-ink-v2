import { DatabaseSync } from "node:sqlite";
import type { Db } from "../worker/src/notes.ts";

/** The Durable Object's SQLite interface on node:sqlite, in memory. */
export function memoryDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  return {
    raw,
    all: <T>(sql: string, ...params: Array<string | number | null>) => raw.prepare(sql).all(...params).map((row) => ({ ...row })) as T[],
    run: (sql, ...params) => void raw.prepare(sql).run(...params),
    tx: (fn) => {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
