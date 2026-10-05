// Media, a built-in extension: `::noise` embeds (noise.ts), and the media controller for what plays.
// One sound plays at a time. While one is loaded, a mini player in the corner shows it with play,
// pause, volume and stop; the status bar names it; and the keyboard's media keys work (Media Session).
// It keeps playing when its note closes. Each embed's volume is kept in the extension's state.
import { EditorView } from "@codemirror/view";
import type { Embed, ExtensionContext } from "../../extension-api.ts";
import { COLORS, NoisePlayer, type Color } from "./noise.ts";

interface Playing {
  key: string;
  title: string;
  player: NoisePlayer;
}

const colorOf = (embed: Embed): Color => (COLORS.includes(embed.args.color as Color) ? (embed.args.color as Color) : "brown");
const titleOf = (embed: Embed) => embed.args.label || `${colorOf(embed)[0].toUpperCase()}${colorOf(embed).slice(1)} noise`;

const theme = EditorView.theme({
  ".noise-embed": { display: "flex", alignItems: "center", gap: "0.75em", padding: "0.4em 0.75em", border: "1px solid var(--line)", borderRadius: "6px", fontFamily: "var(--prose)" },
  ".noise-embed button": { font: "inherit", fontSize: "0.85em", color: "var(--ink)", background: "none", border: "1px solid var(--line)", borderRadius: "4px", padding: "0.1em 0.6em", cursor: "pointer", minWidth: "4.5em" },
  ".noise-embed.playing button": { backgroundColor: "var(--accent-soft)" },
  ".noise-embed input": { width: "8em", accentColor: "var(--accent)" },
});

export default {
  async activate(ctx: ExtensionContext) {
    const kept = (await ctx.state.get()) as { volumes?: Record<string, number> } | null;
    const volumes: Record<string, number> = { ...(kept?.volumes ?? {}) };
    let context: AudioContext | null = null;
    let now: Playing | null = null;
    const live = new Set<{ el: HTMLElement; update(): void }>();

    const volumeFor = (embed: Embed) => volumes[embed.key] ?? Math.min(Math.max(Number(embed.args.volume ?? 0.3) || 0.3, 0), 1);
    const keepVolume = (key: string, v: number) => {
      volumes[key] = Math.round(v * 100) / 100;
      void ctx.state.set({ volumes }).catch(() => {});
    };

    const slider = (value: number, onInput: (v: number) => void, onChange: (v: number) => void) => {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.01";
      input.value = String(value);
      input.setAttribute("aria-label", "Volume");
      input.addEventListener("input", () => onInput(Number(input.value)));
      input.addEventListener("change", () => onChange(Number(input.value)));
      return input;
    };

    // The mini player: in the corner while something is loaded.
    const mini = document.createElement("div");
    mini.className = "mini-player";
    mini.setAttribute("role", "region");
    mini.setAttribute("aria-label", "Now playing");
    mini.hidden = true;
    const miniToggle = document.createElement("button");
    miniToggle.addEventListener("click", () => toggle());
    const miniTitle = document.createElement("span");
    miniTitle.className = "title";
    const miniVolume = slider(
      0.3,
      (v) => now && (now.player.volume = v),
      (v) => now && keepVolume(now.key, v),
    );
    const miniStop = document.createElement("button");
    miniStop.textContent = "■";
    miniStop.title = "Stop";
    miniStop.setAttribute("aria-label", "Stop");
    miniStop.addEventListener("click", () => stop());
    mini.append(miniToggle, miniTitle, miniVolume, miniStop);
    document.body.append(mini);

    const refresh = () => {
      for (const item of live) {
        if (item.el.isConnected) item.update();
        else live.delete(item);
      }
      const playing = !!now?.player.playing;
      mini.hidden = !now;
      if (now) {
        miniTitle.textContent = now.title;
        miniToggle.textContent = playing ? "⏸" : "▶";
        miniToggle.title = playing ? "Pause" : "Play";
        miniToggle.setAttribute("aria-label", miniToggle.title);
        miniVolume.value = String(now.player.volume);
      }
      ctx.statusBar.set("media.playing", now ? `♪ ${now.title}${playing ? "" : " (paused)"}` : "", now ? (playing ? "Pause it" : "Play it") : undefined);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = now ? new MediaMetadata({ title: now.title, artist: "Common Ink" }) : null;
        navigator.mediaSession.playbackState = now ? (playing ? "playing" : "paused") : "none";
      }
    };

    const play = (embed: Embed) => {
      context ??= new AudioContext();
      if (now?.key !== embed.key || now.player.color !== colorOf(embed)) {
        now?.player.pause();
        now = { key: embed.key, title: titleOf(embed), player: new NoisePlayer(context, colorOf(embed), volumeFor(embed)) };
      }
      now.player.play();
      refresh();
    };
    const toggle = () => {
      if (!now) return;
      if (now.player.playing) now.player.pause();
      else now.player.play();
      refresh();
    };
    const stop = () => {
      now?.player.pause();
      now = null;
      refresh();
    };

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => now && !now.player.playing && toggle());
      navigator.mediaSession.setActionHandler("pause", () => now?.player.playing && toggle());
      navigator.mediaSession.setActionHandler("stop", () => stop());
    }

    ctx.editor.extend(theme);
    /** The embed each drawn box shows, by the element it was drawn into: new arguments replace it. */
    const drawn = new WeakMap<HTMLElement, { embed: Embed; update(): void }>();
    ctx.embeds.register("noise", {
      render(el, first) {
        const ref = { embed: first, update: () => {} };
        const box = document.createElement("div");
        box.className = "noise-embed";
        const button = document.createElement("button");
        button.type = "button";
        button.addEventListener("click", () => (now?.key === ref.embed.key && now.player.playing ? toggle() : play(ref.embed)));
        const title = document.createElement("span");
        const volume = slider(
          volumeFor(first),
          (v) => now?.key === ref.embed.key && (now.player.volume = v),
          (v) => keepVolume(ref.embed.key, v),
        );
        box.append(button, title, volume);
        ref.update = () => {
          const playing = now?.key === ref.embed.key && now.player.playing;
          button.textContent = playing ? "Pause" : "Play";
          title.textContent = titleOf(ref.embed);
          box.classList.toggle("playing", playing);
          volume.value = String(now?.key === ref.embed.key ? now.player.volume : volumeFor(ref.embed));
        };
        el.replaceChildren(box);
        live.add({ el: box, update: () => ref.update() });
        drawn.set(el, ref);
        ref.update();
      },
      // A new color plays from the next Play; a new volume or label shows at once.
      update(el: HTMLElement, embed: Embed) {
        const d = drawn.get(el);
        if (!d) return;
        d.embed = embed;
        d.update();
      },
    });
    ctx.commands.register("media.toggle", toggle);
    ctx.commands.register("media.stop", stop);
    refresh();
  },
};
