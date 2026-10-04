// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave.
import { DurableObject } from "cloudflare:workers";
import { Files, type Author, type Db, type FilePath, type HistoryQuery, type Revision, type Seed, type Write } from "./files.ts";

export class Workspace extends DurableObject<object> {
  private files: Files;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    const { sql } = ctx.storage;
    const db: Db = {
      all: <T>(query: string, ...params: unknown[]) => sql.exec(query, ...params).toArray() as T[],
      run: (query, ...params) => void sql.exec(query, ...params),
      tx: (fn) => ctx.storage.transactionSync(fn),
    };
    this.files = new Files(db);
  }

  list() {
    return this.files.list();
  }

  read(path: FilePath) {
    return this.files.read(path);
  }

  write(w: Write) {
    return this.files.write(w);
  }

  recent(q: HistoryQuery) {
    return this.files.recent(q);
  }

  undo(revisions: Revision[], author: Author) {
    return this.files.undo(revisions, author);
  }

  seed(seed: Seed) {
    this.files.seed(seed);
  }
}
