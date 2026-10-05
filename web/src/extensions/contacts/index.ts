// Contacts, a built-in extension on the data source API: a searchable view of your contacts.
import type { ExtensionContext, ExtensionModule } from "../../extension-api.ts";

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): T {
  const node = Object.assign(document.createElement(tag), props) as T;
  node.append(...children);
  return node;
}

/** What to show when a source can't answer: the reason, and a way to connect when that's what's missing. */
async function trouble(ctx: ExtensionContext, root: HTMLElement, err: unknown) {
  const status = await ctx.sources.status().catch(() => null);
  const message = el("p", { className: "message", textContent: (err as Error).message });
  const connect =
    status?.using === "none" && status.googleAvailable ? el("button", { className: "connect", textContent: "Connect Google calendar and contacts", onclick: () => ctx.sources.connect() }) : "";
  root.replaceChildren(message, connect);
}

const contacts: ExtensionModule = {
  activate(ctx) {
    let query = "";
    ctx.views.register("contacts", {
      async render(root) {
        const search = el<HTMLInputElement>("input", { type: "search", placeholder: "Search contacts", value: query, className: "search" });
        const list = el("ul", {});
        const fill = async () => {
          try {
            const contacts = await ctx.sources.contacts(query);
            list.replaceChildren(
              ...contacts.map((c) =>
                el(
                  "li",
                  { className: "contact" },
                  el("span", { className: "what", textContent: c.name }),
                  c.organization ? el("span", { className: "where", textContent: c.organization }) : "",
                  ...c.emails.map((e) => el("a", { href: `mailto:${e}`, textContent: e })),
                  ...c.phones.map((p) => el("a", { href: `tel:${p.replace(/[^\d+]/g, "")}`, textContent: p })),
                ),
              ),
              ...(contacts.length ? [] : [el("li", { className: "empty", textContent: query ? "No one matches." : "No contacts." })]),
            );
          } catch (err) {
            await trouble(ctx, root, err);
          }
        };
        search.addEventListener("input", () => {
          query = search.value;
          void fill();
        });
        root.replaceChildren(search, list);
        await fill();
      },
    });
    ctx.commands.register("contacts.show", () => ctx.views.toggle("contacts"));
  },
};

export default contacts;
