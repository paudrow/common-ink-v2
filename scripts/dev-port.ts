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

/** The file a run writes into the built app for its server to serve, so the run can tell its own server from another's. */
export const RUN_FILE = "dev-run.json";

/** Whether the server at `base` is the one this run started: it serves this run's nonce. */
export async function isOurs(base: string, nonce: string): Promise<boolean> {
  const res = await fetch(`${base}/${RUN_FILE}`).catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { nonce?: unknown } | null) : null;
  return body?.nonce === nonce;
}
