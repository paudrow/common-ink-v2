// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave.
import { DurableObject } from "cloudflare:workers";
import { Notes, type Db, type NotePath, type Seed, type Write } from "./notes.ts";

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

  read(path: NotePath) {
    return this.notes.read(path);
  }

  write(w: Write) {
    return this.notes.write(w);
  }

  seed(seed: Seed) {
    this.notes.seed(seed);
  }
}
