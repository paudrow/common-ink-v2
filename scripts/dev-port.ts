// What scripts/dev.ts checks before it trusts a server on its port: other worktrees run dev servers on
// this machine too, and resetting one of theirs would wipe their workspace.
import { connect, createServer, type AddressInfo } from "node:net";

/** Whether something answers on a port on this machine. */
export function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "localhost" });
    socket.once("connect", () => resolve(!!socket.destroy()));
    socket.once("error", () => resolve(false));
  });
}

/** A port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Whether the server at `base` is the one this run started: its levers answer this run's nonce, which
 * the run gave its Worker (DEV_RUN), so another server, even one from the same worktree, can't.
 */
export async function isOurs(base: string, nonce: string): Promise<boolean> {
  const res = await fetch(`${base}/api/levers`).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { run?: unknown } | null) : null;
  return body?.run === nonce;
}
