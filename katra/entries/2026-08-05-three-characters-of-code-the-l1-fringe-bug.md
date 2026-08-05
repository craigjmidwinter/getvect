---
title: 'Three characters of code: the L1 fringe bug'
date: "2026-08-05"
time: "16:04:51"
tags:
    - engine
    - forensics
    - palette
hashes:
    - 14ad9b3
    - 498cb3d
    - af50c9f
    - cc0d96a
    - bb22253
stat:
    f: 28
    a: 754
    d: 93
---

![Mid-round state for the record: white muzzle landed, nose folded to body orange — the regression that forced issue #2 from backlog to now](media/new-face.png)

The brief for this round was wrong twice, and the agent proved it both times by
measurement before writing a line of fix. The cheek stripes were not being
starved in the curve-fitting stage — at smoothing zero they still vanished. And
issue #2 was not a palette-selection failure — the quantizer *found* the nose
salmon and the eye cyan every time. Two different mechanisms were eating them
downstream, and both trace to the same three characters of code: a distance test
computed in L1.

The fringe collapse asked whether a thin band's colour lies between its two
neighbours using `da + db <= span * 1.35` — in L1, which is additive along any
monotone path through the colour cube. With black and white as neighbours that
test admits *every colour in the cube*. With one neighbour black — that is, next
to any outline — it admits every darker shade of the other side. Every drawing
with an outline, which is every drawing this product exists for, could have
whole features classified as "just a blend" and deleted at the index stage. The
fox's cyan eyes: 1,071 pixels in, 7 out, before palette selection ever ran.

The other mechanism was subtler: Lloyd refinement dragged a correctly-found
salmon centre 29 units toward body orange, parking it 54 units from its
neighbour — just inside the halo fold's 55.4 window. The fold then spent the
slot. The fix pins what the clustering already found: a hue-outlier reservation
with five guards, each bounded by a fixture that broke without it.

Numbers after: cheek stripes 52% → 96%. The nose has its own salmon layer. And
the fox's cyan eyes — 0% before, and 0% in the *real product's own output* —
come back at 93%. On the defect class we discovered by measuring ourselves
against the reference product, we now beat the reference product.

```note
Two small honesty rituals from the round worth keeping: the demo dropped to
19 KB, which made our old line "their export is smaller than ours" false in our
favour — the copy now reads "fewer shapes than ours, in more bytes". And the
nose gates were re-baselined with proof that the shift came from the art change
(same build, pre-scrub source, numbers reproduced), not from the engine.
```

Craig also asked the right uncomfortable question today: are these gates
representative of the application, or are we tuning an engine that renders one
cat well? Honest answer, recorded here as the next round's charter: the
mechanisms generalize, the measurement population doesn't — two stickers and
some synthetics, no typography, no photographs, thresholds calibrated to the
mascot. The corpus sweep, a typography fixture, and a parameterized
tapered-stripe synthetic are the answer, and the L1 bug is the proof they're
needed: it survived nineteen instrument fixtures because all nineteen were
drawn from the same narrow family.
