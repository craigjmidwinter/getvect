---
publish: true
title: 'The white outline: right about the worst spot, wrong about the rule'
date: "2026-08-16"
time: "22:43:43"
tags:
    - instruments
    - engine
    - process
hash: "9889541"
stat:
    f: 2
    a: 194
    d: 0
---

Craig, having looked at the artwork rather than the numbers: *"the main culprit
(actually the only one i can find for this issue) is the white outline around
the mascot."*

He is right about the worst spot and wrong about the rule, and the gap between
those two things turns out to be the useful part.

## Testing it properly means an enrichment, not a share

The lazy version of this test counts how many blind-spot slivers touch white. On
a mascot with a thick white sticker border most boundaries have a white side, so
a large share would prove nothing — it would confirm the claim on any artwork
with a lot of white in it. The measurement has to be a **ratio against the base
rate**: the share among defect sites, over the share among all one-pixel
sandwiched runs, which is the population the guards choose from.

I also got the conditioning wrong on the first pass, and it is worth recording
why: I asked whether a sliver's FLANKS were light and got a flat zero everywhere.
Of course I did — the notch sliver *is* the white outline, and a sandwiched run
differs from both its flanks by construction, so a white sliver has non-white
flanks necessarily. The question is about the sliver's own colour.

## The direct measurement, per layer

`staircaseIndex` is computed per sub-path and every sub-path has a fill, so "is
it only on the white outline" can be asked of the staircase itself rather than of
a proxy. On the shipped demo trace:

| layer | boundary | share | worst local | mean/px | enrichment |
| --- | --- | --- | --- | --- | --- |
| white outline | 6602px | 24.4% | **0.3304** | 0.00039 | **0.83x** |
| body orange | 10166px | 37.6% | 0.3219 | 0.00036 | 0.75x |
| pale cream | 1797px | 6.6% | 0.1268 | 0.00194 | **4.08x** |
| pink | 687px | 2.5% | 0.1008 | 0.00157 | **3.29x** |
| olive | 685px | 2.5% | 0.0531 | 0.00048 | 1.02x |
| stripe orange | 4316px | 16.0% | 0.0528 | 0.00037 | 0.78x |
| ink | 2795px | 10.3% | 0.0121 | 0.00006 | 0.12x |

**The single worst site in the drawing is on the white outline** — 0.3304, just
ahead of the body orange at 0.3219. That is his observation, confirmed.

**And white is the fourth-cleanest layer per pixel of boundary**, at 0.83x the
drawing's average. The staircase actually *concentrates* on the pale cream (4.08x)
and the pink (3.29x), two small interior layers. The ink is cleanest of all at
0.12x.

```embed
src: media/layers.html
height: 480
caption: The white outline carries the worst single site and a below-average defect rate. The staircase concentrates on two small interior layers instead.
```

The blind-spot slivers say the same thing more bluntly: on `reference-frankie`,
**0 of 18** have a light colour against a base rate of 34.7 %; on the default
twin, 1 of 19 against 47.0 %. Light-coloured slivers are *depleted*, not enriched.

Across the third-party corpus — which has no sticker outlines at all — enrichment
runs 0.87x, 0.88x, 1.21x, 1.26x. No concentration anywhere.

## Why he can only find it there anyway

White holds a quarter of the drawing's boundary, has a below-average defect rate,
and owns the single worst site. That is the signature of a long clean edge with
one bad spot on it — which is exactly the thing an eye finds. The 4x-enriched
cream and pink layers are small interior features where a one-pixel reversal has
nothing to be conspicuous against.

That is a claim about visibility, and I want to be clear that my instruments do
not measure visibility. It fits the numbers; it is not proven by them.

## The three candidate conclusions, all three

**1. ASSET — confirmed, and broader than stated.** The residue pixels sit 13–35
L1 units from the outline white and 250+ from the body orange. Nearest-colour
quantisation cannot separate them, by construction, on this artwork. But the
property is not "sticker outline": it is *any light region adjacent to a stroke
that fades*, which is why the engraving's paper behaves the same way. "Sticker
art with white borders is a known hard case" is true and under-general; "light
ground beside soft linework" is the actual class.

**2. PALETTE — premise does not match the geometry.** The proposal was a
topological prior against 1px bridges between two larger same-colour regions.
Measured, the structure is not a bridge: the white run at row 510 spans
**x=283..474, 192px long** — the bib's whole bottom edge — attached to a 2-D body
at its left end and one pixel thick at its right tip. It is a **peninsula**, and a
bridge prior would never fire on it.

A prior against peninsulas would fire, and it is `trimSlivers` under a new name,
with the same bill: breaking that tip means assigning a pixel **13 L1 units from
white to a colour 250+ L1 away**, a 19-fold colour error bought purely with
shape. Moving it to assignment time does not change the price.

**3. NULL — partially right, and the part that is right is the general one.** His
observation does not generalise: no corpus fixture shows light-flanked or
light-coloured enrichment above base rate. What survives is narrower and still
true — on *this* artwork, the worst single site is his white outline.

```note
No engine change follows from this. The measurement redirects effort rather than
producing a fix: if anyone works the staircase again, the pale cream and pink
layers carry 3-4x the defect rate of the white outline and nobody has ever looked
at them.
```

```warning
Window. One trace per fixture at declared settings; the per-layer table is the
shipped demo asset only, and layers under 24px of boundary are excluded. The
enrichment base rate is "all 1px-thick sandwiched runs", which is the population
the two mask guards select from — a different denominator would give different
ratios. The visibility explanation is unmeasured. And the per-layer numbers come
from OUR artwork, which under the standing rule reports and does not decide;
the corpus half of this is the third-party enrichment, which is flat.
```

```embed
src: media/layers.html
height: 480
caption: The white outline carries the worst single site and a below-average defect rate. The staircase concentrates on two small interior layers instead.
```
