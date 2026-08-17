---
title: 'Verifying a parallel lap: three findings confirmed, one refuted'
date: "2026-08-16"
time: "22:31:01"
tags:
    - engine
    - fitting
    - instruments
hashes:
    - 4d4f470
    - "7707e74"
stat:
    f: 7
    a: 427
    d: 28
---

A second agent ran the fitter lap in parallel, from the same base commit, in a
worktree. It reached the same defect I did, with a better instrument and a
tighter bound. My job was to try to break it.

## What survived

**Its finding 1, the notch is innocent.** Confirmed by a different method: it
measured the fitted curve against the exact ring the fitter was handed and got
1.07px; I measured against the deduped input polyline and got 1.10px. The input
genuinely contains a J-hook — the chin diagonal plus the 1px tongue, with the tip
the only detected corner, so one segment spans both. Chord deviation of a J-hook
measures the hook. **The 5.93px number I reported two laps ago was a mis-measure
of mask geometry**, and it corroborates the deAntialias lap from the opposite
direction: the notch is mask, not fitter, and has no fitter fix.

**Its finding 2, the defect.** Baseline reproduced exactly — 367 balloons, photo
300 / lineart 33 / poster 29 / lowres 4 / mascot 1, every one gone after. Its
diagnosis is sharper than mine was: not just the missing upper guard, but
`computeMaxError` evaluating only at the data points' own parameters, so a
three-point run is judged at exactly one point, the curve passes through it, and
a fit that swings 400px away is accepted at **error 0.000**. That is why the
thing survived every existing check.

**Its finding 3, which corrects my own records.** It claims the pre-fix balloons
inflated the drawing's bounding box so that almost no layer cleared
`layerCompactness`'s 1 % coverage bar. Verified directly: unfixed, the engraving
counts **1 layer of 8** and reports 1.133; fixed, it counts **8 of 8** and
reports 13.708. So the 1.13 baseline I quoted was one layer's number, and the
"1.13 → 18.9 compactness regression" I cited when killing my own 2-D-support fix
was measuring an artifact.

That fix stays dead — `strictInkRecall` 0.815 → 0.691 and the wordmark corner
65.6° → 20.4° killed it independently and both are real — but I got there partly
on a number that was not.

## What did not survive

Its safety argument. It states the sharpest legitimate fits in the corpus use
**0.74 chords**, giving `MAX_ALPHA_RATIO = 3` about 4× headroom. That figure is
the mascot's chin J-hook, not the corpus maximum. Measured from emitted geometry,
independently of the fitter:

| fixture | max handle / chord |
| --- | --- |
| arcs (analytic) | 0.427 |
| spikes | 0.733 |
| mascot | 0.942 |
| engraving hatching | **1.368** |
| poster letterforms | **1.821** |

Real headroom is **1.65×**, not 4×. The bound is still safe on this corpus — zero
balloons, corners unmoved, strict ink up — but it sits closer to genuine tight
curls than its own comment claimed, and artwork curlier than the poster is the
case that would find it. The comment now says that.

## Whose bound ships

Mine bounded handles by the segment's **arc length**; its bounds them by **3× the
chord**. On the whole corpus the two are behaviourally identical — same zero
balloons, same invented/omitted figures to the decimal.

Its bound wins anyway, for a reason the corpus cannot show: arc length is loosest
exactly where the system is near-singular, because a near-closed loop has a
vanishing chord and a large arc. A 15px handle on a 1.6px chord is a balloon that
its bound catches and mine would permit. Tighter wins where the defect lives.

## The demo, both halves, plainly

**The notch is unchanged.** Its cubic is byte-identical between the shipped asset
and a fresh trace — `c -2.56 4.81 -19.69 7.58 -9.03 15.97`. Mask geometry, still
open, no fitter fix.

**The balloons are gone, and one of them was visible.** The shipped
`site/assets/frankie-vector.svg` carries
`c 109.96 464.07 -116.57 -495.31 0.77 1.22` verbatim — a 2×7px sliver at
(173..175, 186..193) with ~477px handles. At 24× it draws a great orange X across
an area of the mascot that should be blank. A fresh trace draws the sliver and
nothing else.

```compare
before: media/sliver-before.png
after: media/sliver-after.png
caption: The shipped demo asset at 24x, and the same region re-traced: a 2x7px sliver with 477px handles drew an orange X across blank canvas. The fix leaves the sliver and removes the X.
```


```note
The shipped demo asset still contains that X. Regenerating it is one command
(`npm run assets`) and I have not run it: it rewrites the marketing images, which
is Craig's call rather than a side effect of an engine lap.
```

```warning
Window. Its instrument rerun by me from its branch at three engine states
(unfixed, its bound, my bound), one trace per fixture at declared settings plus
the demo-settings row. The handle-ratio table is measured from emitted SVG across
five fixtures chosen as the curliest available, not the whole corpus. "Its bound
is tighter where it matters" is an argument from the formulas plus one
constructed example, NOT an observation — on this corpus the two are
indistinguishable, and if a case exists where they differ in practice I did not
find it.
```
