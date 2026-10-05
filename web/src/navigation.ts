// Where you've been, app-wide, as VS Code keeps it: one history across every window, not one per
// window. Each place is a window, a file in it, and where the cursor was. Only real jumps make a new
// place (opening a file, following a link, a jump of more than a few lines, going to another window);
// moving the cursor about only updates where you are now. Going back and forward moves along the
// places; a new jump after going back drops the ones ahead, as a browser does. The app mirrors it in
// the browser's own history (a pushState per jump, carrying the place's id), so Back, Forward and
// swipes all work, and it's kept for the tab's session, so a reload keeps it.
import type { FilePath } from "../../worker/src/files.ts";
import type { GroupId } from "./layout.ts";

/** One place you were. */
export interface Place {
  window: GroupId;
  file: FilePath;
  /** The cursor: where the selection's head was. */
  pos: number;
  /** Its line, for telling a jump from a step. */
  line: number;
  /** It was showing in the window's preview tab. */
  preview?: boolean;
}

/** A place in the history: with its id, which the browser's entry for it carries. */
export type Visit = Place & { id: number };

/** A jump of more than this many lines within a file counts as one; less is the cursor moving about. */
export const NEAR_LINES = 10;

/** At most this many places are kept: the oldest go first. */
const MAX = 200;

const near = (a: Place, b: Place) => a.window === b.window && a.file === b.file && Math.abs(a.line - b.line) <= NEAR_LINES;

export class Navigation {
  private visits: Visit[] = [];
  private at = -1;
  private nextId = 1;

  constructor(saved?: { visits: Visit[]; at: number } | null) {
    if (saved && Array.isArray(saved.visits) && saved.visits.length && saved.at >= 0 && saved.at < saved.visits.length) {
      [this.visits, this.at] = [saved.visits, saved.at];
      this.nextId = Math.max(...saved.visits.map((v) => v.id)) + 1;
    }
  }

  /** Where you are, if anywhere yet. */
  get here(): Visit | null {
    return this.visits[this.at] ?? null;
  }

  /** The place `by` steps back (-1) or forward (1), if there is one. */
  step(by: -1 | 1): Visit | null {
    return this.visits[this.at + by] ?? null;
  }

  /**
   * You're at `place` now. A jump (a new file or window, or far within the file) makes it a new place,
   * dropping any ahead; otherwise it's where you are, updated. Says which, for the browser's history to
   * follow: "push" a new entry, or "replace" the current one.
   */
  arrive(place: Place, jump: boolean): { how: "push" | "replace"; visit: Visit } {
    const here = this.here;
    // The first place is where the page opened: the browser's entry for it is already there.
    if (!here || !jump || near(here, place)) {
      const visit = { ...place, id: here?.id ?? this.nextId++ };
      if (here) this.visits[this.at] = visit;
      else [this.visits, this.at] = [[visit], 0];
      return { how: "replace", visit };
    }
    const visit = { ...place, id: this.nextId++ };
    this.visits.splice(this.at + 1, Infinity, visit);
    this.at++;
    if (this.visits.length > MAX) {
      this.visits.splice(0, this.visits.length - MAX);
      this.at = this.visits.length - 1;
    }
    return { how: "push", visit };
  }

  /** Go to the place with this id (from the browser's Back or Forward, or the app's own), if it's kept. */
  goTo(id: number): Visit | null {
    const index = this.visits.findIndex((v) => v.id === id);
    if (index < 0) return null;
    this.at = index;
    return this.visits[index];
  }

  /** What to keep across a reload of the page. */
  toJSON(): { visits: Visit[]; at: number } {
    return { visits: this.visits, at: this.at };
  }
}
