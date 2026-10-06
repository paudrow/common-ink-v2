// What plays in the app, wherever it comes from: background noise made in the page, or a video or a
// track in a note's link embed. Each is a session: the Media extension's mini player, the status bar and
// the keyboard's media keys control the one played last, and a playing video whose note goes out of
// sight floats in a small window (lives.ts) instead of stopping or playing unseen ("media.whenHidden").
import type { EditorView } from "@codemirror/view";
import type { FilePath } from "../../worker/src/files.ts";

export type MediaKind = "video" | "audio";
/** What a playing embed does when its note goes out of sight: float (videos), play on unseen, or pause. */
export type WhenHidden = "float" | "keepPlaying" | "pause";

export interface MediaSpec {
  title: string;
  /** A video floats while its note is out of sight; audio plays on unseen. */
  kind: MediaKind;
  /** Where it's drawn, inside an embed's box, if it's in a note. */
  el?: HTMLElement;
  /** The note it's from, when it isn't drawn in one (background noise, which plays on without it). */
  note?: FilePath | null;
  /** It's in the mini player from the start (background noise, loaded), not only once it's played. */
  sticky?: boolean;
  play(): void;
  pause(): void;
  /** Stop for good. Without it, stopping pauses (and an embed's floating window closes). */
  stop?(): void;
}

export interface MediaSession extends MediaSpec {
  readonly id: number;
  playing: boolean;
  /** When it last started playing: the one played last is the one the controls control. */
  played: number;
  /** It's played, and hasn't been stopped since: paused, it stays in the mini player, to play on. */
  held: boolean;
}

export interface MediaHandle {
  readonly id: number;
  /** It started or stopped playing, or is called something else now. */
  set(patch: { playing?: boolean; title?: string }): void;
  /** It's gone: its embed was let go, or it was stopped for good. */
  end(): void;
}

const sessions = new Map<number, MediaSession>();
const listeners = new Set<() => void>();
let ids = 0;
let notifying = 0;

function changed() {
  if (notifying) return;
  notifying = 1;
  queueMicrotask(() => {
    notifying = 0;
    for (const fn of listeners) fn();
  });
}

/** How the app answers for its media: the setting, and how to show a note again. main.ts sets these. */
export const mediaHooks: {
  whenHidden(): WhenHidden;
  /** Show this editor's tab and scroll to `pos`. */
  reveal(view: EditorView, pos: number | null): void;
  /** Open a note whose tab was closed. */
  open(path: FilePath): Promise<void>;
} = {
  whenHidden: () => "float",
  reveal: () => {},
  open: async () => {},
};

/** A setting's value as one of the three, "float" if it's anything else. */
export const whenHiddenOf = (value: unknown): WhenHidden => (value === "keepPlaying" || value === "pause" ? value : "float");

export function startMedia(spec: MediaSpec): MediaHandle {
  const session: MediaSession = { ...spec, id: ++ids, playing: false, played: 0, held: false };
  sessions.set(session.id, session);
  changed();
  return {
    id: session.id,
    set(patch) {
      if (!sessions.has(session.id)) return;
      if (patch.title !== undefined && patch.title !== session.title) session.title = patch.title;
      if (patch.playing !== undefined && patch.playing !== session.playing) {
        session.playing = patch.playing;
        if (patch.playing) [session.played, session.held] = [performance.now(), true];
      }
      changed();
    },
    end() {
      if (sessions.delete(session.id)) changed();
    },
  };
}

/** Every session, the one played last first. */
export const mediaSessions = (): MediaSession[] => [...sessions.values()].sort((a, b) => b.played - a.played || b.id - a.id);

/** The session the controls act on: the one played last, until it's stopped. */
export const currentMedia = (): MediaSession | null => mediaSessions().find((s) => s.playing || s.held || s.sticky) ?? null;

/** Stopped: out of the mini player (until it plays again), though it may stay in its note. */
export function letGoMedia(session: MediaSession) {
  if (!session.held || !sessions.has(session.id)) return;
  session.held = false;
  changed();
}

export const mediaSession = (id: number): MediaSession | null => sessions.get(id) ?? null;

/** The session drawn in this embed's box, if any. */
export function mediaIn(box: HTMLElement): MediaSession | null {
  for (const s of sessions.values()) if (s.el && box.contains(s.el)) return s;
  return null;
}

/** An embed's box is let go: what played in it is gone. */
export function endMediaIn(box: HTMLElement) {
  let any = false;
  for (const s of sessions.values()) if (s.el && box.contains(s.el)) any = sessions.delete(s.id) || any;
  if (any) changed();
}

/** Call `fn` after sessions change (in a microtask, once for many changes). */
export function onMedia(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
