// Data sources (ADR 0007), in a view: each source's state, last sync, what it holds and what's
// waiting to reach it, with a way to connect or reconnect, and its records' history. While Google
// needs you to sign in again (its test apps' access ends after 7 days), the status bar says so, and
// a click takes you to Google and back to where you were; edits made meanwhile go out then.
import type { SourceState } from "../../../../worker/src/data-sources.ts";
import { ago } from "common-ink/describe";
import type { ExtensionModule } from "../../extension-api.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

const STATE: Record<SourceState["state"], string> = { ok: "Connected", "needs-reconnect": "Needs you to sign in again", error: "Something went wrong", "not-connected": "Not connected" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const dataSources: ExtensionModule = {
  activate(ctx) {
    ctx.views.register("dataSources", {
      async render(root) {
        const status = await ctx.data.status();
        root.replaceChildren(
          ...status.sources.map((s) =>
            el(
              "section",
              { className: `data-source state-${s.state}` },
              el("h3", { textContent: s.title }),
              el("p", { className: "state", textContent: s.source === "sample" ? "Sample data: this workspace has no Google account" : STATE[s.state] }),
              el("p", { className: "counts", textContent: `${plural(s.calendars, "calendar")} · ${plural(s.events, "event")}` }),
              el("p", { className: "when", textContent: s.lastSync ? `Synced ${ago(s.lastSync)}` : s.source === "sample" ? "Kept here; nothing to sync" : "Not synced yet" }),
              s.pending ? el("p", { className: "pending", textContent: `${plural(s.pending, "edit")} waiting to reach ${s.title}` }) : "",
              s.error ? el("p", { className: "message", textContent: s.error }) : "",
              s.conflict ? el("p", { className: "conflict", textContent: s.conflict }) : "",
              s.source === "google" && s.state !== "ok" && status.googleAvailable
                ? el("button", { className: "connect", textContent: s.state === "not-connected" ? "Connect Google Calendar" : "Reconnect Google Calendar", onclick: () => ctx.data.connect() })
                : "",
              el("button", { textContent: "Show changes", title: "Every change in history, records included; filter by the sync's name", onclick: () => ctx.commands.run("history.all") }),
            ),
          ),
        );
      },
    });
    /** The status bar's word when a source needs you, or nothing. */
    const watch = async () => {
      const status = await ctx.data.status().catch(() => null);
      const google = status?.sources.find((s) => s.source === "google" && s.state === "needs-reconnect");
      ctx.statusBar.set("dataSources.reconnect", google ? "Reconnect Google Calendar" : "", google ? `${google.error ?? "Google ended the connection"}${google.pending ? ` · ${plural(google.pending, "edit")} waiting` : ""}` : undefined);
    };
    void watch();
    // A push that fails changes no record, so look again now and then, and whenever you come back.
    setInterval(() => void watch(), 5 * 60_000);
    window.addEventListener("focus", () => void watch());
    ctx.data.calendar.onChange(() => {
      ctx.views.refresh("dataSources");
      void watch();
    });
    ctx.commands.register("dataSources.show", () => ctx.views.toggle("dataSources"));
    ctx.commands.register("dataSources.reconnect", () => ctx.data.connect());
  },
};

export default dataSources;
