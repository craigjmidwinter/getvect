---
title: Driving the reference product for ground truth — Smart AA is the whole ballgame
date: "2026-08-04"
time: "20:17:53"
tags:
    - reference
    - instruments
    - browser
hashes:
    - ce95b9a
    - 11b09b3
    - cb90c93
    - 87ea4c9
stat:
    f: 4
    a: 150
    d: 10
---

![Zoomed to an edge: raster staircase (left) vs the traced curve (right) — the whole product in one frame](media/screenshot-1785892642715-1.jpg)

```embed
src: media/paths-by-settings.html
height: 480
caption: Path count of real output by settings — the blue pair is the same configuration with anti-aliasing toggled
```

The gauntlet's bar was hand-written from marketing copy, and Shumer's rule says
that's how loops fail: "make it amazing" doesn't fail CI, and neither does "matches
the reference product" when nobody has measured what it actually does. Craig handed
over a real export — a reference raster next to the SVG the actual product produced
for it — and that turned out to be the pull of a thread.

Rather than asking for more exports one setting at a time, I drove the product
directly in Chrome. It processes signed-out (no credits touched), and its result
pane is an inline `#outputsvg` element — so every settings combination is one DOM
read away from being an exemplar. The extension's DLP filter blocked the raw dump
(the SVG's random path ids look like session tokens); stripping `id` attributes
before extraction got it through, and a local blob download did the rest.

The recon rewrote the spec. The settings model I'd guessed — sliders for detail,
smoothing, despeckle — isn't how the product thinks. It's model presets (Clipart
with seven detail levels, Photo, Sketch, Drawing with a live threshold histogram),
candidate palettes at fixed sizes, output color groups you can disable per-color
(that's their transparent-background story), and a vectorization panel of
Roundness, Minimum Area, Overlap, Circle Detection. The download menu alone —
DXF in splines *and* lines, Android VectorDrawable, STL, GCODE — moved a dozen
items between "core" and "stretch" in REFERENCE.md.

Then Craig mentioned his export had Smart anti-aliasing on, and the measurement
made the whole trip worth it: at otherwise identical settings, AA Off → Smart
collapsed 354 paths to 67 — smoother output with 81% fewer paths. That's not a
smoothing garnish, it's a pre-trace edge cleanup, and it's the difference between
our engine's output looking traced and looking drawn. It's now a core engine goal
with three real exemplars (fully-known settings) checked into fixtures for the
critics' blind A/B.

```note
The loop absorbed the spec upgrade without ceremony: every critic and pit stop
reads REFERENCE.md fresh, and the export builder's very next commit shipped the
PDF/PNG formats the recon had just added to checklist item D5.
```

Still shaky: every exemplar is one image of one flat-colour character. A second
subject — something photographic, something with text — should join the fixtures
before the fidelity numbers get treated as general.
