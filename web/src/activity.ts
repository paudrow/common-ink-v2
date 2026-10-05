// What extensions have done this session (ADR 0006): every brokered network request and every check
// of a permission, by extension, with counts and the latest entries. Their writes are in history too,
// by "extension:<id>". The status bar's dot shows while a network request is in flight.
import type { Activity, PermissionBroker } from "./broker.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** How many of each kind an extension's log has, in words: "3 network, 1 files:read". */
export function counts(entries: readonly Activity[]): string {
  const by = new Map<string, number>();
  for (const e of entries) by.set(e.kind, (by.get(e.kind) ?? 0) + 1);
  return [...by].map(([kind, n]) => `${n} ${kind}`).join(", ");
}

export function activityView(broker: PermissionBroker, name: (id: string) => string) {
  return {
    id: "extension-activity",
    title: "Extension activity",
    render(root: HTMLElement) {
      root.classList.add("activity-view");
      const byExtension = new Map<string, Activity[]>();
      for (const e of broker.log) byExtension.set(e.extension, [...(byExtension.get(e.extension) ?? []), e]);
      if (!byExtension.size) {
        root.replaceChildren(el("p", { className: "message", textContent: "No extension has reached the network or asked for anything yet this session." }));
        return;
      }
      root.replaceChildren(
        ...[...byExtension].map(([id, entries]) =>
          el(
            "section",
            { className: "activity" },
            el("h3", { textContent: name(id) }, el("span", { className: "muted", textContent: ` ${counts(entries)}` })),
            el(
              "ul",
              {},
              ...entries.slice(0, 20).map((e) =>
                el("li", { className: `activity-${e.outcome.replace(" ", "-")}` }, el("span", { className: "when", textContent: time(e.time) }), el("span", { textContent: `${e.kind} ${e.detail}` }), el("span", { className: "outcome", textContent: e.outcome })),
              ),
            ),
          ),
        ),
      );
    },
  };
}
