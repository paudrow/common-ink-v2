// The app: a list of notes and one vim editor. Edits save on a pause, on blur and on `:w`; `:e <note>`,
// `gd` and the note list open notes; Ctrl-O and Ctrl-I step back and forward, within a note first.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import type { Note, NotePath, NoteSummary, Revision, WriteResult } from "../../worker/src/notes.ts";
import { createState, replaceText } from "./editor.ts";
import { Jumps, type Spot } from "./jumps.ts";
import { noteLinkAt, notePathFor } from "./links.ts";
import { Session, type SaveStatus } from "./session.ts";

const PAUSE_MS = 1000;
const RETRY_MS = 5000;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const list = $<HTMLUListElement>("#notes ul");
const modeLine = $("#mode");
const saveLine = $("#save");

const api = {
  async list(): Promise<NoteSummary[]> {
    return (await ok(await fetch("/api/notes"))).json();
  },
  async read(path: NotePath): Promise<Note> {
    const res = await fetch(`/api/note?path=${encodeURIComponent(path)}`);
    return res.status === 404 ? { path, text: "", revision: 0 } : (await ok(res)).json();
  },
  async write(path: NotePath, text: string, base: Revision, keepalive = false): Promise<WriteResult> {
    const body = JSON.stringify({ path, text, base });
    const res = await fetch("/api/note", { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive });
    return (res.status === 409 ? res : await ok(res)).json();
  },
};

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

const view = new EditorView({ parent: $("#editor") });
let session: Session | null = null;
let jumps: Jumps | null = null;
let notes: NoteSummary[] = [];
let pauseTimer = 0;

const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "Saved",
  unsaved: "Edited",
  saving: "Saving…",
  conflict: "Not saved: this note changed in the same place elsewhere. :e! loads that version.",
  offline: "Not saved: can't reach the server. Trying again.",
};

function showStatus(status: SaveStatus) {
  saveLine.textContent = SAVE_TEXT[status];
  saveLine.dataset.status = status;
  if (status === "offline") {
    clearTimeout(pauseTimer);
    pauseTimer = window.setTimeout(() => void session?.save(), RETRY_MS);
  }
  if (status === "saved" && session && !notes.some((n) => n.path === session!.path)) void renderList(true);
}

function edited() {
  session?.edited();
  clearTimeout(pauseTimer);
  pauseTimer = window.setTimeout(() => void session?.save(), PAUSE_MS);
}

const here = (): Spot | null => (session ? { path: session.path, pos: view.state.selection.main.head } : null);

/** Save the open note before leaving it. If it can't be saved, stay, as Vim does without a `!`. */
async function saveToLeave(): Promise<boolean> {
  clearTimeout(pauseTimer);
  await session?.save();
  if (!session?.dirty) return true;
  saveLine.textContent = "This note isn't saved, so it's still open. :w tries again; :e! loads the saved version.";
  return false;
}

/** Show a note in the editor, saving the one that's open first. */
async function open(path: NotePath, how: { pos?: number; jump?: boolean } = {}) {
  const from = here();
  if (!(await saveToLeave())) return;
  const note = await api.read(path);
  view.setState(createState(note.text, edited, () => void session?.save()));
  const pos = Math.min(how.pos ?? 0, view.state.doc.length);
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
  freshVimJumps();
  watchVimMode();
  const opened: Session = new Session(note, { text: () => view.state.doc.toString(), replace: (text) => replaceText(view, text) }, api.write, (s) => {
    if (session === opened) showStatus(s);
  });
  session = opened;
  if (from && how.jump !== false) jumps?.visit(from, path);
  jumps ??= new Jumps({ path, pos });
  history.replaceState(null, "", `?note=${encodeURIComponent(path)}`);
  document.title = `${path.replace(/\.md$/, "")} · Common Ink`;
  showStatus("saved");
  void renderList();
  view.focus();
}

async function step(by: "back" | "forward") {
  if (!(await saveToLeave())) return;
  const from = here();
  const to = from && jumps?.[by](from);
  if (to) await open(to.path, { pos: to.pos, jump: false });
}

async function renderList(refresh = false) {
  if (refresh) notes = await api.list();
  const current = session?.path;
  const items = !current || notes.some((n) => n.path === current) ? notes : [...notes, { path: current, revision: 0 }];
  list.replaceChildren(
    ...items.map((n) => {
      const a = document.createElement("a");
      a.href = `?note=${encodeURIComponent(n.path)}`;
      a.textContent = n.path.replace(/\.md$/, "");
      if (n.path === current) a.setAttribute("aria-current", "page");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void open(n.path);
      });
      const li = document.createElement("li");
      li.append(a);
      return li;
    }),
  );
}

/**
 * Vim's jump list is global and holds positions in the note that was open before; in a shorter note
 * the next G or gg throws on them. Each note starts a fresh jump list, keeping registers and searches.
 */
function freshVimJumps() {
  const kept = { ...Vim.getVimGlobalState_() };
  Vim.resetVimGlobalState_();
  const fresh = Vim.getVimGlobalState_();
  Object.assign(fresh, kept, { jumpList: fresh.jumpList });
}

function watchVimMode() {
  modeLine.textContent = "NORMAL";
  getCM(view)?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
    modeLine.textContent = [e.mode, e.subMode].filter(Boolean).join(" ").toUpperCase();
  });
}

/** Ctrl-O and Ctrl-I move through Vim's jumps in this note, then on to the previous or next note. */
function jumpOrStep(by: "back" | "forward") {
  const cm = getCM(view);
  const jumpList = Vim.getVimGlobalState_().jumpList;
  const offset = by === "back" ? -1 : 1;
  const cursor = cm?.getCursor();
  const pos = cm && jumpList.find(cm, offset);
  if (cm && pos && cursor && (pos.line !== cursor.line || pos.ch !== cursor.ch)) {
    jumpList.move(cm, offset);
    cm.setCursor(pos);
  } else void step(by);
}

Vim.defineEx("write", "w", () => void session?.save(true));
Vim.defineEx("edit", "e", (_cm: unknown, params: { argString?: string; input?: string }) => {
  const arg = (params.argString ?? "").trim();
  const force = /^e(dit)?!/.test(params.input ?? "") || arg.startsWith("!");
  const name = arg.replace(/^!\s*/, "");
  if (name) {
    const path = notePathFor(name);
    if (path) void open(path);
    return;
  }
  if (!session || (session.dirty && !force)) return;
  const current = session;
  void api.read(current.path).then((note) => current === session && current.reload(note));
});
Vim.defineAction("followLink", () => {
  if (!session) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const path = noteLinkAt(line.text, head - line.from, session.path);
  if (path) void open(path);
});
Vim.mapCommand("gd", "action", "followLink", {}, { context: "normal" });
Vim.defineAction("jumpBack", () => jumpOrStep("back"));
Vim.defineAction("jumpForward", () => jumpOrStep("forward"));
Vim.mapCommand("<C-o>", "action", "jumpBack", {}, { context: "normal" });
Vim.mapCommand("<C-i>", "action", "jumpForward", {}, { context: "normal" });

// Leaving the page: send what's unsaved without waiting for an answer.
window.addEventListener("pagehide", () => {
  const unsaved = session?.unsaved;
  if (unsaved) void api.write(unsaved.path, unsaved.text, unsaved.base, true).catch(() => {});
});

try {
  notes = await api.list();
  const asked = notePathFor(new URLSearchParams(location.search).get("note") ?? "");
  await open(asked ?? notes.find((n) => n.path === "Try this PR.md")?.path ?? notes[0]?.path ?? notePathFor("Welcome")!);
} catch (err) {
  saveLine.textContent = `Couldn't load notes: ${(err as Error).message}`;
}
