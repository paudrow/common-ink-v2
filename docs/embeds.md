# Embeds: a guide for agents

An embed is a fenced code block that an extension draws in place in a note: a timer, background noise, a small app. Write the language on the opening fence, then `key=value` arguments (quote values with spaces), and the body inside if the embed takes one:

````markdown
```timer duration=25m label="Deep work"
```
````

The person sees it drawn, and its markdown when their cursor is in it. Ask the `list_embeds` tool (MCP) what this workspace has: it lists every embed with its arguments, what its body holds, an example, and whether its extension is on. Notes stay plain markdown: anywhere embeds aren't drawn, they're code blocks.

## Rules of thumb

- Copy `list_embeds`'s example and change the arguments. Leave out an argument to get its default.
- Leave an `id=` argument as it is. An embed's state (a running timer, a volume) is kept by its note and its `id`, or by which block of its kind it is in the note, so moving blocks around can lose it unless they have ids. Give an embed an `id` (short, unique in the note) if the person will move it.
- One embed per block. Put a blank line before and after it.
- Embeds don't run anything for you. A timer runs when the person starts it.

## Links

A link alone on its own line is drawn as what it links to: a YouTube video, a post on X or Bluesky, a Spotify track, album or playlist, or, for any other page, a card with its title, description and picture. Put a blank line before and after it. A link in a sentence or a list stays a link.

## Built in

| Embed | What it is | Arguments |
|---|---|---|
| `timer` | A countdown that rings and notifies when it's done | `duration` (90s, 25m, 1h30m), `label`, `id` |
| `stopwatch` | Counts up | `label`, `id` |
| `alarm` | Rings and notifies at a time of day while Common Ink is open | `at` (07:30), `label`, `id` |
| `noise` | White, pink or brown noise, made in the browser | `color`, `volume` (0 to 1), `label` |

## From the Catalog

These work once the person installs them from the Catalog at the bottom of the Extensions view. They run sandboxed.

| Embed | What it is | Arguments |
|---|---|---|
| `pomodoro` | Rounds of work and breaks | `work`, `break`, `long`, `rounds`, `label`, `id` |
| `tasks` | Open todos from across the notes, live, to check off where they are | `folder`, `note`, `q`, `due` (overdue, today, week, any), `done`, `limit` |
| `kanban` | A board drawn from the block's own markdown: `## Column`, then `- card` lines; dragging a card rewrites them | none; the body is the board |
| `html-app` | An HTML page in a sandboxed frame; the body is its HTML | `height` (pixels, default 360), `title` |

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
