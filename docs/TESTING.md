# Testing Common Ink

How people and agents run the app locally and on Previews, hold it still with test levers, look inside it, and pin bugs down with tests. The first half says how; the reference is at the end.

Levers work only where everyone is a dev user anyway: `npm run dev`, the browser tests and Previews. Production never has them (see [Levers are never on in production](#levers-are-never-on-in-production)).

## Run the app locally on a scenario

```sh
npm run dev                            # http://localhost:8787, every Preview's sample notes
npm run dev -- --scenario lists        # just the lists tour, on the scenario's clock
npm run dev -- --scenario todos --fresh --port 8790
```

`npm run dev` builds the app, seeds the workspace and starts the Worker with its Durable Object as the dev user `dev@localhost`. Each scenario keeps its own workspace on disk in `.wrangler/scenarios/<name>`, so switching scenarios keeps what you did in each. `--fresh` resets the workspace to its scenario once the server is up.

In Claude Code, `preview_start` starts the same servers by name from `.claude/launch.json`: `common-ink` on port 8787, and `common-ink-lists`, `common-ink-todos`, `common-ink-embeds`, `common-ink-extensions`, `common-ink-history` and `common-ink-empty` on ports 8788 to 8793. Stop a server by the process you started, never by what listens on its port.

## Check a change in one command

`npm run probe` drives the app in headless Chrome with a real keyboard and prints what the app says, as JSON. Without `--url` it starts its own Worker on a fresh workspace, and rebuilds the app first if the code changed.

```sh
npm run probe -- --scenario lists --open "Lists tour" --keys "/Basil<CR>>>" --wait idle --dump cursor
npm run probe -- --scenario todos --open "Todo edge cases" --check all --screenshot chips.png
npm run probe -- --scenario embeds --open "Three.js scene" --wait 3000 --probe-embeds --screenshot scene.png
npm run probe -- --url http://localhost:8788 --dump state
```

Each step that answers prints one line, and the last line says whether the page logged an error. The probe exits 1 if a step failed or the page logged an error. Its screenshots include what WebGL draws inside sandboxed frames.

## Drive the app from a browser tool

An agent's browser tool often types text without key events, so Vim never sees the keys. Use the inspector instead, from the page's console or the tool's JavaScript:

```js
await __commonInk.keys("/Order<CR>>>");   // real keydown, keypress and keyup, through Vim
await __commonInk.idle();                 // saves sent, live socket open, nothing in flight
await __commonInk.state();                // layout, cursor, Vim mode, extensions, prompts, errors…
await __commonInk.check.lineShift([5, 6]);
await __commonInk.embeds.probe();         // what each webview's canvases show
```

A screenshot tool may show sandboxed frames blank. `__commonInk.embeds.probe()` says whether each frame drew, and how much of each canvas is filled; the probe CLI's `--screenshot` shows them.

## Test on a Preview

Every pull request's Preview has levers. Its status bar shows the ones in effect at its right end, and the command bar (⌘⇧P) has the levers' commands:

- **Test levers: Reset the workspace to its scenario** empties the workspace and seeds it again.
- **Test levers: Reset the workspace to a scenario…** picks one.
- **Test levers: Go offline, or back online** toggles the `offline` lever.
- **Test levers: Copy the inspector's state as JSON** copies `__commonInk.state()`.

From a terminal, `COMMON_INK_URL=<Preview> bin/common-ink reset lists` resets it, and `npm run probe -- --url <Preview> --scenario lists ...` resets it and drives it. Set levers in the address, as in `<Preview>/?now=2026-12-24T09:00&permissions=allow`.

## Add a regression test

1. Reproduce the bug with the probe or the inspector, on the smallest scenario that shows it.
2. Write a `browserTest` in `test/browser/regressions.browser.ts` (or the file for its feature) that does what a person did and asserts what they saw. Prefer an inspector check (`check.overlaps`, `check.lineShift`, `check.layoutFill`, `check.layoutShifts`) or `state()` to measuring the page in the test.
3. Take the fix out and run the test. It has to fail. If it passes, it doesn't test the bug yet. Open the window the bug needs (for a race, `__commonInk.slow()` delays requests) and try again.
4. If the fix is in another pull request that hasn't landed, give the test `todo: "<what>, fixed in #<n>"`. It runs and reports, without failing the run, and says when it starts passing.

For logic without a page (lists, layouts, merges, recurrence), add a case to the property tests in `test/property/` or a unit test in `test/`.

## Scenarios

A scenario is a workspace to test against, as data: `test/scenarios/<name>.json` names Preview sections from `examples/preview/`, Catalog extensions to install, the clock its dates are written against, and the note it opens on. Notes of its own go in `test/scenarios/<name>/`. `{{today}}`, `{{today+3}}` and `{{today-1}}` in its notes are dates from its clock.

| Scenario | What it holds | Clock |
| --- | --- | --- |
| `preview` | Every Preview's sample notes and a Try this PR note. It's the default. | real |
| `empty` | No notes at all. | real |
| `lists` | The lists tour: nested bullets, numbered lists and todo lists. | 2026-10-05 09:00 |
| `todos` | Todos due yesterday, today and later, recurring todos, Boards, and a week of recorded calendar events and contacts. | 2026-10-05 09:00 |
| `embeds` | Timers, noise, an html-app with uPlot and three.js, link embeds, code blocks, tables and math. | 2026-10-05 09:00 |
| `extensions` | Word count installed from the Catalog, sandboxed, asking before it reads a note. | 2026-10-05 09:00 |
| `history` | A note with four changes by two agents after the seed, and a label. | 2026-10-05 09:00 |

`npm run seed` writes every scenario's seed into `dist/levers/scenarios/`, which is what a reset reads.

## Levers

| Lever | Set it with | What it does |
| --- | --- | --- |
| Clock | `?now=2026-10-05T09:00`, `?now=2026-10-05`, `?now=real` | The page's `Date` starts at that local time and runs on, across reloads of the tab. A scenario's clock applies unless you set one. Sandboxed frames keep the real clock. |
| Permission prompts | `?permissions=allow`, `deny` or `ask` | `allow` answers Allow once and `deny` refuses for the session; neither keeps an answer in settings. `ask` shows the prompt. Either way, `state().permissions.prompts` records it. |
| Network | `?net=replay` or `live` | With `replay`, brokered fetches and link cards answer from `test/fixtures/net.json` and never reach the network. An unrecorded URL fails and says how to record it. `npm run net:record -- <url> [--card]` adds recordings. |
| Offline | `?offline=1` or `0`, or the command | The page's own requests fail as a dropped connection does, its live socket stays shut, and `navigator.onLine` is false. Tests and the probe use Chrome's real offline mode instead (`--set-offline on`). |
| Slow requests | `__commonInk.slow("^PUT /api/file", 2000)` | Holds back the page's requests that match by that many ms, to open the window a race needs. `slow()` clears it. |
| Reset | the commands, `bin/common-ink reset [scenario]`, `POST /api/levers/reset {"scenario": "lists"}` | Empties the workspace and seeds it from a scenario, or from the deploy's own seed. Revisions keep counting up. Open pages forget their cached files and load again. A workspace reset to a named scenario stays on it when the Preview deploys again. |
| Calendar and contacts | always, where `DATA_FIXTURES` is set | Recorded Google data from `worker/src/fixtures/`, dated the week of 2026-10-05. |

Levers set in the address are kept in the `common-ink-levers` cookie, so they last across reloads and the Worker sees them. An empty value clears one: `?net=`. `__commonInk.levers.set({ now: null })` changes them without a reload.

With levers on, the page also checks what must always hold, and logs a console error (which fails a browser test) when it doesn't. A layout must stay tidy (`web/src/layout-problems.ts`), and the revisions the live socket announces must only count up.

## The inspector

`window.__commonInk` exists only where levers are on.

| Call | Answer |
| --- | --- |
| `state()` | Everything below as plain data: `scenario`, `levers`, `clock`, `focus`, `cursor`, `vim` (mode and pending keys), `layout`, `windows` (with each one's tabs and size on screen), `pending` saves, `save`, `network` (online, socket, unsent edits), `extensions` (state and error), `permissions` (grants and prompts), `activity`, `history` (the latest 15 changes), `problems` (errors and broken invariants), `embeds`, `layoutShifts`, `notices` and `dialogs`. |
| `where()` | The focused note, line, column and Vim mode, without a request. |
| `keys(seq)` | Presses keys where focus is, in Vim's notation (see below). |
| `cursor(line, column)` | Puts the cursor in the focused note. |
| `open(note)` | Opens a note by name or path. |
| `command(titleOrId)` | Runs a command. |
| `idle({ timeout, quiet })` | Waits until saves are sent, the live socket is open (unless offline), no request is in flight and no extension is reaching the network. Throws with what it was waiting on after `timeout` ms. |
| `reset(scenario?)` | Resets the workspace, to its own scenario by default, and loads the page again. |
| `slow(pattern?, ms)` | See the levers. |
| `levers.get()`, `levers.set(changes)` | Reads or changes levers. |
| `clock.now()`, `clock.set(time)`, `clock.advance(ms)` | Reads or moves the page's clock. |
| `check.overlaps()` | Widgets inside a line (todo chips and checkboxes, bullets, numbers, inline math) that sit over its text or each other, or chips whose text spills out. |
| `check.lineShift(lines?)` | How far each line's text moves sideways when the cursor comes onto it, for the given lines or every line on screen. |
| `check.layoutFill()` | Windows that don't take the share of the workbench their layout gives them. |
| `check.layoutShifts(since)` | The layout shifts Chrome saw since a `performance.now()` time, with each moved element's `dx` and `dy`. |
| `embeds.list()`, `embeds.probe()` | Each embed's state; each webview's frames, draw calls and canvases (how much is drawn on, in how many colors). |

Keys are written as Vim writes them: characters as they are, and `<Esc>`, `<CR>`, `<Tab>`, `<BS>`, `<Space>`, `<Up>`, `<C-w>` (Ctrl), `<S-Tab>` (Shift), `<M-x>` (Alt), `<D-s>` (⌘), `<Mod-S-p>` (⌘ on a Mac, Ctrl elsewhere) and `<lt>` for a `<`. A `<` that doesn't start a name is a `<`, so `<<` works.

## The probe CLI

`npm run probe -- [setup] [steps]`. The setup applies first, and the steps run in the order given.

- Setup: `--url <app>`, `--scenario <name>`, `--viewport 1200x800`, `--dark`, `--now <time>`, `--permissions allow|deny|ask`, `--net replay|live`, `--offline`, `--allow-errors`.
- Steps: `--open <note>`, `--keys <keys>`, `--type <text>`, `--click <selector>`, `--command <title>`, `--cursor <line[:column]>`, `--wait idle|<ms>|<selector>`, `--dump state|<field>`, `--check overlaps|lineShift|layoutFill|all`, `--probe-embeds`, `--eval <js>`, `--screenshot <file>`, `--reload`, `--set-offline on|off`.

## Browser tests

`npm run test:browser` runs `test/browser/*.browser.ts` against the real Worker and headless Chrome (`CHROME_PATH`, or Chrome where it usually is). Each file starts its own Worker, with levers on unless it says otherwise. CI runs them in two shards.

`browserTest(h, name, options, body)` in `test/browser/harness.ts` runs one test in a fresh browser context. It resets to `scenario` and opens `open` first, and stubs every other site with an empty page unless `internet: "live"`. Any error the page logs fails the test, except a 404 for a file that doesn't exist yet and what `allowErrors` names. A failed test leaves `screenshot.png`, `state.json` (the inspector's state), `errors.txt` and, in CI or with `TRACE=1`, `trace.zip` in `test-results/<test>/`, which CI uploads.

The page objects in `test/browser/pages.ts` cover the editor with Vim, tabs and windows, the settings editor, the Extensions view, permission prompts and embeds. `App.call(name, ...args)` calls the inspector.

`test/browser/visual.browser.ts` compares a few views, in light and dark, with baselines in `test/browser/snapshots/<platform>/`. Linux's are in the repository, for CI. Other machines write their own on a first run. A missing Linux baseline fails in CI, and the picture CI took is in its `test-results` artifact to commit. `UPDATE_SNAPSHOTS=1 npm run test:browser` takes new baselines on purpose.

## Property tests

`test/property/` checks the lists outline edits, the layout model, three-way merge with the history store, and recurrence on generated cases. They're seeded, so every run is the same; `FUZZ_SEED=<n>` tries other cases and `FUZZ_RUNS=<n>` sets how many. A failure names the seed that reproduces it alone, and shrinks a failing sequence of steps to the shortest that still fails.

## Levers are never on in production

The Worker honours levers only when `LEVERS` is `1` and `DEV_USER` is set (`leversOn` in `worker/src/levers.ts`). `npm run dev`, the browser tests and Previews (`previews.vars` in `worker/wrangler.jsonc`) set both; production sets neither. Without them, the app's page has no levers tag, so it never loads the levers' code (`web/src/dev/`), its clock is real and webviews aren't probed. The levers' API answers 404, and the levers' cookie changes nothing. `test/levers.test.ts` checks the configuration, and `test/browser/levers-off.browser.ts` checks a Worker without `LEVERS`.
