// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave. Open pages listen on a WebSocket and hear
// of every change as it's recorded; the sockets use the Hibernation API, so idle ones cost nothing. It also keeps data source
// connections.
import { DurableObject } from "cloudflare:workers";
import { DataSources } from "./data-sources.ts";
import { Files, type Author, type Db, type FilePath, type HistoryQuery, type Revision, type Seed, type Write } from "./files.ts";
import type { Granted } from "./google.ts";
import { addUpload, type Blobs } from "./uploads.ts";

export interface WorkspaceEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "1" in Previews and local development: data sources answer with recorded fixtures. */
  DATA_FIXTURES?: string;
  /** Uploads' bytes, by hash. */
  UPLOADS: R2Bucket;
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
    this.files = new Files(db, Date.now, (notice) => {
      const message = JSON.stringify({ type: "change", ...notice });
      for (const ws of ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // A socket that's closing: it reconnects and catches up.
        }
      }
    });
    const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null;
    this.sources = new DataSources(db, { fixtures: env.DATA_FIXTURES === "1", google });
  }

  /** A page's live connection: a WebSocket that hears of every change. */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Pages only listen; anything they send is ignored.
  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code === 1005 ? 1000 : code, "closing");
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

  combined(revisions: Revision[]) {
    return this.files.combined(revisions);
  }

  versionAt(path: FilePath, revision: Revision) {
    return this.files.versionAt(path, revision);
  }

  restore(path: FilePath, at: { revision: Revision } | { before: Revision }, author: Author) {
    return this.files.restore(path, at, author);
  }

  /** The key that signs sandbox code tokens: made once, kept in the workspace's database, never shown. */
  sandboxKey(): string {
    return this.files.secret("sandbox-key");
  }

  /** Keep an uploaded file's bytes in R2 and record it in the uploads file, as a change by `author`. */
  upload(name: string, data: ArrayBuffer, author: Author) {
    const bucket = this.env.UPLOADS;
    const blobs: Blobs = {
      has: async (key) => (await bucket.head(key)) !== null,
      put: async (key, bytes, type) => void (await bucket.put(key, bytes, { httpMetadata: { contentType: type } })),
    };
    return addUpload(this.files, blobs, name, data, author);
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
