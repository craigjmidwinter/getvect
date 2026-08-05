---
title: Five screenshots, five instruments
date: "2026-08-05"
time: "13:52:29"
tags:
    - quality
    - instruments
    - preview
hashes:
    - 6d62d49
    - 8f6b340
    - 9a92ba4
    - 70fb172
    - "6204730"
    - c8ac717
    - e817532
    - b2b0498
    - 0318aec
    - 995b029
stat:
    f: 40
    a: 1416
    d: 86
---

![The before: cream ribbons threaded between the eye outline and the iris — a sharpening overshoot the fringe rule classified as a genuine third shade](media/fr-4x-eye.png)

Craig spent an afternoon zooming into the demo and the app and sending
screenshots, and every screenshot became an instrument. That is the whole
pit-crew thesis compressed into one working session: a user's squint is a
hypothesis, and a hypothesis that survives gets a gate.

The cream ribbons around Frankie's eye were the subtle one. The fringe rule
already forbade assigning an in-between pixel a colour from neither side — but
the rim inside the eye outline wasn't in-between: it was a sharpening overshoot
*brighter than both sides*, sitting past the light end of the segment the rule
tested. At eight colours the nearest slot to that rim is muzzle cream, so the
tracer threaded cream between black and olive. The corridor test that replaced
it needed four guard conditions, each earned by breaking something without it.
Fixing the halo also dropped the demo from 278 sub-paths to 158 and 49.5 KB to
31.2 — the ribbons were expensive as well as ugly.

The vector zoom was the embarrassing one: the preview scaled a rasterized
texture, so the app's whole reason to exist — curves that stay crisp — was
invisible in its own UI. Zoom is now layout-driven and the claim is a measured
number: a 1.00-pixel edge band on the vector pane against 4.00 on the raster at
400%, in a spec that provably fails against the old renderer. The checkerboard
that "broke halfway" was one background tiling pushed out of phase by a 1-pixel
divider; each pane now owns its underlay.

The magenta ring around the border was mine — chroma-key residue in the source
that the engine dutifully traced as a pink line. Scrubbing it broke CI, because
the derived-assets staleness gate noticed the source changed and the assets
hadn't. The gate built yesterday caught its own builder today. No better
compliment exists.

```warning
Honest residue, all measured and priced: the nose still spends 1.29x the
source's ink (the ramp bias that fattens it is load-bearing for the claws;
exemplar sits at 1.09), the forehead stripe loses 3% of itself in the fit
stage's smoothing, corners reached 75° against a 112° aspiration, and issue #2
(hue-distinct colours losing slots under Enhance) stays open. Every one has a
gate or an aspiration watching it.
```
