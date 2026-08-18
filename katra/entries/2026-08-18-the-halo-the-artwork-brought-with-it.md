---
title: The halo the artwork brought with it
date: "2026-08-18"
time: "16:08:55"
tags:
    - engine
    - corpus
hashes:
    - ac077db
    - f001295
stat:
    f: 17
    a: 610
    d: 12
---

Craig, on the compare view he'd just been shown: *"the one thing that could be
improved are these tiny little slivers that show up. could be the result of how
we handle alpha maybe?"*

He was right about the alpha, and not in the way either of us expected.

The slivers are real and they are all in one place. Every thin shape in the
mascot's trace — 17 of them, all under 2.5px wide — belongs to a single palette
slot, `rgb(244,183,122)`, a tan. That layer is 94% slivers: 17 of its 18 shapes.
No other layer has one. And **17 of 17 sit on the sticker's alpha edge**, each
sandwiched between the white outline and transparency, with the white outline as
its only opaque neighbour.

## What is actually there

The artwork has a faint pink halo hugging the outside of the white border —
`rgb(254,189,181)`, **chroma spread 73**. That number matters: a white-to-black
anti-aliasing ramp is grey, spread 0. This is tinted. It is the trace of whatever
the PNG was composited against when it was drawn, and it is nearest, in RGB, to
the tan slot (60 away) rather than to white (94). So the quantizer assigns it
tan, correctly by its own rules, and a one-pixel band hugging the outline traces
as a hairline ribbon.

So alpha is *where* it happens, not *what* does it. The defect is palette
allocation on a chromatic fringe that only exists along the alpha edge.

`majorityFilter` is the pass that exists to clear halos, and it structurally
cannot clear this one. Its own comment says why, without knowing it: see-through
neighbours cast no vote, deliberately, so that a one-pixel antenna sticking into
the transparent field is not filtered away. The consequence is that an interior
halo gets outvoted from **both** sides while an edge halo is opposed from one —
and survives on the tie. `continuesRun` then protects the band as a thin stroke,
because along the edge that is exactly what it looks like. Two guards, each
correct alone, with a gap between them.

![The same shoe on the corpus figure, traced three ways at 6x: no fix, the shipped 2px reach, and the adaptive reach. The dark hairline along the lower silhouette is the defect. The adaptive panel on the right is the cleanest — and it is the one that got rejected.](media/ship-cmp.png)

## The fix, and the thing it must not do

`snapAlphaFringe` runs before the region filters, and its rule is deliberately
narrow: a fringe pixel keeps any colour that also exists deeper inside the
silhouette, and is reassigned only when its colour appears **nowhere** behind it.
A feature that genuinely runs to the edge keeps its own index.

It is a no-op without an alpha channel, which is not a convenience — it is the
protection. The corpus holds a 19th-century engraving that is almost entirely
one-pixel cross-hatching, and any filter that judges thin runs is a threat to it.
Its trace is **byte-identical** before and after, `3996f9d9…`. Measured, not
argued from the code path.

On the mascot: 17 alpha-edge slivers to **0**, subpaths 59 to 42, 19,947 bytes to
17,844. The shapes that left are the slivers; the drawing is unchanged.

## Four measurements, three of which were wrong

This is the part worth keeping.

**The corpus had no fixture that could fire.** All four third-party images were
opaque JPEGs — nothing without an alpha channel can exercise an alpha-edge
fringe. So the first work was sourcing one: a CC0 figure, licence read before the
bytes, chosen out of four candidates because it actually shows the defect (42
alpha-edge slivers; another candidate showed zero).

**The first metric counted pixels and could not reach zero.** It scored the
fraction of silhouette-band pixels differing from the material behind them. The
mascot, with every visible sliver gone, still scored 20.35% — so the 5% bar
written against it was unreachable by construction. It also disagreed with the
eye: a change that halved the ratio made the visible hairlines more numerous.

**The second metric counted things nobody can see.** Measuring per-layer
geometry, it included the parts of each layer hidden under the layers painted on
top. It ranked the fixed reach three times better than the adaptive one. Both
raster measures ranked them the other way, and so did the picture above.
Occluded geometry is not a defect; it is not anything.

**And then the adaptive reach — better by eye and by both surviving metrics — ate
seven per cent of an ink outline.** `local-snorlax` failed `inkRecall` at 0.9248
against a floor of 0.9900. On soft edges the partial-alpha band is genuine
feathering as much as contamination: seeding from it classifies 13.5% of the
artwork as fringe against 7.6%, so real features fall inside and get reassigned
to their neighbours.

```note
The fixture that caught it is not the one the change was designed against. A
change that improves the image you are staring at and quietly destroys a
different one is the exact failure the provenance rule exists to catch — and this
time it caught one. That is the corpus paying for itself.
```

## What shipped, and what did not

The fixed 2px reach. Mascot at zero, engraving untouched, 22 instrument gates
green, suite green. Live, and production serves a trace with no slivers in it.

The bar it does **not** meet stays on screen: `alphaFringeSlivers 30 > 0` on the
third-party figure. Zero is the aim because zero is what the defect's absence
looks like, not a ratchet to whatever today's code scores. What closes that gap
is not more reach — reach is the thing that ate the ink — but telling
contamination from feathering, which nothing here can do yet.

Also this lap, and overdue: **the ear-tip canary is code now.** "Sharp corners
must stay sharp; Frankie's ear tip is where to look" had been a sentence in a
plan file, cited across several laps as though it were a check that runs. It was
not. Writing it down found the phrase wrong twice over — the left ear is not a
corner at all (175° over 4px, 135° over 40px, a curve whose angle is just a
function of how far you look), and asking for "the sharpest corner near the ear"
returned 19°: the pointed end of a sliver, a defect wearing the costume of the
feature. The real anchor is the notch where the right ear meets the head, 83° and
the same 83° at every scale from 4px to 40px. Three assertions, and it fails on
the pre-fix engine with `a 2.4deg spike appeared at (551,103)`.

```warning
The soft-edge case is open, and the honest summary is that we can see the
hairlines and cannot yet separate them from feathering without damage. The next
person to try widening the reach should read the ink-recall number first.
```

![The mascot's ear at 6x — source on the left, the shipped trace on the right. The tan hairlines that used to ride the white border are gone; the ear itself is untouched.](media/ship-ear.png)
