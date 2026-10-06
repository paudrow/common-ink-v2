import { DatabaseSync } from "node:sqlite";
import type { Db } from "../worker/src/files.ts";

/** A Durable Object's SQLite refuses more bound parameters than this in one statement, and longer statements. */
const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100_000;

/** A statement as a Durable Object's SQLite would take it, or the error it would give. */
function checked(sql: string, params: unknown[]): string {
  if (params.length > MAX_PARAMS) throw new Error(`A Durable Object's SQLite binds at most ${MAX_PARAMS} parameters; this statement has ${params.length}`);
  if (new TextEncoder().encode(sql).length > MAX_SQL_BYTES) throw new Error(`A Durable Object's SQLite takes statements of at most ${MAX_SQL_BYTES} bytes`);
  return sql;
}

/** The Durable Object's SQLite interface on node:sqlite, in memory, with the Durable Object's limits. */
export function memoryDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  return {
    raw,
    all: <T>(sql: string, ...params: Array<string | number | null>) => raw.prepare(checked(sql, params)).all(...params).map((row) => ({ ...row })) as T[],
    run: (sql, ...params) => void raw.prepare(checked(sql, params)).run(...params),
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
