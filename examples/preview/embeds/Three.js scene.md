# Three.js scene

An interactive scene in a note, written the way an agent would write one: an `html-app` block with a three.js scene. Drag to orbit, scroll to zoom. It's drawn by HTML app, an extension from the Catalog, which this Preview comes with.

```html-app height=420 title="Orbiting shapes"
<style>
  body { margin: 0; padding: 0; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100vh; }
</style>
<canvas id="scene"></canvas>
<script type="module">
  import * as THREE from "three";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";

  const canvas = document.getElementById("scene");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(4, 3, 6);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 2);
  scene.add(sun);

  const shapes = [
    new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 128, 16), new THREE.MeshStandardMaterial({ color: 0x2f5fd0, roughness: 0.3 })),
    new THREE.Mesh(new THREE.IcosahedronGeometry(0.7), new THREE.MeshStandardMaterial({ color: 0xe07a5f, flatShading: true })),
    new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: 0x81b29a })),
  ];
  shapes.forEach((mesh, i) => {
    mesh.position.x = (i - 1) * 2.2;
    scene.add(mesh);
  });
  const grid = new THREE.GridHelper(10, 20, 0x888888, 0xcccccc);
  grid.position.y = -1.2;
  scene.add(grid);

  function resize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);

  renderer.setAnimationLoop((t) => {
    shapes.forEach((mesh, i) => {
      mesh.rotation.x = (t / 1000) * (0.4 + i * 0.2);
      mesh.rotation.y = t / 1500;
    });
    controls.update();
    renderer.render(scene, camera);
  });
</script>
```

Stop (top right of the frame) stops it; Run starts it again.
