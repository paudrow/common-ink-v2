// One open note and how its edits reach the server. Saves run one at a time; each sends the text with
// the revision it's based on. When the server merges in someone else's edit, the editor takes it too,
// merged with anything typed while the save was out.
import { merge, type Note, type NotePath, type Revision, type WriteResult } from "../../worker/src/notes.ts";

export type SaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "offline";

export interface Doc {
  text(): string;
  /** Swap in text from the server, without counting it as an edit. */
  replace(text: string): void;
}

export type WriteNote = (path: NotePath, text: string, base: Revision) => Promise<WriteResult>;

export class Session {
  readonly path: NotePath;
  status: SaveStatus = "saved";
  /** The revision the editor's text is based on, and the text it had then. */
  private base: Revision;
  private baseText: string;
  private queue = Promise.resolve();

  constructor(
    note: Note,
    private doc: Doc,
    private write: WriteNote,
    private onStatus: (status: SaveStatus) => void = () => {},
  ) {
    this.path = note.path;
    this.base = note.revision;
    this.baseText = note.text;
  }

  get dirty(): boolean {
    return this.doc.text() !== this.baseText;
  }

  /** What a save would send now, or null if there's nothing to save. */
  get unsaved(): { path: NotePath; text: string; base: Revision } | null {
    return this.dirty ? { path: this.path, text: this.doc.text(), base: this.base } : null;
  }

  edited(): void {
    if (this.status === "saved") this.set(this.dirty ? "unsaved" : "saved");
  }

  /** Save if there's anything to save. After a conflict, only an explicit save (`:w`) tries again. */
  save(explicit = false): Promise<void> {
    this.queue = this.queue.then(() => this.send(explicit));
    return this.queue;
  }

  /** Replace the editor's text with the server's latest (`:e!`). */
  reload(note: Note): void {
    this.base = note.revision;
    this.baseText = note.text;
    this.doc.replace(note.text);
    this.set("saved");
  }

  private async send(explicit: boolean): Promise<void> {
    if (this.status === "conflict" && !explicit) return;
    const text = this.doc.text();
    if (text === this.baseText) return this.set("saved");
    this.set("saving");
    let result: WriteResult;
    try {
      result = await this.write(this.path, text, this.base);
    } catch {
      return this.set("offline");
    }
    if (result.status === "conflict") return this.set("conflict");
    const { note } = result;
    const now = this.doc.text();
    const caughtUp = now === text ? note.text : merge(now, text, note.text);
    // If the typing and the merged-in edit overlap, the next save sends both and the server decides.
    if (caughtUp !== null) {
      if (caughtUp !== now) this.doc.replace(caughtUp);
      [this.base, this.baseText] = [note.revision, note.text];
    }
    this.set(this.dirty ? "unsaved" : "saved");
  }

  private set(status: SaveStatus) {
    this.status = status;
    this.onStatus(status);
  }
}
