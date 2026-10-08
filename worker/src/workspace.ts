// One Durable Object per workspace. It owns the workspace's SQLite database and runs every read and
// write in order, so two writes to a note can't interleave. Open pages listen on a WebSocket and hear
// of every change as it's recorded; the sockets use the Hibernation API, so idle ones cost nothing. It also keeps data source
// connections.
import { DurableObject } from "cloudflare:workers";
import { DataSources, emptyWorkspace, openWorkspace, restoreFile, undoChanges, type EventEdit } from "./data-sources.ts";
import type { Author, ChangeNotice, Db, FilePath, Files, HistoryQuery, Revision, Seed, Write } from "./files.ts";
import { DATA_SCOPES, type Granted } from "./google.ts";
import { SAMPLE_ZONE, sampleGoogle, type FakeGoogle } from "./fake-google.ts";
import { wallTimeAt } from "./calendar.ts";
import { addUpload, type Blobs } from "./uploads.ts";
import { completeTaskIn, type TaskArgs } from "./complete-task.ts";
import { RESET_CLOSE } from "./levers.ts";

export interface WorkspaceEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "1" in Previews and local development: the Sample calendar and recorded contacts stand in for Google. */
  DATA_FIXTURES?: string;
  /** Uploads' bytes, by hash. */
  UPLOADS: R2Bucket;
  /** "1" in a browser test's Worker, with LEVERS: Google Calendar is a fake Google (fake-google.ts), connected. Never in production. */
  FAKE_GOOGLE?: string;
  LEVERS?: string;
  /** Seals Google's refresh tokens at rest, as well as signing sessions. */
  SESSION_SECRET?: string;
}

/** How often a connected Google Calendar syncs on its own. */
const SYNC_EVERY = 10 * 60_000;

/** The scenario a workspace was last seeded from, and whether a reset chose it (test levers, docs/TESTING.md). */
export interface SeededScenario {
  name: string;
  now?: string;
  /** Reset to it on purpose: a deploy's seed doesn't fill the workspace in again until it's reset once more. */
  pinned: boolean;
}

export class Workspace extends DurableObject<WorkspaceEnv> {
  private db: Db;
  /** The fake Google a browser test's Worker uses (FAKE_GOOGLE), kept while the object lives. */
  private fake: FakeGoogle | null = null;
  private files: Files;
  private sources: DataSources;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    const { sql } = ctx.storage;
    this.db = {
      all: <T>(query: string, ...params: unknown[]) => sql.exec(query, ...params).toArray() as T[],
      run: (query, ...params) => void sql.exec(query, ...params),
      tx: (fn) => ctx.storage.transactionSync(fn),
    };
    [this.files, this.sources] = this.open();
  }

  /** The workspace's files and data sources on its database, shaping the database first if need be. */
  private open(): [Files, DataSources] {
    const announce = (notice: ChangeNotice) => {
      const message = JSON.stringify({ type: "change", ...notice });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // A socket that's closing: it reconnects and catches up.
        }
      }
    };
    if (this.env.FAKE_GOOGLE === "1" && this.env.LEVERS === "1") {
      // Sealed like production's, so the browser tests go through sealing, revoking and sealTokens too.
      const { files, sources } = openWorkspace(this.db, { fixtures: false, google: { clientId: "fake", clientSecret: "fake" }, tokenKey: "fake" }, announce, (input, init) => this.sampleFake().fetch(input, init));
      if (!sources.syncs) void this.ctx.blockConcurrencyWhile(() => sources.connect({ email: "tester@localhost", refreshToken: "fake", scopes: DATA_SCOPES }));
      return [files, sources];
    }
    const google = this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET ? { clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET } : null;
    const { files, sources } = openWorkspace(this.db, { fixtures: this.env.DATA_FIXTURES === "1", google, tokenKey: this.env.SESSION_SECRET }, announce);
    return [files, sources];
  }

  /**
   * The fake Google, made the first time it's used, so after a seed has said the workspace's scenario:
   * its week is around the day that scenario starts on, or today where its calendars are.
   */
  private sampleFake(): FakeGoogle {
    return (this.fake ??= sampleGoogle(this.scenario()?.now?.slice(0, 10) ?? wallTimeAt(Date.now(), SAMPLE_ZONE).slice(0, 10)));
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

  // A page that went without a close frame comes as 1006, which can't be sent back, so the reply is always 1000.
  webSocketClose(ws: WebSocket) {
    ws.close(1000, "closing");
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

  /** Undo changes; a data source's records are put back through the source (data-sources.ts). */
  undo(revisions: Revision[], author: Author) {
    return undoChanges(this.files, this.sources, revisions, author);
  }

  combined(revisions: Revision[]) {
    return this.files.combined(revisions);
  }

  versionAt(path: FilePath, revision: Revision) {
    return this.files.versionAt(path, revision);
  }

  editApplied(path: FilePath, id: string) {
    return this.files.editApplied(path, id);
  }

  /** Put a file back as it was; a record goes back through its data source. */
  restore(path: FilePath, at: { revision: Revision } | { before: Revision }, author: Author) {
    return restoreFile(this.files, this.sources, path, at, author);
  }

  /** The key that signs sandbox code tokens: made once, kept in the workspace's database, never shown. */
  sandboxKey(): string {
    return this.files.secret("sandbox-key");
  }

  /** Tick a task and log its completion, in one step (complete-task.ts). */
  completeTask(args: TaskArgs, author: Author) {
    return completeTaskIn(this.files, args, author);
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

  /** Fill the workspace from a deploy's seed, unless a reset chose its scenario. */
  seed(seed: Seed) {
    if (this.scenario()?.pinned) return;
    this.files.seed(seed);
    this.keepScenario(seed, false);
  }

  scenario(): SeededScenario | null {
    const [row] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'scenario'");
    return row ? (JSON.parse(row.value) as SeededScenario) : null;
  }

  private keepScenario(seed: Seed, pinned: boolean) {
    const kept: SeededScenario = { name: seed.scenario?.name ?? "", ...(seed.scenario?.now ? { now: seed.scenario.now } : {}), pinned };
    this.db.run("INSERT INTO meta(key, value) VALUES ('scenario', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(kept));
  }

  /**
   * Test levers only, which the Worker checks: empty the workspace and fill it from `seed`. Revisions
   * go on counting from where they were, so no page sees one go backwards, and open pages are told to
   * load again. Running it twice ends the same way.
   */
  reset(seed: Seed, pinned: boolean) {
    const last = this.files.lastRevision();
    emptyWorkspace(this.db);
    [this.files, this.sources] = this.open();
    if (last) {
      this.db.run("DELETE FROM sqlite_sequence WHERE name = 'changes'");
      this.db.run("INSERT INTO sqlite_sequence(name, seq) VALUES ('changes', ?)", last);
    }
    this.files.seed(seed);
    this.keepScenario(seed, pinned);
    this.fake = null;
    for (const ws of this.ctx.getWebSockets()) ws.close(RESET_CLOSE, "The workspace was reset");
  }

  /**
   * Test levers, with the fake Google: end Google's grant (as its test apps' end after 7 days), or
   * give it again, as reconnecting does.
   */
  async fakeGoogle(change: { revoked: boolean }) {
    if (this.env.FAKE_GOOGLE !== "1" || this.env.LEVERS !== "1") return null;
    this.sampleFake().revoked = change.revoked;
    if (!change.revoked) await this.connectGoogle({ email: "tester@localhost", refreshToken: "fake-2", scopes: DATA_SCOPES });
    return { revoked: this.sampleFake().revoked };
  }

  /** Keep Google's grant, then send what waited for it and sync, soon, without holding up sign-in. */
  async connectGoogle(granted: Granted) {
    const ok = await this.sources.connect(granted);
    if (ok) await this.ctx.storage.setAlarm(Date.now() + 1000);
    return ok;
  }

  /** Sync on a timer while Google is connected: every 10 minutes, and soon after connecting. */
  async alarm() {
    await this.sources.sealTokens();
    await this.sources.sync();
    await this.scheduleSync();
  }

  private async scheduleSync() {
    if (!this.sources.syncs) return;
    const next = Date.now() + SYNC_EVERY;
    const set = await this.ctx.storage.getAlarm();
    if (!set || set > next) await this.ctx.storage.setAlarm(next);
  }

  /** Sync now if it hasn't in the last half minute (a calendar view opening asks); always, if `force`. */
  async syncSources(force = false) {
    if (force || this.sources.due(30_000)) await this.sources.sync();
    await this.scheduleSync();
    return this.sources.status("").sources[0];
  }

  disconnectGoogle(email: string) {
    return this.sources.disconnect(email);
  }

  sourceStatus(email: string) {
    return this.sources.status(email);
  }

  calendars() {
    return this.sources.calendars();
  }

  events(from: number, to: number, zone: string, calendars?: string[]) {
    return this.sources.events(from, to, zone, calendars);
  }

  event(address: string, zone?: string) {
    return this.sources.event(address, zone);
  }

  editEvent(edit: EventEdit, author: Author, zone?: string) {
    return this.sources.edit(edit, author, zone);
  }

  outbox() {
    return this.sources.outbox(this.sources.calendarSource);
  }

  contacts(email: string, query: string) {
    return this.sources.contacts(email, query);
  }
}
