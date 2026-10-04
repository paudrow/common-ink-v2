// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave. It also keeps data source connections.
import { DurableObject } from "cloudflare:workers";
import { DataSources } from "./data-sources.ts";
import { Files, type Author, type Db, type FilePath, type HistoryQuery, type Revision, type Seed, type Write } from "./files.ts";
import type { Granted } from "./google.ts";

export interface WorkspaceEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "1" in Previews and local development: data sources answer with recorded fixtures. */
  DATA_FIXTURES?: string;
}

export class Workspace extends DurableObject<WorkspaceEnv> {
  private files: Files;
  private sources: DataSources;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    const { sql } = ctx.storage;
    const db: Db = {
      all: <T>(query: string, ...params: unknown[]) => sql.exec(query, ...params).toArray() as T[],
      run: (query, ...params) => void sql.exec(query, ...params),
      tx: (fn) => ctx.storage.transactionSync(fn),
    };
    this.files = new Files(db);
    const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null;
    this.sources = new DataSources(db, { fixtures: env.DATA_FIXTURES === "1", google });
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

  connectGoogle(granted: Granted) {
    return this.sources.connect(granted);
  }

  disconnectGoogle(email: string) {
    this.sources.disconnect(email);
  }

  sourceStatus(email: string) {
    return this.sources.status(email);
  }

  events(email: string, from: string, to: string) {
    return this.sources.events(email, from, to);
  }

  contacts(email: string, query: string) {
    return this.sources.contacts(email, query);
  }
}
