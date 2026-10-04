// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order.
import { DurableObject } from "cloudflare:workers";
import { Notes, type Db, type Seed } from "./notes.ts";

export class Workspace extends DurableObject<object> {
  private notes: Notes;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    const { sql } = ctx.storage;
    const db: Db = {
      all: <T>(query: string, ...params: unknown[]) => sql.exec(query, ...params).toArray() as T[],
      run: (query, ...params) => void sql.exec(query, ...params),
      tx: (fn) => ctx.storage.transactionSync(fn),
    };
    this.notes = new Notes(db);
  }

  list() {
    return this.notes.list();
  }

  seed(seed: Seed) {
    this.notes.seed(seed);
  }
}
