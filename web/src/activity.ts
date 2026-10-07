// What extensions have done this session (ADR 0006): every brokered network request and every check
// of a permission, newest first, in the words the prompts and the Extensions view use: "Boards read
// the note This week · 2 min ago". Their writes are in history too, by "extension:<id>". The status
// bar's dot shows while a network request is in flight.
import type { Activity, PermissionBroker } from "./broker.ts";
import { ago } from "./describe.ts";
import { askWords, nodes, type Phrase } from "./permission-words.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** What an entry says after the extension's name: "read the note This week", "wasn't allowed to connect to example.com". */
export function activityWords(e: Pick<Activity, "ask" | "outcome">): Phrase {
  switch (e.outcome) {
    case "allowed":
      return askWords(e.ask, "past");
    case "denied":
      return ["wasn't allowed to ", ...askWords(e.ask)];
    case "failed":
      return ["couldn't ", ...askWords(e.ask)];
    case "in flight":
      return ["is ", ...askWords(e.ask, "ing"), "…"];
  }
}

/** The log with the same thing done again and again in a row said once, with how many times: newest first. */
export function runs(log: readonly Activity[]): Array<{ entry: Activity; times: number }> {
  const out: Array<{ entry: Activity; times: number }> = [];
  const same = (a: Activity, b: Activity) => a.extension === b.extension && a.outcome === b.outcome && a.url === b.url && JSON.stringify(a.ask) === JSON.stringify(b.ask);
  for (const entry of log) {
    const last = out.at(-1);
    if (last && same(last.entry, entry)) last.times++;
    else out.push({ entry, times: 1 });
  }
  return out;
}

export function activityView(broker: PermissionBroker, ext: { name(id: string): string; showDetails(id: string): void }) {
  return {
    id: "extension-activity",
    title: "Extension activity",
    render(root: HTMLElement) {
      root.classList.add("activity-view");
      if (!broker.log.length) {
        root.replaceChildren(el("p", { className: "message", textContent: "No extension has reached the network or asked for anything yet this session." }));
        return;
      }
      const now = Date.now();
      root.replaceChildren(
        el(
          "ul",
          {},
          ...runs(broker.log.slice(0, 500)).map(({ entry: e, times }) =>
            el(
              "li",
              { className: `activity-${e.outcome.replace(" ", "-")}`, title: e.url ?? "" },
              el("button", { type: "button", className: "link", textContent: ext.name(e.extension), title: `${ext.name(e.extension)}: details`, onclick: () => ext.showDetails(e.extension) }),
              " ",
              ...nodes(activityWords(e)),
              el("span", { className: "when", textContent: `${times > 1 ? ` · ${times} times` : ""} · ${ago(e.time, now)}` }),
            ),
          ),
        ),
      );
    },
  };
}
