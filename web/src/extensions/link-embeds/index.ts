// Link embeds, a built-in extension: a link alone on its line drawn as what it links to. Videos, posts
// and tracks are their sites' own embed pages in a frame (each site is one the page's policy lets it
// frame only while this extension is on: see contributes.urlEmbeds' frameHosts); anything else is a
// card made by the Worker from the page's title, description and picture.
import { EditorView } from "@codemirror/view";
import type { ExtensionContext } from "../../extension-api.ts";

type Card = Awaited<ReturnType<ExtensionContext["net"]["card"]>>;

const theme = EditorView.theme({
  ".cm-url-embed iframe": { display: "block", width: "100%", border: "0", borderRadius: "10px", background: "transparent" },
  ".cm-url-embed .video": { aspectRatio: "16 / 9", height: "auto" },
  ".cm-url-embed .post": { maxWidth: "34rem", minHeight: "8rem" },
  ".link-card": {
    display: "flex",
    gap: "0.75rem",
    alignItems: "stretch",
    border: "1px solid var(--line)",
    borderRadius: "8px",
    overflow: "hidden",
    color: "var(--ink)",
    textDecoration: "none",
    fontFamily: "var(--prose)",
    lineHeight: "1.35",
  },
  ".link-card:hover": { borderColor: "var(--accent)" },
  ".link-card img": { width: "8.5rem", objectFit: "cover", flex: "none" },
  ".link-card .text": { padding: "0.55rem 0.75rem", minWidth: "0", display: "flex", flexDirection: "column", gap: "0.15rem" },
  ".link-card .site": { fontSize: "0.75em", color: "var(--muted)" },
  ".link-card .title": { fontWeight: "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ".link-card .description": { fontSize: "0.85em", color: "var(--muted)", display: "-webkit-box", WebkitLineClamp: "2", WebkitBoxOrient: "vertical", overflow: "hidden" },
  ".link-card.loading": { padding: "0.55rem 0.75rem", color: "var(--muted)" },
});

/** A frame for another site's embed page: scripts and its own origin, nothing that reaches the app. */
function frame(src: string, title: string, className: string, height?: number): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.src = src;
  f.title = title;
  f.className = className;
  f.loading = "lazy";
  f.referrerPolicy = "strict-origin-when-cross-origin";
  f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox");
  f.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
  f.allowFullscreen = true;
  if (height) f.style.height = `${height}px`;
  return f;
}

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.extend(theme);

    // Posts say how tall they are by message; each goes to its own frame.
    const sizes = new Map<Window, (height: number) => void>();
    window.addEventListener("message", (e) => {
      const resize = e.source && sizes.get(e.source as Window);
      if (!resize) return;
      let data: unknown = e.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const d = data as { height?: number; "twttr.embed"?: { method?: string; params?: Array<{ height?: number }> } };
      const height = d["twttr.embed"]?.method === "twttr.private.resize" ? d["twttr.embed"].params?.[0]?.height : d.height;
      if (typeof height === "number" && height > 0) resize(Math.min(height, 2000));
    });
    const sized = (f: HTMLIFrameElement) => {
      f.addEventListener("load", () => f.contentWindow && sizes.set(f.contentWindow, (h) => (f.style.height = `${h}px`)), { once: true });
      return f;
    };

    ctx.urlEmbeds.register("youtube", {
      render: (el, { match }) => el.replaceChildren(frame(`https://www.youtube-nocookie.com/embed/${match[1]}`, "YouTube video", "video")),
    });
    ctx.urlEmbeds.register("x", {
      render: (el, { match }) => el.replaceChildren(sized(frame(`https://platform.twitter.com/embed/Tweet.html?id=${match[1]}&dnt=true&theme=${dark() ? "dark" : "light"}`, "Post on X", "post", 320))),
    });
    let posts = 0;
    ctx.urlEmbeds.register("bluesky", {
      render(el, { url, match }) {
        el.textContent = url;
        void (async () => {
          // Embeds name a post by its author's DID; a link names them by handle, which Bluesky looks up.
          let did = decodeURIComponent(match[1]);
          if (!did.startsWith("did:")) {
            const res = await ctx.net.fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`);
            did = (JSON.parse(res.body) as { did?: string }).did ?? "";
          }
          if (!did.startsWith("did:")) return;
          el.replaceChildren(sized(frame(`https://embed.bsky.app/embed/${did}/app.bsky.feed.post/${match[2]}?id=${++posts}&colorMode=${dark() ? "dark" : "light"}`, "Bluesky post", "post", 260)));
        })().catch(() => {});
      },
    });
    ctx.urlEmbeds.register("spotify", {
      render: (el, { match }) => el.replaceChildren(frame(`https://open.spotify.com/embed/${match[1]}/${match[2]}`, "Spotify", "", match[1] === "track" || match[1] === "episode" ? 152 : 352)),
    });

    // Cards are kept for the session, so a note drawn again doesn't fetch again.
    const cards = new Map<string, Promise<Card>>();
    ctx.urlEmbeds.register("link-card", {
      render(el, { url }) {
        const waiting = document.createElement("a");
        waiting.className = "link-card loading";
        waiting.href = url;
        waiting.textContent = url;
        el.replaceChildren(waiting);
        if (!cards.has(url)) cards.set(url, ctx.net.card(url));
        void cards.get(url)!.then(
          (card) => el.replaceChildren(cardEl(card)),
          () => {
            // No card (offline, or the page wouldn't say): the link, as a link.
            cards.delete(url);
            waiting.classList.remove("loading");
            waiting.className = "cm-md-link";
            waiting.dataset.href = url;
          },
        );
      },
    });
  },
};

function cardEl(card: Card): HTMLElement {
  const a = document.createElement("a");
  a.className = "link-card";
  a.href = card.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = card.url;
  if (card.image) {
    const img = document.createElement("img");
    img.src = card.image;
    img.alt = "";
    a.append(img);
  }
  const text = document.createElement("span");
  text.className = "text";
  for (const [cls, value] of [
    ["site", card.site],
    ["title", card.title],
    ["description", card.description],
  ] as const) {
    if (!value) continue;
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = value;
    text.append(span);
  }
  a.append(text);
  return a;
}
