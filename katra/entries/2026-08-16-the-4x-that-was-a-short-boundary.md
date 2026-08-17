---
title: The 4x that was a short boundary
date: "2026-08-16"
time: "22:52:04"
tags:
    - instruments
    - process
hash: 2499f39
stat:
    f: 3
    a: 95
    d: 1
---

I sent this lap after my own number: the pale cream layer at 4.08x the drawing's
boundary defect rate, "the largest unexplained number left in the project". It
was a look-first lap, and looking dissolved it.

## Two confounds, both mostly innocent

**Size.** Reversal per unit length is structurally larger on small contours, and
cream is made of them — median 35px against the ink's 2794px. On the demo asset
alone the rate looked like it collapsed entirely onto length (a 65x spread across
size bands), but that was 54 contours of noise; measured against a 5,029-contour
corpus baseline the size effect is only 2.3x end to end. Size-adjusted, cream is
still **3.69x**. Confound checked, mostly refuted.

**Thinness.** A long thin lozenge turns 180 degrees at each end, so I expected
elongation to explain it. It does not: pink is nearly round (isoperimetric ratio
1.36) and hot, while the body orange is thinner (3.23) and cold. Refuted.

## The instrument is not lying either

Worth ruling out before blaming the artwork: does the metric manufacture reversal
on small shapes, where its 8px window spans a third of the contour? Measured on
mathematically perfect ellipses down to an 18px perimeter — shapes containing no
reversal at all by construction:

```
   60 x 20    267px    0.00000
   10 x 3      44px    0.00000
    4 x 1.5    18px    0.00000
```

Exactly zero, every time. The reversal on those cream contours is real.

## And then the number that mattered

Seventy percent of the cream layer's score comes from **three contours totalling
95px**, out of the layer's 1797px and the drawing's ~27,000px. So I finally asked
the question I should have asked before spending a lap: what is the ABSOLUTE
staircase per layer, not the rate?

| layer | boundary | rate/px | **absolute** | worst site |
| --- | --- | --- | --- | --- |
| body orange | 10166px | 0.00036 | **3.66** | 0.3219 |
| pale cream | 1797px | 0.00193 | **3.47** | 0.1268 |
| white outline | 6602px | 0.00039 | **2.57** | 0.3304 |
| ink | 2795px | 0.00006 | 0.17 | 0.0121 |

The 4.08x is a rate over a short boundary. In absolute terms the cream layer
carries **slightly less** staircase than the body orange, and its worst single
site is **a third** of the white outline's. There is no unexplained 4x. There is
a small denominator.

## What the cream contours actually are

![The cream layer's worst contour at 40x: a 2px-wide sliver, 23px around, with a gentle S-bend. Real reversal, about a pixel of it, invisible at 1:1.](media/cream-zoom.png)

Having looked: a 2px-wide sliver, 23px around, traced as seven cubics of 1.4 to
7.5px each, with a gentle S-bend on one edge and a slight kink where it narrows.
The reversal is genuine and it is roughly one pixel, on a feature two pixels
wide, invisible at 1:1.

No new mechanism. Nothing here that the three earlier noes did not already cover,
and by the scope rule for this lap that means stop at the diagnosis rather than
build a fourth fix.

## The correction is to me

I produced "4.08x" last lap by aggregating a per-pixel metric by colour layer and
reporting the ratio without its absolute. That is the same error class as the
compactness baseline the parallel agent caught in my records, and as the "10.7px
outside the endpoint span" I measured in x on a diagonal chord: **a number that
is arithmetically correct and answers a different question than the one being
asked.** Three of those tonight, all mine.

`docs/HARNESS.md` now says it beside the metric: a rate over a short boundary is
not a defect, it is a short boundary.

```warning
Window. Per-layer figures are the shipped demo asset only — one drawing, 54
contours over 24px, and between 1 and 15 contours per layer. The size baseline
pools 5,029 contours from six traces. The ellipse test is synthetic and proves
only that the metric does not invent reversal on smooth convex shapes; it does
not prove the metric is meaningful at 25px, and on a contour that short an 8px
window still spans a third of the shape. If anyone wants the cream question
settled rather than deprioritised, that is the thing left to test.
```
