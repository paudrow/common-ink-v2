# Embeds tour

An embed is a fenced code block an extension draws in place: its language first, then key=value arguments. Put the cursor in one (click its edge, or move onto it with j and k) to see and edit its markdown.

## Timers

```timer duration=25m label="Focus"
```

```stopwatch label="Run"
```

```alarm at=07:30 label="Wake up"
```

They keep going when the note closes and when the page reloads, and the status bar shows the one running.

## Background noise

```noise color=brown volume=0.3
```

Press Play: a mini player appears in the corner, and the keyboard's media keys pause and play it.

## From the Catalog

Install Pomodoro and HTML app from the Catalog at the bottom of the Extensions view, then reload. They run sandboxed.

```pomodoro work=25m break=5m label="Writing"
```

```html-app height=240 title="Words this week"
<style>body { margin: 0; padding: 0.5rem; }</style>
<div id="chart"></div>
<script type="module">
  import uPlot from "uplot";
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => Date.UTC(2026, 9, d) / 1000);
  const words = [420, 980, 610, 1250, 300, 1720, 860];
  new uPlot(
    { width: document.body.clientWidth - 16, height: 200, series: [{}, { label: "Words", stroke: "#2f5fd0", fill: "rgba(47, 95, 208, 0.12)", width: 2 }] },
    [days, words],
    document.getElementById("chart"),
  );
</script>
```

See also [[Three.js scene]].
