# Embeds: a guide for agents

An embed is markdown that an extension draws in place in a note: a timer, background noise, a small app. Each is written one of three ways, which `list_embeds` says for each embed (its `syntax`):

- **Leaf:** one line of its own, with nothing to close. Two colons, the embed's name, and `key=value` arguments in braces (quote values with spaces):

  ```markdown
  ::timer{duration=25m label="Deep work"}
  ```

- **Container:** markdown wrapped in a directive, for embeds whose content is markdown. The content stays real markdown, so its tasks, links and tags keep working. Close it with `:::` on a line of its own; one left open shows as text, with a note saying so.

  ```markdown
  :::kanban
  ## To do
  - Write the outline
  :::
  ```

- **Fence:** a fenced code block, for embeds whose content is code (an `html-app`'s HTML), with the name and arguments on the opening fence:

  ````markdown
  ```html-app height=240 title="A chart"
  <div id="chart"></div>
  ```
  ````

The person sees it drawn, and its markdown when their cursor is on it. Hovering it shows Settings, a form for its arguments that writes them back into the markdown, and Edit markdown. Ask the `list_embeds` tool (MCP) what this workspace has: it lists every embed with its syntax, its arguments, what its body holds, an example, and whether its extension is on. Notes stay plain markdown: anywhere embeds aren't drawn, they read as text and code blocks.

## Rules of thumb

- Copy `list_embeds`'s example and change the arguments. Leave out an argument to get its default.
- Leave an `id=` argument as it is. An embed's state (a running timer, a volume) is kept by its note and its `id`, or by which embed of its kind it is in the note, so moving embeds around can lose it unless they have ids. Give an embed an `id` (short, unique in the note) if the person will move it.
- One embed per line or block. Put a blank line before and after it.
- Embeds don't run anything for you. A timer runs when the person starts it.

## Links

A link alone on its own line is drawn as what it links to: a YouTube video, a post on X or Bluesky, a Spotify track, album or playlist, or, for any other page, a card with its title, description and picture. Put a blank line before and after it. A link in a sentence or a list stays a link.

## Built in

| Embed | Syntax | What it is | Arguments |
|---|---|---|---|
| `timer` | leaf | A countdown that rings and notifies when it's done | `duration` (90s, 25m, 1h30m), `label`, `id` |
| `stopwatch` | leaf | Counts up | `label`, `id` |
| `alarm` | leaf | Rings and notifies at a time of day while Common Ink is open | `at` (07:30), `label`, `id` |
| `noise` | leaf | White, pink or brown noise, made in the browser | `color`, `volume` (0 to 1), `label` |
| `tasks` | leaf | Tasks from across the notes, live, grouped, to tick and change where they are | `folder`, `note`, `tag`, `assignee`, `due` (`<=today`, `tomorrow`, `>=2026-10-01`), `group` (note, due, priority, tag, person), `status` (open, done, all), `limit` |

## From the Catalog

These work once the person installs them from the Catalog at the bottom of the Extensions view. They run sandboxed.

| Embed | Syntax | What it is | Arguments |
|---|---|---|---|
| `pomodoro` | leaf | Rounds of work and breaks | `work`, `break`, `long`, `rounds`, `label`, `id` |
| `kanban` | container | A board drawn from its own markdown: `## Column`, then `- card` lines; dragging a card rewrites them | none; the content is the board |
| `html-app` | fence | An HTML page in a sandboxed frame; the body is its HTML | `height` (pixels, default 360), `title` |

### Writing an html-app

The body is an HTML page: elements, `<style>`, and `<script type="module">`. It runs in a sandboxed frame that can't reach the network, the person's notes or the app, so everything it needs is in the block or among these libraries, which it imports by name:

- `three`, and `three/addons/controls/OrbitControls.js` (three.js r186)
- `uplot` (uPlot 1.6; its stylesheet is already loaded)

It gets the app's colours as CSS variables (`--bg`, `--ink`, `--muted`, `--line`, `--accent`, `--prose`, `--mono`), so it fits in light and dark. Size it with the `height` argument; a canvas that fills the frame can use `height: 100vh`. The person can stop it with Stop and start it again with Run.

````markdown
```html-app height=420 title="Spinning cube"
<style>body { margin: 0; } canvas { display: block; width: 100%; height: 100vh; }</style>
<canvas id="c"></canvas>
<script type="module">
  import * as THREE from "three";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  const canvas = document.getElementById("c");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.1, 100);
  camera.position.set(2, 2, 3);
  new OrbitControls(camera, canvas);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 3));
  const cube = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x2f5fd0 }));
  scene.add(cube);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setAnimationLoop((t) => {
    cube.rotation.y = t / 1000;
    renderer.render(scene, camera);
  });
</script>
```
````

The Preview's "Three.js scene" note is a fuller example.

## Tasks

A task is a checkbox line, `- [ ] Send the invoice`, with todo.txt-style tokens anywhere in it. The line is the source of truth, and the app changes one token at a time in place.

| Token | Means |
|---|---|
| `due:2026-10-01`, `due:2026-10-01T09:30` | When it's due |
| `start:2026-09-28` (or `scheduled:`) | Hidden from open lists until then |
| `done:2026-10-01` | When it was ticked (written when it's ticked) |
| `rec:weekly` | How it repeats: `daily`, `weekly`, `monthly`, `yearly`, `2w`, `mon,thu`, `2w-mon,thu`, `6th`, `last-day`, `1st-tue,3rd-tue`, `last-fri`, `mar-1`, `1st-mon-mar`, `day-50`, `after-1m` (a gap after it's done), or `RRULE:FREQ=…` |
| `until:2027-06-30`, `times:5` | When a repeat ends: its last day, or how many times are left, this one included |
| `!high`, `!low` | Priority |
| `@jane` | A person |
| `#work/clients` | A tag; `/` nests |

Ticking a repeating task doesn't tick it: it moves on to its next date, on the same line (and `times:` counts down). Its last time, it's ticked with `done:`.

```markdown
- [ ] Pay rent due:2026-11-01 rec:1st @sam !high #home/bills
- [ ] Team standup notes due:2026-10-06 rec:1st-tue,3rd-tue until:2027-06-30
- [x] Fix the bike light done:2026-10-02
```

