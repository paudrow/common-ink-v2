# Embeds tour

An embed is markdown an extension draws in place. Most are one line, a directive with nothing to close: two colons, its name, and key=value arguments in braces. Hover one for Settings, a form that writes its arguments for you, and Edit markdown; or move onto it with j and k (or click its edge) to see and edit the line itself.

## Timers

::timer{duration=25m label="Focus"}

::stopwatch{label="Run"}

::alarm{at=07:30 label="Wake up"}

They keep going when the note closes and when the page reloads, and the status bar shows the one running.

## Background noise

::noise{color=brown volume=0.3}

Press Play: a mini player appears in the corner, and the keyboard's media keys pause and play it.

## From the Catalog

These come from the Catalog, and run sandboxed. This Preview comes with HTML app; the Pomodoro line below offers to install Pomodoro, and draws as soon as it's in, with no reload. An HTML app's body is code, so it's a fenced block: its HTML highlights while you edit it.

::pomodoro{work=25m break=5m label="Writing"}

```html-app height=240 title="Words this week"
<style>body { margin: 0; padding: 0.5rem; }</style>
<div id="chart"></div>
<script type="module">
  import uPlot from "uplot";
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => Date.UTC(2026, 9, d) / 1000);
  const words = [420, 980, 610, 1250, 300, 1720, 860];
  const box = document.getElementById("chart");
  const chart = new uPlot(
    { width: box.clientWidth || 600, height: 200, series: [{}, { label: "Words", stroke: "#2f5fd0", fill: "rgba(47, 95, 208, 0.12)", width: 2 }] },
    [days, words],
    box,
  );
  // As wide as the note, whenever that changes.
  new ResizeObserver(() => box.clientWidth && chart.setSize({ width: box.clientWidth, height: 200 })).observe(box);
</script>
```

See also [[Three.js scene]].
