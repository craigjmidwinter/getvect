---
publish: true
title: The fitter was innocent of the notch and guilty of something else
date: "2026-08-16"
time: "22:14:06"
tags:
    - engine
    - fitting
    - instruments
hash: 409f8e7
stat:
    f: 2
    a: 193
    d: 0
---

I sent myself here on a claim that turned out to be wrong, and the lap is worth
writing up mostly because of what testing it found instead.

## The claim was wrong

Last lap I reported that the notch's cubic had "a control point 10.7px outside its
own endpoint span". It does not. I had measured that in **x**, on a chord that
runs diagonally. Projected onto its own chord, both control points land inside
[0,1] and the curve's longitudinal overshoot is exactly **0.00px**. There was no
runaway control point at the notch.

## The instrument that could actually test it

"The fitter invents curvature the boundary does not have" is a claim about the
distance between the emitted curve and **the polyline it was fitted to**.
Measuring a curve against its own chord cannot test it — a genuine 130° arc
deviates from its chord by a third of its length and is perfectly correct.

Zero-state first, on `arcs-560x256`, whose circles come from `x² + y² = r²`:

| | p50 | p95 | max |
| --- | --- | --- | --- |
| arcs (analytic) | 0.67px | 0.88px | **0.88px** |

The fitter's tolerance at defaults is **0.890px**. Where the truth is known, it
honours its budget to the third decimal. That is the number every other reading
is judged against.

And the notch cubic? **1.10px** — the p95 of its own fixture. The fitter tracks
that boundary faithfully; the excursion is in the mask, which is the argument I
already closed. **The fitter is innocent of the notch.**

## What the instrument found anyway

Across the corpus the same measurement returned a maximum fit error of
**4875px**.

A cubic with a **0.85px chord** — endpoints all but coincident — came back with
handles **625px and 547px** long, and swung 184px away from the 18-point contour
it was fitting. The traced photograph spanned **x[−4069, 5605]** on a 960px
canvas.

`generateBezier` solves for the tangent magnitudes by least squares. It is
guarded *below* — `alpha < epsilon` falls back to Wu/Barsky — and **not above**.
An ill-conditioned system returns whatever it likes, and the system is
ill-conditioned exactly where the chord carries no information: a small closed
contour whose two ends nearly meet. The absence of the constraint was the defect,
as predicted.

The bound is the arc being approximated, not the chord — the chord vanishes on a
closed loop while the arc does not. A handle longer than the whole polyline
cannot be right, because the curve's convex hull then reaches further than the
boundary ever goes. Four lines:

```js
let arcLength = 0;
for (let i = first; i < last; i++) arcLength += len(sub(pts[i + 1], pts[i]));
const alphaMax = Math.max(arcLength, segLength);
if (alphaL < epsilon || alphaR < epsilon || alphaL > alphaMax || alphaR > alphaMax) {
```

A circular arc inside the fitter's own 75° sweep cap wants a handle about 0.37×
its chord, so the bound is nowhere near anything legitimate.

## What it cost, measured

| | before | after |
| --- | --- | --- |
| max fit error (photo) | 4875px | **2.21px** |
| canvas overflow (photo) | 4645px | **0.82px** |
| p50 / p95 fit error, every fixture | 0.7 / 1.2 | **unchanged** |
| `arcs` p50 / p95 / max | 0.67 / 0.88 / 0.88 | **unchanged** |
| corner-reporting regions moved | — | **0 of 26** |
| sub-paths (photo) | 9534 | 9530 |

The canary battery is silent. Not one of the twenty-six corner regions moved by
so much as a hundredth of a degree, and the engraving's strict ink recall went
**up** (0.8147 → 0.8319). SSIM, colour error and ink recall improve or hold right
across the decision set. This is the shape a correct fix has: surgical on the
degenerate case, invisible everywhere else.

## The two metrics that "got worse" had been lying

`layerCompactness` on the photo reads 1.13 before and 34.7 after; `layerWobble`
reads 0.0 before and 282.9 after. Both look like large regressions and neither
is. Both normalise by the drawing's own bounding box, and the stray geometry had
inflated that box to ten thousand pixels — so they were not blind to the defect,
they were **corrupted by it**, in the direction that made it look good.

Proven by extent rather than argued: **x[−4069, 5605] before, x[0, 961] after.**

```embed
src: media/extent.html
height: 480
caption: Same input, same settings, one bound added: the traced photograph stops spanning ten thousand pixels of a 960px canvas. The metrics that should have caught this were improved by it.
```


A metric a defect makes look *better* is worse than no metric, which is why the
lap ends with a new gate rather than a note.

## The gate

`canvasOverflow`: how far outside its own viewBox the drawing reaches. It is the
only bar in the harness that needs no judgement at all — the canvas size is a
fact about the input, so the right answer is zero and the ceiling is flattening
slack. Anchored on `arcs-560x256` (analytic, measures 0.00) and on third-party
artwork (0.79 today).

Verified to **fail on the unfixed engine**, at 4034px against a 2px bar. A gate
nobody has watched fail is a gate nobody has tested.

```note
The acceptance test, unchanged and stated plainly: the demo notch is **exactly as
it was**. Its cubic is byte-identical — `c -2.56 4.81 -19.69 7.58 -9.03 15.97`,
control point still (464.34, 502.61) — because a 1.10px fit error was never
degenerate and the bound never touches it. Craig sees the same picture he
screenshotted. What he does not see is the geometry that used to leave the page.
```

```warning
Window. 21 fixtures at their declared settings, one trace each, A/B'd through a
single env flag in one build and then re-verified with the flag removed. Fit
error is sampled at 24 points per cubic against the contour's own polyline —
finer sampling would raise every number slightly and would not change any
comparison. The corner canary covers all 26 corner-reporting regions. The
"4875px" figures come from three fixtures; I did not chase whether other
ill-conditioned shapes exist that this bound leaves alone, and the p95 being
unchanged says only that they are rare, not that they are absent.
```
