---
publish: true
title: Two laps, two bounds, and the distribution that settled it
date: "2026-08-16"
time: "22:38:32"
tags:
    - engine
    - fitting
    - instruments
hashes:
    - 06a13dc
    - 885c883
stat:
    f: 3
    a: 202
    d: 25
---

Two agents took the same defect from the same base commit, blind to each other.
Both found `generateBezier` guarded below and not above; both indicted the
least-squares blowup on short and near-closed runs; both exonerated the notch
cubic; both found the `layerCompactness` bbox artifact. That convergence is
better verification than either lap could have produced alone.

They proposed different bounds, and reconciling them turned out to be the
interesting part.

## The number that started it was wrong

I reported that the notch's control point sat "10.7px outside its own endpoint
span". It does not. I measured that in **x**, on a chord that runs diagonally;
projected onto its own chord both control points land inside [0,1] and the
longitudinal overshoot is **0.00px**.

The parallel lap independently reached the same conclusion from the other side:
the input ring genuinely contains a J-hook, so the 5.93px chord deviation is the
hook's depth, not the fitter's contribution. Its number for how far the fitted
curve sits from the mask is 1.07px; mine, by a different method, 1.10px.

So the figure that launched both laps was a mis-measure — **and it pointed two
instruments at the right organ anyway.** The defect underneath was real, neither
of us would have gone looking without it, and that is the honest shape of the
story.

## The two bounds, and where they disagree

| | rule | verified |
| --- | --- | --- |
| mine | handle ≤ the run's **arc length** | max fit error 4875 → 2.21px, 0 of 26 corners moved |
| theirs | handle ≤ **3× the chord** | balloons 300/33/29/4 → 0, same canaries clean |

Over **262,865** fitted runs the two disagree **950** times, and each is wrong
exactly where the other is right:

- **A chord-relative cap is undefined on a closed contour.** Six runs in the
  corpus have a chord of exactly **0.0000px** against arcs of 166–210px. Three
  times zero is zero, so every handle trips the guard and the fallback returns
  0/3 = 0 — a degenerate cubic.
- **An arc-relative cap of 1.0 sits exactly on the legitimate p99** and rejects
  900 honest fits, most of them tight curls on short runs.

Both failures are absorbed downstream by the error-then-split recursion — on
`shapes-256-bmp` the degenerate case costs one extra cubic and seven bytes — so
neither is visible in the output. They are formulation defects, not output
defects, which is exactly the kind of thing that survives a corpus.

## The distribution decides the ratio

```embed
src: media/dist.html
height: 480
caption: 488,030 handles. Legitimate fits stop below 1x the arc; blow-ups start at 33x. Both original proposals sat on an edge of that gap; the bound belongs in it.
```

Over 488,030 handles, handle ÷ arc runs **p50 0.384, p99 0.893** — and then jumps
to **33.5** at p99.9. Legitimate fits and blow-ups are cleanly bimodal with an
order of magnitude of empty space between them, so the constant only has to land
in the gap rather than be tuned to anything.

**2 × arc length**: 2.2× headroom above the honest p99, 16× below the blow-up
floor, and well-defined when the chord vanishes.

## Said plainly: on this corpus all three are equivalent

Balloons 367 → 0 under each. `invented` and `omitted` identical to the decimal on
every fixture, including the analytic `arcs` zero-state at 0.73 / 1.03. The
composite is chosen on formulation and on the distribution, **not** because it
measures differently here. If someone re-runs this and finds the three
indistinguishable, that is the expected result, not a refutation.

## What each lap corrected in the other's records

Its correction to mine: the pre-fix balloons inflated the drawing's bounding box
until almost no layer cleared `layerCompactness`'s 1 % coverage bar. Verified —
unfixed, the engraving counts **1 layer of 8** at compactness 1.133; fixed, **8
of 8** at 13.708. The "1.13 → 18.9 regression" I cited when killing my own
2-D-support fix was measuring one layer against eight. That fix stays dead on
`strictInkRecall` 0.815 → 0.691 and the wordmark corner 65.6° → 20.4°, which were
real and independent — but I reached the verdict partly on a number that was not.

My correction to its: its safety argument states the sharpest legitimate corpus
fit uses 0.74 chords, giving 3× about 4× of headroom. That is the mascot's chin,
not the corpus maximum — the engraving's hatching reaches 1.37 and the poster's
letterforms 1.82, so the real headroom was 1.65×.

Both gates ship, because they measure different things and neither is expensive:
`canvasOverflow` (a fact about the input, fails the build at 4034px on the
unfixed engine) and the balloon count (curve leaving its input ring by >3px).

```warning
Window. 262,865 fitted runs and 488,030 handles, across 21 fixtures at declared
settings, one trace each — the disagreement count and the distribution are from
that population and nothing wider. "Each bound is wrong where the other is right"
rests on six closed-contour runs and 900 rejected fits in this corpus; the claim
that 2x arc is the better FORMULATION is an argument about inputs the corpus does
not contain, and it is not something these measurements can prove.
```
