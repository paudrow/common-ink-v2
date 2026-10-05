// Boards, from the app's catalog: ```tasks (a live query over the todos in your notes) and ```kanban (a
// board drawn from the block's own markdown). It runs sandboxed: it reads and writes notes only through
// the app, which asks you first, and each change it makes is in history as Boards'.

const TODO = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s?(.*)$/;
const DUE = /(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const EVERY = /(?:^|\s)every:\S+(?=\s|$)/;

const today = () => new Date().toLocaleDateString("en-CA");
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};
const nameOf = (path) => path.replace(/\.md$/, "");
const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * A todo line checked off, or back on. A recurring one (every:week) stays open and moves to its next
 * due date instead, as the Todos extension does: the format is the notes', not either extension's.
 */
function toggle(line, day) {
  const m = TODO.exec(line);
  if (!m) return line;
  if (m[2] !== " ") return `${m[1]}[ ] ${m[3]}`;
  const every = /(?:^|\s)every:(\d*)(day|weekday|week|month|year)s?(?=\s|$)/.exec(m[3]);
  if (!every) return `${m[1]}[x] ${m[3]}`;
  const count = Math.max(1, Number(every[1]) || 1);
  const d = new Date(`${DUE.exec(m[3])?.[1] ?? day}T00:00:00Z`);
  const unit = every[2];
  if (unit === "day") d.setUTCDate(d.getUTCDate() + count);
  else if (unit === "week") d.setUTCDate(d.getUTCDate() + 7 * count);
  else if (unit === "weekday") for (let n = 0; n < count; ) (d.setUTCDate(d.getUTCDate() + 1), d.getUTCDay() % 6 !== 0 && n++);
  else {
    const date = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + (unit === "month" ? count : 12 * count));
    d.setUTCDate(Math.min(date, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  const next = d.toISOString().slice(0, 10);
  return `${m[1]}[ ] ${DUE.test(m[3]) ? m[3].replace(/(^|\s)due:\d{4}-\d{2}-\d{2}/, `$1due:${next}`) : `${m[3]} due:${next}`}`;
}

/** Every todo in a note's text, with its line, so it can be checked off where it is. */
function todosIn(path, text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && TODO.exec(line);
    if (!m) return;
    const due = DUE.exec(m[3])?.[1] ?? null;
    out.push({ path, line: i, text: line, done: m[2] !== " ", title: m[3].replace(DUE, "").replace(EVERY, "").trim(), due });
  });
  return out;
}

/** The todos a ```tasks block asks for, from these notes. */
function query(notes, args) {
  const words = (args.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const day = today();
  const folder = args.folder ? `${args.folder.replace(/\/$/, "")}/` : null;
  const note = args.note ? `${args.note.replace(/\.md$/, "")}.md` : null;
  const todos = notes
    .filter((n) => (!folder || n.path.startsWith(folder)) && (!note || n.path === note))
    .flatMap((n) => todosIn(n.path, n.text))
    .filter((t) => args.done === "true" || !t.done)
    .filter((t) => words.every((w) => t.title.toLowerCase().includes(w)))
    .filter((t) => {
      if (!args.due) return true;
      if (!t.due) return false;
      if (args.due === "overdue") return t.due < day;
      if (args.due === "today") return t.due <= day;
      if (args.due === "week") return t.due <= addDays(day, 7);
      return true;
    });
  todos.sort((a, b) => (a.due ?? "9999") .localeCompare(b.due ?? "9999") || a.path.localeCompare(b.path) || a.line - b.line);
  return todos.slice(0, Math.max(1, Number(args.limit) || 50));
}

const STYLE = `<style>
  body { font: 0.875rem/1.45 var(--prose); margin: 0; padding: 0.4rem 0.5rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; gap: 0.5rem; align-items: baseline; padding: 0.15rem 0; }
  input { accent-color: var(--accent); }
  .done .title { color: var(--muted); text-decoration: line-through; }
  .due { font-size: 0.75rem; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 0.4rem; }
  .due.late { color: #c2410c; border-color: currentColor; }
  .from { margin-left: auto; font-size: 0.75rem; color: var(--muted); background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; text-decoration-color: var(--line); }
  .empty { color: var(--muted); }
  .board { display: flex; gap: 0.6rem; align-items: flex-start; overflow-x: auto; }
  .column { flex: 1 1 0; min-width: 9rem; background: var(--code-bg, rgba(127,127,127,0.06)); border-radius: 6px; padding: 0.4rem; }
  .column h3 { margin: 0 0 0.4rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .column.over { outline: 2px dashed var(--accent); outline-offset: -2px; }
  .card { position: relative; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 0.3rem 0.45rem; margin-bottom: 0.35rem; cursor: grab; }
  .moves { position: absolute; top: 0.15rem; right: 0.2rem; display: flex; opacity: 0; background: var(--bg); }
  .card:hover .moves, .card:focus-within .moves { opacity: 1; }
  .moves button { font: inherit; font-size: 0.75rem; color: var(--muted); background: none; border: none; cursor: pointer; padding: 0 0.2rem; }
  .card.dragging { opacity: 0.4; }
  .slot { height: 0.35rem; }
  .problem { color: #c2410c; }
</style>`;

/** A board from a ```kanban block's lines: each ## heading a column; each - line under it a card, with any lines indented under it. */
function parseBoard(body) {
  const columns = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      columns.push({ name: heading[1].trim(), heading: line, items: [] });
      continue;
    }
    if (!columns.length) columns.push({ name: "", heading: null, items: [] });
    const col = columns[columns.length - 1];
    const card = /^[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (card) col.items.push({ card: true, text: card[1], lines: [line] });
    else if (/^\s+\S/.test(line) && col.items.at(-1)?.card) col.items.at(-1).lines.push(line);
    else col.items.push({ card: false, lines: [line] });
  }
  return columns;
}

const boardText = (columns) => columns.flatMap((c) => [...(c.heading === null ? [] : [c.heading]), ...c.items.flatMap((i) => i.lines)]).join("\n");

/** The board with card `from` (column, index among cards) moved to `to` (column, index among its cards). */
function moveCard(columns, from, to) {
  const cols = columns.map((c) => ({ ...c, items: [...c.items] }));
  const cards = (c) => c.items.map((item, i) => (item.card ? i : -1)).filter((i) => i >= 0);
  const fromAt = cards(cols[from.column])[from.index];
  if (fromAt === undefined) return columns;
  const [card] = cols[from.column].items.splice(fromAt, 1);
  const target = cols[to.column];
  const slots = cards(target);
  // Before the card now at that place; or after the column's last card; or, in an empty column, after
  // what it has but before the blank lines that end it.
  let at;
  if (to.index < slots.length) at = slots[to.index];
  else if (slots.length) at = slots.at(-1) + 1;
  else {
    at = target.items.length;
    while (at > 0 && /^\s*$/.test(target.items[at - 1].lines[0])) at--;
  }
  target.items.splice(at, 0, card);
  return cols;
}

const TASKS_PAGE = `${STYLE}<div id="list"><p class="empty">Gathering todos…</p></div>
<script>
  const list = document.getElementById("list");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  commonInk.onMessage((m) => {
    if (m.problem) return void (list.innerHTML = '<p class="problem">' + esc(m.problem) + "</p>");
    if (!m.todos.length) return void (list.innerHTML = '<p class="empty">Nothing to do here.</p>');
    list.innerHTML = "<ul>" + m.todos.map((t, i) =>
      '<li class="' + (t.done ? "done" : "") + '"><input type="checkbox" data-i="' + i + '"' + (t.done ? " checked" : "") + ' aria-label="Check off ' + esc(t.title) + '">' +
      '<span class="title">' + esc(t.title) + "</span>" +
      (t.due ? '<span class="due' + (t.late ? " late" : "") + '">' + esc(t.due) + "</span>" : "") +
      '<button class="from" data-open="' + i + '">' + esc(t.note) + "</button></li>").join("") + "</ul>";
    list.querySelectorAll("input").forEach((box) => box.addEventListener("change", () => commonInk.post({ toggle: Number(box.dataset.i) })));
    list.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => commonInk.post({ open: Number(b.dataset.open) })));
  });
  commonInk.post({ ready: true });
</script>`;

const BOARD_PAGE = `${STYLE}<div id="board" class="board"></div><p id="problem" class="problem" hidden></p>
<script>
  const board = document.getElementById("board");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let dragging = null;
  const move = (from, to) => commonInk.post({ move: { from, to } });
  commonInk.onMessage((m) => {
    document.getElementById("problem").hidden = !m.problem;
    document.getElementById("problem").textContent = m.problem || "";
    if (!m.columns) return;
    board.innerHTML = m.columns.map((c, ci) =>
      '<section class="column" data-column="' + ci + '"><h3>' + esc(c.name || "Cards") + "</h3>" +
      c.cards.map((card, i) => '<div class="card" draggable="true" data-column="' + ci + '" data-index="' + i + '">' +
        '<span class="text">' + esc(card) + '</span><span class="moves">' +
        (ci > 0 ? '<button data-to="-1" aria-label="Move to ' + esc(m.columns[ci - 1].name) + '">←</button>' : "") +
        (ci < m.columns.length - 1 ? '<button data-to="1" aria-label="Move to ' + esc(m.columns[ci + 1].name) + '">→</button>' : "") +
        "</span></div>").join("") + '<div class="slot"></div></section>').join("");
    board.querySelectorAll(".card").forEach((card) => {
      const from = { column: Number(card.dataset.column), index: Number(card.dataset.index) };
      card.addEventListener("dragstart", (e) => { dragging = from; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.textContent); });
      card.addEventListener("dragend", () => { dragging = null; card.classList.remove("dragging"); });
      card.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const column = from.column + Number(b.dataset.to);
        move(from, { column, index: m.columns[column].cards.length });
      }));
    });
    board.querySelectorAll(".column").forEach((col) => {
      const column = Number(col.dataset.column);
      col.addEventListener("dragover", (e) => { if (!dragging) return; e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", () => col.classList.remove("over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("over");
        if (!dragging) return;
        // Before the card the pointer is over's lower half after, else at the end.
        const cards = [...col.querySelectorAll(".card")];
        let index = cards.findIndex((c) => e.clientY < c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2);
        if (index === -1) index = cards.length;
        if (dragging.column === column && index > dragging.index) index--;
        move(dragging, { column, index });
      });
    });
  });
  commonInk.post({ ready: true });
</script>`;

// For tests: the pieces that don't need the app.
export { boardText, moveCard, parseBoard, query, todosIn, toggle };

export default {
  activate(ctx) {
    /** Every task list on show, by its embed, to redraw when a note changes. */
    const lists = new Map();

    ctx.embeds.register("tasks", {
      resolve(webview, embed) {
        let shown = [];
        const draw = async () => {
          try {
            const files = (await ctx.files.list()).filter((f) => f.path.endsWith(".md"));
            const notes = await Promise.all(files.map(async (f) => ({ path: f.path, text: (await ctx.files.read(f.path)).text })));
            const day = today();
            shown = query(notes, embed.args);
            await webview.post({ todos: shown.map((t) => ({ title: t.title, done: t.done, due: t.due, late: !!t.due && t.due < day && !t.done, note: nameOf(t.path) })) });
          } catch (err) {
            await webview.post({ problem: err.message });
          }
        };
        lists.set(embed.key, draw);
        webview.onMessage(async (m) => {
          if (m.ready) return void draw();
          const t = shown[m.open ?? m.toggle];
          if (!t) return;
          if (m.open !== undefined) return void ctx.workbench.open(t.path, { line: t.line });
          // Check it off (or back on) in its note, if the line is still that todo.
          const file = await ctx.files.read(t.path);
          const lines = file.text.split("\n");
          if (lines[t.line] !== t.text) return void draw();
          lines[t.line] = toggle(t.text, today());
          await ctx.files.write(t.path, lines.join("\n"), file.revision).catch(() => {});
          await draw();
        });
        webview.html = TASKS_PAGE;
      },
    });

    ctx.embeds.register("kanban", {
      resolve(webview, embed) {
        let body = embed.body;
        const show = (problem) => {
          const columns = parseBoard(body);
          return webview.post({ columns: columns.map((c) => ({ name: c.name, cards: c.items.filter((i) => i.card).map((i) => i.text) })), problem });
        };
        webview.onMessage(async (m) => {
          if (m.ready) return void show();
          if (!m.move || !embed.note) return;
          const next = boardText(moveCard(parseBoard(body), m.move.from, m.move.to));
          if (next === body) return;
          // Rewrite this block in its note: the ```kanban block whose body is the one drawn.
          try {
            const file = await ctx.files.read(embed.note);
            const at = file.text.indexOf(`\n${body}\n`, file.text.search(/```kanban/));
            if (at < 0) return void show("The board changed in its note; it'll redraw from there.");
            const text = `${file.text.slice(0, at + 1)}${next}${file.text.slice(at + 1 + body.length)}`;
            const result = await ctx.files.write(embed.note, text, file.revision);
            if (result.status === "conflict") return void show("The note changed meanwhile; try again.");
            body = next;
            await show();
          } catch (err) {
            await show(err.message);
          }
        });
        webview.html = BOARD_PAGE;
      },
    });

    // A task list redraws when any note changes, a moment after.
    let timer = 0;
    ctx.events.onSaved((path) => {
      if (!path.endsWith(".md")) return;
      clearTimeout(timer);
      timer = setTimeout(() => lists.forEach((draw) => void draw()), 300);
    });
  },
};
