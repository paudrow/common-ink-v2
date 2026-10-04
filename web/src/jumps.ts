// Ctrl-O and Ctrl-I across notes: the notes this pane has shown, and where the cursor was in each.
import type { DocPath } from "../../worker/src/docs.ts";

export interface Spot {
  path: DocPath;
  pos: number;
}

export class Jumps {
  private spots: Spot[];
  private at = 0;

  constructor(start: Spot) {
    this.spots = [start];
  }

  /** Leave `from` for a new note: anything ahead of here is dropped, as in Vim. */
  visit(from: Spot, to: DocPath): void {
    this.spots.splice(this.at, Infinity, from, { path: to, pos: 0 });
    this.at++;
  }

  back(from: Spot): Spot | null {
    return this.step(from, -1);
  }

  forward(from: Spot): Spot | null {
    return this.step(from, 1);
  }

  private step(from: Spot, by: 1 | -1): Spot | null {
    const to = this.spots[this.at + by];
    if (!to) return null;
    this.spots[this.at] = from;
    this.at += by;
    return to;
  }
}
