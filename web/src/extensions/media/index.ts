// Media, a built-in extension: `::noise` embeds (noise.ts), and the media controller for whatever plays
// (ctx.media): background noise, and videos and tracks in link embeds. The mini player in the corner shows
// the one played last, with its note (a link back to it), play, pause and stop, and volume for noise; the
// status bar names it; and the keyboard's media keys work (Media Session). Noise keeps playing when its
// note closes. Each noise embed's volume is kept in the extension's state.
import { EditorView } from "@codemirror/view";
import type { Embed, ExtensionContext, MediaHandle } from "../../extension-api.ts";
import { COLORS, NoisePlayer, type Color } from "./noise.ts";

interface Noise {
  key: string;
  player: NoisePlayer;
  media: MediaHandle;
}

const colorOf = (embed: Embed): Color => (COLORS.includes(embed.args.color as Color) ? (embed.args.color as Color) : "brown");
const titleOf = (embed: Embed) => embed.args.label || `${colorOf(embed)[0].toUpperCase()}${colorOf(embed).slice(1)} noise`;
/** A note's name, as the mini player says where something plays. */
const nameOf = (path: string) => path.replace(/\.md$/, "").split("/").pop() ?? path;

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
    /** The noise loaded: one at a time. */
    let noise: Noise | null = null;
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

    // The mini player: in the corner while something plays, or noise is loaded.
    const mini = document.createElement("div");
    mini.className = "mini-player";
    mini.setAttribute("role", "region");
    mini.setAttribute("aria-label", "Now playing");
    mini.hidden = true;
    const miniToggle = document.createElement("button");
    miniToggle.addEventListener("click", () => toggle());
    const miniTitle = document.createElement("span");
    miniTitle.className = "title";
    // Where it plays: a link back to its note.
    const miniNote = document.createElement("button");
    miniNote.className = "note";
    miniNote.addEventListener("click", () => {
      const now = ctx.media.current();
      if (now) ctx.media.reveal(now.id);
    });
    const miniVolume = slider(
      0.3,
      (v) => noise && (noise.player.volume = v),
      (v) => noise && keepVolume(noise.key, v),
    );
    const miniStop = document.createElement("button");
    miniStop.textContent = "■";
    miniStop.title = "Stop";
    miniStop.setAttribute("aria-label", "Stop");
    miniStop.addEventListener("click", () => stop());
    mini.append(miniToggle, miniTitle, miniNote, miniVolume, miniStop);
    document.body.append(mini);

    const refresh = () => {
      for (const item of live) {
        if (item.el.isConnected) item.update();
        else live.delete(item);
      }
      const now = ctx.media.current();
      const playing = !!now?.playing;
      mini.hidden = !now;
      if (now) {
        miniTitle.textContent = now.title;
        miniToggle.textContent = playing ? "⏸" : "▶";
        miniToggle.title = playing ? "Pause" : "Play";
        miniToggle.setAttribute("aria-label", miniToggle.title);
        miniNote.hidden = !now.note;
        miniNote.textContent = now.note ? nameOf(now.note) : "";
        miniNote.title = now.note ? `Go to ${nameOf(now.note)}` : "";
        const isNoise = now.id === noise?.media.id;
        miniVolume.hidden = !isNoise;
        if (isNoise) miniVolume.value = String(noise!.player.volume);
      }
      const where = now?.note ? ` · ${nameOf(now.note)}` : "";
      ctx.statusBar.set("media.playing", now ? `♪ ${now.title}${where}${playing ? "" : " (paused)"}` : "", now ? (playing ? "Pause it" : "Play it") : undefined);
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = now ? new MediaMetadata({ title: now.title, artist: now.note ? nameOf(now.note) : "Common Ink" }) : null;
        navigator.mediaSession.playbackState = now ? (playing ? "playing" : "paused") : "none";
      }
    };

    const play = (embed: Embed) => {
      context ??= new AudioContext();
      if (noise?.key !== embed.key || noise.player.color !== colorOf(embed)) {
        noise?.player.pause();
        noise?.media.end();
        const player = new NoisePlayer(context, colorOf(embed), volumeFor(embed));
        const media = ctx.media.session({
          title: titleOf(embed),
          kind: "audio",
          note: ctx.workbench.focusedPath(),
          sticky: true,
          play: () => {
            player.play();
            media.set({ playing: true });
          },
          pause: () => {
            player.pause();
            media.set({ playing: false });
          },
          stop: () => {
            player.pause();
            media.end();
            if (noise?.media === media) noise = null;
          },
        });
        noise = { key: embed.key, player, media };
      }
      noise.player.play();
      noise.media.set({ playing: true, title: titleOf(embed) });
    };
    /** Play or pause what the controls control. */
    const toggle = () => {
      const now = ctx.media.current();
      if (now) (now.playing ? ctx.media.pause : ctx.media.play)(now.id);
    };
    const stop = () => {
      const now = ctx.media.current();
      if (now) ctx.media.stop(now.id);
    };
    ctx.media.onChange(refresh);

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => {
        const now = ctx.media.current();
        if (now && !now.playing) ctx.media.play(now.id);
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        const now = ctx.media.current();
        if (now?.playing) ctx.media.pause(now.id);
      });
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
        button.addEventListener("click", () => (noise?.key === ref.embed.key && noise.player.playing ? ctx.media.pause(noise.media.id) : play(ref.embed)));
        const title = document.createElement("span");
        const volume = slider(
          volumeFor(first),
          (v) => noise?.key === ref.embed.key && (noise.player.volume = v),
          (v) => keepVolume(ref.embed.key, v),
        );
        box.append(button, title, volume);
        ref.update = () => {
          const playing = noise?.key === ref.embed.key && noise.player.playing;
          button.textContent = playing ? "Pause" : "Play";
          title.textContent = titleOf(ref.embed);
          box.classList.toggle("playing", playing);
          volume.value = String(noise?.key === ref.embed.key ? noise.player.volume : volumeFor(ref.embed));
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
