---
title: The fixture and the beneficiary were the same object
date: "2026-08-16"
time: "18:37:37"
tags:
    - instruments
    - process
    - engine
hash: c6fd567
stat:
    f: 8
    a: 481
    d: 241
---

Craig, on the sliver trim two laps in: *"we need to make sure we aren't just
fixing this for our logo but that its an improvement in our application."*

He is right, and my own table said so if you read it the way he was reading it.
The artwork that improved most was Frankie — our mascot, and also the canary the
filter was developed against. That is this project's recurring mistake wearing
one more costume: a test that read its expectation from the module under test, a
gate never wired to a render, a badge confirmed on a sibling render, and now a
de-staircasing filter judged by how much it improved the picture it was tuned on.
**The fixture and the beneficiary were the same object, so the measurement could
only agree.**

## Counting who made the pictures

The first thing this needed was not an argument but a census. Every fixture now
declares `provenance`, and the answer is starker than the concern:

- **10 synthetic** — drawn by `generate-fixtures.mjs` from equations and primitives
- **6 rows / 2 images in-house** — `fox-sticker.png` is "an original generated
  mascot", `frankie-sticker.png` is the maintainer's cat
- **0 third-party**

The only artwork in this repo that nobody here drew is the three `local-artwork`
rows, and they are un-redistributable, so a fresh clone has *nothing* that can
decide a mask-stage change.

And the corpus does not resemble the product in a second, independent way.
GetVect traces what a user drags in. There is not one phone photo, screenshot,
scan, low-resolution web image, or logo with text in it. There are no letterforms
anywhere — which is remarkable given that a wordmark is the case where every
de-staircasing change is most dangerous. The closest thing to a photograph,
`photo-gradient-512x384.jpg`, is a *generated* gradient saved as JPEG; its own
manifest note says "not the primary use case".

So the corpus is clean vector-origin clipart: the easiest input the tracer will
ever see, and the one a user is least likely to bring.

```embed
src: media/corpus.html
height: 520
caption: The corpus a fresh clone gets, against the inputs the product actually receives. The overlap is one row.
```

## The rule, and the test that keeps it

> A threshold set at where we happen to score may not be anchored only on artwork
> we authored.

Synthetic fixtures escape this and the distinction is the whole point.
`arcs-560x256` is drawn from `x² + y² = r²` — the bar is what the equation says,
not what we scored, and we can be wrong about it. Our own *artwork* cannot anchor
anything, because a filter tuned on it improves it either way.

`tests/engine/provenance.test.mjs` enforces it, and it bit immediately — on six
gates, five of which predate this week:

```
minDxfSplines                 only on reference-fox
maxDxfEpsBytesRatio           only on reference-fox
maxStaircaseSustained         only on reference-frankie   <- mine, two laps ago
minInkCoverageRatio           only on the frankie rows
minColorPresenceRatio         only on the frankie rows
minColorPresenceOverExemplar  only on reference-frankie
```

Mine is fixed properly: the sustained anchor moved onto the arcs fixture, where
it measures 0.0000 and the gate is zero-plus-room rather than a number I backed
into. The other five are carried in a `KNOWN_IN_HOUSE_ANCHORS` list that is a
**ratchet on debt** — a new entry fails the test, and a stale entry fails it too,
so the list can only shrink. That is what stops this from being a paragraph that
rots.

## Asking the shipping question properly

Then the same evidence, regrouped so the decision-carrying rows stand alone. On
the three fixtures nobody here drew, trim off → on:

| | staircase | fidelity |
| --- | --- | --- |
| `local-artwork` (16c, Enhance) | **no change at all** | ssim, inkRecall, strictInkRecall all slightly worse (0.9698 → 0.9679) |
| `local-artwork-default` | sustained 0.0566 → 0.0446, local 0.6720 → 0.6602, paw-pad corner +12.28° | meanColorError and strictInkRecall slightly worse |
| `local-artwork-enhanced` | local 0.4540 → 0.4344 | layerWobble, layerCompactness marginally worse |

The first row is the one that settles it: on 16-colour artwork with Enhance the
filter does a great deal of work, buys **zero** staircase improvement, and costs
a fifth of a percent of strict ink recall. The wins are real and they are on the
other two rows — one drawing at two other settings.

I tried the neighbourhood-simplicity guard I had abandoned earlier (a sliver's
window must hold only the three colours the predicate claims to have found).
Judged by the right criterion this time, it did not help: `local-artwork` failed
identically.

## So it does not ship

`trimSlivers` is removed from the pipeline. Not narrowed, not tolerance-tuned
until the canary went quiet — I had a knob that would have done it (the filter
only costs where the palette is large) and using it would have been fitting the
rule to the fixture, which is the disease and not the cure.

What survives is everything that measures: the staircase instrument, anchored on
ground truth rather than on the mascot; the finding that the notch is a
one-pixel sliver of anti-aliasing residue, faithful to the source and protected
by two guards that are individually right; and now the provenance rule and its
test.

Frankie's notch is back on the demo. That is the honest cost of the rule, and I
would rather show Craig a notch we can explain than ship every user a change
justified by our own cat.

```warning
Window, stated. Three fixture rows of ONE drawing is the entire body of
decision-carrying evidence, and it is un-redistributable, so CI has none of it.
"Fails the rule" here means "fails on the only non-authored artwork we have",
which is a weak test that the change nevertheless failed. A corpus with real
licensed artwork could just as easily vindicate the filter — that is the point of
getting one, and it is a sourcing job rather than an engineering one.
```

```note
The corpus plan, deliberately NOT "generate more synthetic images" — that is the
same self-reference in a lab coat. In priority order: permissively-licensed real
artwork checked in with its licence (CC0/CC-BY clipart, open icon sets,
public-domain scans), which is the item that unblocks the shipping rule;
photographs and screenshots, including one with visible JPEG ringing; text-bearing
artwork, because a wordmark is where de-staircasing is most dangerous and we have
no letterforms at all; and low-resolution input, where the pixel grid IS most of
the signal. Written up in `docs/HARNESS.md`.
```
