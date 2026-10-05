// Boards, from the app's catalog: `:::kanban` draws the markdown inside it as a board. It runs
// sandboxed: it reads and writes notes only through the app, which asks you first, and each change it
// makes is in history as Boards'.

const STYLE = `<style>
  body { font: 0.875rem/1.45 var(--prose); margin: 0; padding: 0.4rem 0.5rem; }
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

/** A board from a `:::kanban` container's lines: each ## heading a column; each - line under it a card, with any lines indented under it. */
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
export { boardText, moveCard, parseBoard };

export default {
  activate(ctx) {
    /** How each drawn board takes a new body, by its webview. */
    const updates = new WeakMap();

    ctx.embeds.register("kanban", {
      resolve(webview, embed) {
        let body = embed.body;
        const show = (problem) => {
          const columns = parseBoard(body);
          return webview.post({ columns: columns.map((c) => ({ name: c.name, cards: c.items.filter((i) => i.card).map((i) => i.text) })), problem });
        };
        // Its markdown changed (someone edited it, or this board's own move came back): the board shows it, in the same frame.
        updates.set(webview, (next) => {
          if (next.body === body) return;
          body = next.body;
          void show();
        });
        webview.onMessage(async (m) => {
          if (m.ready) return void show();
          if (!m.move || !embed.note) return;
          const was = body;
          const next = boardText(moveCard(parseBoard(was), m.move.from, m.move.to));
          if (next === was) return;
          // The board moves the card at once; its note follows.
          body = next;
          void show();
          // Rewrite this board in its note: the :::kanban container whose markdown is the one drawn.
          const undo = (problem) => {
            body = was;
            return show(problem);
          };
          try {
            const file = await ctx.files.read(embed.note);
            const at = file.text.indexOf(`\n${was}\n`, file.text.search(/^:::kanban\b/m));
            if (at < 0) return void undo("The board changed in its note; it'll redraw from there.");
            const text = `${file.text.slice(0, at + 1)}${next}${file.text.slice(at + 1 + was.length)}`;
            const result = await ctx.files.write(embed.note, text, file.revision);
            if (result.status === "conflict") return void undo("The note changed meanwhile; try again.");
          } catch (err) {
            await undo(err.message);
          }
        });
        webview.html = BOARD_PAGE;
      },
      update: (webview, embed) => updates.get(webview)?.(embed),
    });
  },
};
