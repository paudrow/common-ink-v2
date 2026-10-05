// The page's network, watched and switched by test levers: requests in flight (for idle), the `offline`
// lever, which fails the app's own requests as a dropped connection would and holds its live socket
// shut, and the live socket's news, whose revisions must only count up.
import { RESET_CLOSE } from "../../../worker/src/levers.ts";

const realFetch = window.fetch.bind(window);
const RealWebSocket = window.WebSocket;
const realOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")!.get!;

export const net = {
  inFlight: 0,
  offline: false,
  /** When a request last started or finished, or the socket last heard something. */
  lastActivity: performance.now(),
  /** The newest revision the live socket has announced. */
  lastRevision: 0,
  live: null as WebSocket | HeldSocket | null,
};

const touch = () => (net.lastActivity = performance.now());

/** The live socket while offline: never opens, and closes when the page is back online, so the app reconnects. */
class HeldSocket extends EventTarget {
  readyState: number = RealWebSocket.CONNECTING;
  constructor(readonly url: string) {
    super();
  }
  send() {}
  close(code = 1006) {
    if (this.readyState === RealWebSocket.CLOSED) return;
    this.readyState = RealWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, wasClean: false }));
  }
}

export interface NetHooks {
  /** The workspace was reset under this page. */
  reset(): void;
  /** Something that must always hold didn't. */
  broken(name: string, problems: string[]): void;
}

export function installNet(hooks: NetHooks): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (net.offline && url.origin === location.origin) throw new TypeError("Failed to fetch (offline, by the test lever)");
    net.inFlight++;
    touch();
    try {
      return await realFetch(input, init);
    } finally {
      net.inFlight--;
      touch();
    }
  };
  function LeveredWebSocket(url: string | URL, protocols?: string | string[]) {
    const ws = net.offline ? new HeldSocket(String(url)) : new RealWebSocket(url, protocols);
    if (String(url).endsWith("/api/live")) watchLive(ws, hooks);
    return ws;
  }
  LeveredWebSocket.prototype = RealWebSocket.prototype;
  Object.assign(LeveredWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = LeveredWebSocket as unknown as typeof WebSocket;
  Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: function (this: Navigator) { return !net.offline && realOnLine.call(this); } });
}

function watchLive(ws: WebSocket | HeldSocket, hooks: NetHooks) {
  net.live = ws;
  ws.addEventListener("message", (e) => {
    touch();
    try {
      const msg = JSON.parse(String((e as MessageEvent).data));
      if (msg?.type !== "change") return;
      if (msg.revision <= net.lastRevision) hooks.broken("history", [`The live socket announced revision ${msg.revision} of ${msg.path} after ${net.lastRevision}: revisions must only count up`]);
      net.lastRevision = Math.max(net.lastRevision, msg.revision);
    } catch {}
  });
  ws.addEventListener("close", (e) => {
    touch();
    if ((e as CloseEvent).code === RESET_CLOSE) hooks.reset();
  });
}

/** Go offline or back online, as the browser would say it. */
export function setOffline(offline: boolean): void {
  if (net.offline === offline) return;
  net.offline = offline;
  // The socket closes either way: offline, the app reconnects to a held one; online, to the real one.
  net.live?.close();
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
}
