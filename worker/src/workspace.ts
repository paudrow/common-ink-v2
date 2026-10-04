// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave.
import { DurableObject } from "cloudflare:workers";
import { Docs, type Author, type Db, type DocPath, type HistoryQuery, type Revision, type Seed, type Write } from "./docs.ts";

export class Workspace extends DurableObject<object> {
  private docs: Docs;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    const { sql } = ctx.storage;
    const db: Db = {
      all: <T>(query: string, ...params: unknown[]) => sql.exec(query, ...params).toArray() as T[],
      run: (query, ...params) => void sql.exec(query, ...params),
      tx: (fn) => ctx.storage.transactionSync(fn),
    };
    this.docs = new Docs(db);
  }

  list() {
    return this.docs.list();
  }

  read(path: DocPath) {
    return this.docs.read(path);
  }

  write(w: Write) {
    return this.docs.write(w);
  }

  recent(q: HistoryQuery) {
    return this.docs.recent(q);
  }

  undo(revisions: Revision[], author: Author) {
    return this.docs.undo(revisions, author);
  }

  seed(seed: Seed) {
    this.docs.seed(seed);
  }
}
