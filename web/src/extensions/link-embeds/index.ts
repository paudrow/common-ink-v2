// Link embeds, a built-in extension: a link alone on its line drawn as what it links to. Videos, posts
// and tracks are their sites' own embed pages in a frame (each site is one the page's policy lets it
// frame only while this extension is on: see contributes.urlEmbeds' frameHosts); anything else is a
// card made by the Worker from the page's title, description and picture.
import { EditorView } from "@codemirror/view";
import type { ExtensionContext } from "../../extension-api.ts";

type Card = Awaited<ReturnType<ExtensionContext["net"]["card"]>>;

const theme = EditorView.theme({
  // A site's card brings its own edge and corners, so its box adds none: it only cuts the frame to them.
  ".cm-url-embed .site-frame": { overflow: "hidden", background: "transparent" },
  ".cm-url-embed .site-frame.post": { maxWidth: "34rem" },
  ".cm-url-embed iframe": { display: "block", width: "100%", border: "0", background: "transparent", colorScheme: "normal" },
  ".cm-url-embed .video iframe": { aspectRatio: "16 / 9", height: "auto" },
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

/**
 * How a site's embed page sits in a note: as a video (16:9) or a post (narrower, as tall as it says),
 * how tall it starts, and the corner radius of the site's own card, measured on the site (a video
 * has none; 12px is YouTube's own player's).
 */
interface Look {
  kind: "video" | "post" | "player";
  radius: number;
  height?: number;
}

/**
 * Another site's embed page: a frame with scripts and its own origin, nothing that reaches the app,
 * in a box cut to the site's corners. The frame's color-scheme is "normal", as each site's page says:
 * when they differ (the app in dark mode), Chrome paints an opaque canvas behind the frame, which
 * shows as white wedges outside the card's rounded corners.
 */
function siteFrame(src: string, title: string, look: Look): { box: HTMLElement; frame: HTMLIFrameElement } {
  const f = document.createElement("iframe");
  f.src = src;
  f.title = title;
  f.referrerPolicy = "strict-origin-when-cross-origin";
  f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox");
  f.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
  f.allowFullscreen = true;
  if (look.height) f.style.height = `${look.height}px`;
  const box = document.createElement("div");
  box.className = `site-frame ${look.kind}`;
  box.style.borderRadius = `${look.radius}px`;
  box.append(f);
  return { box, frame: f };
}

const darkMode = matchMedia("(prefers-color-scheme: dark)");

export default {
  activate(ctx: ExtensionContext) {
    ctx.editor.extend(theme);

    // Posts and players asked for in the app's theme, with how to ask in each: when it changes, they
    // load again in the new one. Frames that have gone from the page are let go then, and as others come.
    const themed = new Map<HTMLIFrameElement, { page: (dark: boolean) => string; shown: boolean }>();
    const letGo = (all: boolean) => {
      for (const [f, t] of themed) if (!f.isConnected && (all || t.shown)) themed.delete(f);
    };
    darkMode.addEventListener("change", () => {
      letGo(true);
      for (const [f, t] of themed) f.src = t.page(darkMode.matches);
    });
    const inTheme = (page: (dark: boolean) => string, title: string, look: Look) => {
      letGo(false);
      const { box, frame } = siteFrame(page(darkMode.matches), title, look);
      const t = { page, shown: false };
      themed.set(frame, t);
      frame.addEventListener("load", () => (t.shown = true), { once: true });
      return { box, frame };
    };

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
    const sized = ({ box, frame }: { box: HTMLElement; frame: HTMLIFrameElement }) => {
      frame.addEventListener("load", () => frame.contentWindow && sizes.set(frame.contentWindow, (h) => (frame.style.height = `${h}px`)), { once: true });
      return box;
    };

    ctx.urlEmbeds.register("youtube", {
      render: (el, { match }) => el.replaceChildren(siteFrame(`https://www.youtube-nocookie.com/embed/${match[1]}`, "YouTube video", { kind: "video", radius: 12 }).box),
    });
    ctx.urlEmbeds.register("x", {
      render: (el, { match }) =>
        el.replaceChildren(sized(inTheme((dark) => `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}&dnt=true&theme=${dark ? "dark" : "light"}`, "Post on X", { kind: "post", radius: 12, height: 320 }))),
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
          const id = ++posts;
          el.replaceChildren(sized(inTheme((dark) => `https://embed.bsky.app/embed/${did}/app.bsky.feed.post/${match[2]}?id=${id}&colorMode=${dark ? "dark" : "light"}`, "Bluesky post", { kind: "post", radius: 32, height: 260 })));
        })().catch(() => {});
      },
    });
    ctx.urlEmbeds.register("spotify", {
      // Spotify's dark card is theme=0; without it, the card takes its cover's color.
      render: (el, { match }) =>
        el.replaceChildren(inTheme((dark) => `https://open.spotify.com/embed/${match[1]}/${match[2]}${dark ? "?theme=0" : ""}`, "Spotify", { kind: "player", radius: 12, height: match[1] === "track" || match[1] === "episode" ? 152 : 352 }).box),
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
