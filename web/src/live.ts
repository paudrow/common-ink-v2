// The page's live connection to its workspace: a WebSocket that hears of every change as it's recorded
// (ADR 0001). It reconnects on its own, waiting longer each time, and says when it's back so the page
// can catch up on what it missed.
import type { ChangeNotice } from "../../worker/src/files.ts";

export function connectLive(on: { change(notice: ChangeNotice): void; open(): void }): void {
  let wait = 1000;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
    ws.addEventListener("open", () => {
      wait = 1000;
      on.open();
    });
    ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg?.type === "change") on.change(msg as ChangeNotice);
      } catch {
        // Not ours.
      }
    });
    ws.addEventListener("close", () => {
      window.setTimeout(connect, wait);
      wait = Math.min(wait * 2, 30_000);
    });
  };
  connect();
}
