---
publish: true
title: The corner that was never recovering
date: "2026-08-16"
time: "18:26:18"
tags:
    - engine
    - preprocess
    - instruments
hash: c8ae6e6
stat:
    f: 8
    a: 186
    d: 3
---

Last lap ended with one regression `trimSlivers` could not explain: the local
artwork's muzzle crop lost 23° off its bluntest corner. I wrote then that the
face crop next to it had moved the same way but *gained* a feature and got
sharper on average, so that one was recovery rather than damage.

That reading was wrong, and it was wrong in an instructive way. It came from a
mean, and the mean rose **because** the filter had manufactured a degenerate
contour that scores 178°.

## What the aggregates were hiding

`featureCornerAngles` reports three numbers — count, min, mean — and counts
*contours*, not corners. Those three cannot separate "a corner got blunter" from
"a new, blunter contour appeared and took the minimum". So the first thing this
lap needed was not a fix but a finer instrument: the same walk, same sample step
and span, but keeping every contour's box so the two runs can be matched up and
the mover named.

Matched that way, the face crop reads:

| contour | before | after | |
|---|---|---|---|
| `[567,310..575,323]` cream | 98.73° | 98.73° | unchanged |
| `[347,234..350,243]` white | 113.00° | 113.00° | unchanged |
| `[451,310..460,320]` white | 97.14° | **73.63°** | blunter, apex moved |
| `[442,266..446,268]` grey | 126.03° | **115.28°** | blunter, extent 4→7px |
| `[452,266..461,268]` grey | — | **178.03°** | **NEW**, 10×2px |

There is no recovery anywhere in that table. The "gained feature" is a
ten-by-two-pixel needle, and a needle is all corner, so it scored 178° and
dragged the mean up 7° while every real contour in the crop got worse or stayed
put. Face and muzzle were never different; I had been reading a mean that a
degenerate shape was holding up.

```compare
before: media/needle-notrim.png
after: media/needle-trim.png
caption: The "recovered feature", at 24x — one clean 5x3px grey detail shattered into four fragments plus the needle contour that scored 178 degrees and held the mean up.
```

## A statistic I had to throw away

Looking for the mechanism I counted, across the whole image, how often the filter
moved a pixel from index A to index B *and* somewhere moved one from B to A. It
came out at 94% of edits on the 16-colour artwork against 21% on the 7-colour
mascot, which looked like a beautiful result: the filter churns, and it churns
worse as the palette gets denser.

It is not a result. It is the wrong window. Two edits at opposite ends of a
picture resolving the same colour pair in opposite directions is not a
contradiction — it is two different seams, correctly resolved. Measured where it
actually means something, inside a single connected site, the contradiction rate
is **3.5% on the local artwork and 0.0% on the mascot**. The filter was not
churning. I had drawn a boundary around the whole image and reported it as if it
were a boundary around a defect.

## The mechanism, once measured at the right scale

The five edits that wrecked the eye highlight are five *separate* one-pixel
changes scattered inside a 10×10px feature, each involving a different pair of
palette slots. That is the whole story: a small feature built out of one- and
two-pixel runs of several colours is a picture in which nearly every run is
"sandwiched", so the predicate fires everywhere inside it and the filter stops
trimming residue off a boundary and starts **rewriting the feature**.

```compare
before: media/muzzle-notrim.png
after: media/muzzle-trim.png
caption: The muzzle corner itself, at 24x — five scattered one-pixel edits inside a 10x10px eye highlight change which palette slot it belongs to and round off its bottom point.
```

So the fault is not the sandwich test and not a tolerance. It is that
`trimSlivers` had no notion of scale at all — no way to ask whether the run it is
judging is the *edge of a region* or the *whole of a small one*.

`regularizeBoundaries` has been asking exactly that question since the day it was
written, in `smallRegionMask`: a shape smaller than the vote window cannot be
judged by the vote. The argument applies with more force to a filter that judges
runs one pixel thick, and it was simply missing. Adding it is three lines and the
same constant (7×7 window × 4), not a new heuristic.

The mascot's white finger is the edge of a bib thousands of pixels in area. The
eye highlight is a whole shape of about a hundred. That difference is what the
guard reads, and it is the difference that was there all along.

## What it costs and what it buys

The guard makes the filter far more conservative — on the mascot at default
settings, 703 edits become **32**. Three of those 32 are the notch this whole
thread started with, and it is still fixed: `(472,510)`, `(473,510)`, `(474,510)`
still go from white to orange.

Measured across **every one of the 25 corner-reporting regions in the corpus**
(17 fixtures at their declared settings; the two `unsupported-*` rows are skipped
and carry no geometry), three moved:

- `local-artwork-default` / paw-pad **+12.28°** sharper, feature count unchanged
- `reference-frankie` / forehead-stripes −0.80°
- `reference-frankie` / cheek-stripes −1.54°

The 23° blunting, the palette-slot swap and the needle are all gone; the local
artwork's face and muzzle crops are now byte-for-byte untouched by the filter.

What remains is honest and small. Of the 32 edits on the mascot exactly **one**
lands near a stripe tip — `(191,372)`, which takes the last pixel off a tapering
cheek stripe and costs that contour 5.13°. That is the same class of error, at a
scale the region test cannot see, and I am leaving it measured rather than
tuning it away: a tapering tip's last pixel and a residue finger's last pixel
have the same local description, which is precisely why this filter exists and
precisely why it cannot be made perfect from local evidence alone.

The price is paid in wins, not just in safety. The staircase metric across the
corpus, trim off → on, was 6 better / 1 worse on `sustained` when the filter was
unguarded; it is now **4 better / 1 worse**. Two of last lap's sustained
improvements were the filter reaching into small features, and they were never
ours to keep.

```note
The `reference-frankie-default` local number still moves the wrong way
(0.3304 → 0.4919) and it is NOT damage — I rendered the site responsible. The
trim removes a long thin black wedge and leaves a shorter, sharper notch, so the
picture improves while the number worsens. `Local` is the worst SINGLE window,
and a short sharp notch concentrates into one window what a long wedge spread
over many. This is the reason that number is an aspiration and not a gate, and
promoting it to a gate would ratchet the aggregator rather than the quality.
```

```warning
Window, stated: everything above is 17 fixtures at their declared settings, one
trace each, plus the pixel-level dumps on two of them. The corner canary covers
25 regions — every region in the corpus that reports a corner at all. It does
NOT cover artwork outside the corpus, and the artwork that exposed this bug was
local, unredistributable, and only in the corpus because someone had added it.
A denser or more detailed drawing than anything measured here could still have
small features this filter reaches into; the region test bounds the damage by
area, not by how many such features a picture contains.
```
