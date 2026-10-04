// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave. Open pages listen on a WebSocket and hear
// of every change as it's recorded; the sockets use the Hibernation API, so idle ones cost nothing.
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

  seed(seed: Seed) {
    this.files.seed(seed);
  }
}
