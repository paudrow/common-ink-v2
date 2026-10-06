// One open note and how its edits reach the server. Saves run one at a time; each sends the text with
// the revision it's based on. When the server merges in someone else's edit, the editor takes it too,
// merged with anything typed while the save was out.
import { merge, type WorkspaceFile, type FilePath, type Revision, type WriteResult } from "../../worker/src/files.ts";

export type SaveStatus = "saved" | "unsaved" | "saving" | "conflict" | "offline";

export interface Editor {
  text(): string;
  /** Swap in text from the server, without counting it as an edit. `remote` when someone else changed it. */
  replace(text: string, remote?: boolean): void;
}

/** `edit` names the text being sent, so a page that never hears the answer can ask later whether it landed. */
export type WriteFile = (path: FilePath, text: string, base: Revision, edit: string) => Promise<WriteResult>;

/** What a save would send: the text, the revision it's based on, and the id that names that text. */
export interface Unsaved {
  path: FilePath;
  text: string;
  base: Revision;
  edit: string;
}

const newEditId = () => crypto.randomUUID();

export class Session {
  readonly path: FilePath;
  status: SaveStatus = "saved";
  /** The revision the editor's text is based on, and the text it had then. */
  private base: Revision;
  private baseText: string;
  private queue = Promise.resolve();
  /** The id of the editor's text as it was last sent or kept: a new text gets a new one. */
  private edit: { id: string; text: string } | null;

  constructor(
    file: WorkspaceFile,
    private editor: Editor,
    private write: WriteFile,
    private onStatus: (status: SaveStatus) => void = () => {},
    /** "conflict" for an edit this browser kept because it clashed with the server's: it waits to be settled. */
    status: Extract<SaveStatus, "saved" | "conflict"> = "saved",
    /** The id of the kept edit the editor starts with, so sending it again is known as the same edit. */
    edit: { id: string; text: string } | null = null,
  ) {
    this.status = status;
    this.edit = edit;
    this.path = file.path;
    this.base = file.revision;
    this.baseText = file.text;
  }

  /** The revision the editor's text is based on: 0 until the file is first saved. */
  get revision(): Revision {
    return this.base;
  }

  /** The text at that revision. */
  get savedText(): string {
    return this.baseText;
  }

  get dirty(): boolean {
    return this.editor.text() !== this.baseText;
  }

  /** What a save would send now, or null if there's nothing to save. */
  get unsaved(): Unsaved | null {
    if (!this.dirty) return null;
    const text = this.editor.text();
    return { path: this.path, text, base: this.base, edit: this.editId(text) };
  }

  private editId(text: string): string {
    if (this.edit?.text !== text) this.edit = { id: newEditId(), text };
    return this.edit.id;
  }

  edited(): void {
    if (this.status === "saved") this.set(this.dirty ? "unsaved" : "saved");
  }

  /** Save if there's anything to save. After a conflict, only an explicit save (`:w`) tries again. */
  save(explicit = false): Promise<void> {
    this.queue = this.queue.then(() => this.send(explicit));
    return this.queue;
  }

  /**
   * Take in a newer version from the server (someone else's change), merged with anything typed here
   * and not yet saved. Waits for a save that's under way. If the two touch the same lines, the typing
   * stays and the session says so; nothing is overwritten.
   */
  absorb(latest: WorkspaceFile): Promise<void> {
    this.queue = this.queue.then(() => {
      if (latest.revision <= this.base) return;
      const now = this.editor.text();
      const merged = now === this.baseText ? latest.text : merge(now, this.baseText, latest.text);
      if (merged === null) return this.set("conflict");
      if (merged !== now) this.editor.replace(merged, true);
      [this.base, this.baseText] = [latest.revision, latest.text];
      this.set(this.dirty ? "unsaved" : "saved");
    });
    return this.queue;
  }

  /**
   * Settle a clash: take the server's latest as what the editor's text is based on, keeping that text.
   * Saving it then puts yours over theirs; changing the editor to theirs leaves nothing to save.
   */
  adopt(latest: WorkspaceFile): Promise<void> {
    this.queue = this.queue.then(() => {
      [this.base, this.baseText] = [latest.revision, latest.text];
      this.set(this.dirty ? "unsaved" : "saved");
    });
    return this.queue;
  }

  /** Replace the editor's text with the server's latest (`:e!`). */
  reload(file: WorkspaceFile): void {
    this.base = file.revision;
    this.baseText = file.text;
    this.editor.replace(file.text);
    this.set("saved");
  }

  private async send(explicit: boolean): Promise<void> {
    if (this.status === "conflict" && !explicit) return;
    const text = this.editor.text();
    if (text === this.baseText) return this.set("saved");
    this.set("saving");
    let result: WriteResult;
    try {
      result = await this.write(this.path, text, this.base, this.editId(text));
    } catch {
      return this.set("offline");
    }
    if (result.status === "conflict") return this.set("conflict");
    // It's in: the next text is a new edit, even if it's this one again (put back after someone changed it).
    this.edit = null;
    const { file } = result;
    const now = this.editor.text();
    const caughtUp = now === text ? file.text : merge(now, text, file.text);
    // If the typing and the merged-in edit overlap, the next save sends both and the server decides.
    if (caughtUp !== null) {
      if (caughtUp !== now) this.editor.replace(caughtUp);
      [this.base, this.baseText] = [file.revision, file.text];
    }
    this.set(this.dirty ? "unsaved" : "saved");
  }

  private set(status: SaveStatus) {
    this.status = status;
    this.onStatus(status);
  }
}
