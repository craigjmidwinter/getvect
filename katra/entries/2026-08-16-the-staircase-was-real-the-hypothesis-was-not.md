---
publish: true
title: The staircase was real, the hypothesis was not
date: "2026-08-16"
time: "18:10:29"
tags:
    - engine
    - instruments
    - preprocess
hash: 9b5451c
stat:
    f: 11
    a: 642
    d: 0
---

Craig came back to the staircase with a screenshot of our own demo at 4x and a
flat verdict: this is not good enough yet. The brief named a suspect too — the
ramp snap in `preprocess.ts`, which had been the last thread of the previous
session.

Both halves of that turned out to be worth testing rather than believing. The
staircase was real and it was exactly where he said. The suspect was innocent.

```compare
before: media/site1-16x.png
after: media/site1-after.png
caption: The notch Craig saw, at 16x — the white bib meeting the chin stroke. The instrument ranked this site first of 48 sub-paths without being told where to look.
```

## The instrument had to survive one specific test

The rule for round one was that the measure must not agree with me. Anything that
scores "wiggly" high will flag a staircase — and will also flag Frankie's ear tip,
which is *supposed* to be angular. A measure that cannot separate those two is a
measure that will happily approve a change that rounds off the drawing.

What separates them is not amplitude and not frequency. It is **sign**. A corner,
however sharp, is one large turn among small ones and they all turn the same way.
A staircase alternates: it goes one way and comes back, over and over. So the
scalar is the turning that *cancels* —

```
excess = sum|dTheta| - |sum dTheta|
```

— which is precisely the quantity `layerWobble` throws away. That is not a
coincidence; it is why `layerWobble` was the metric that scored a visibly cleaner
boundary *worse* for turning less than the truth it approximated.

Two things the first two cuts got wrong, both caught by signals whose answer was
known before the measure saw them:

- **The max is the wrong aggregator.** A single honest inflection scored 0.0146
  and a genuine 0.2px sag scored 0.0105 — the defect was *below* the legitimate
  case. The discriminator is not how big a reversal is, it is whether it keeps
  happening. So the headline is the mean over the worst 40px run.
- **A tight curl is not a staircase.** A legitimate S-curve of 3px radius scored
  0.124, right in defect territory, until the measure was restricted to
  reversals whose excursion from their own chord stays inside about a pixel.
  Staircasing steps by a pixel however long the run is, because the grid is the
  only length it knows. That dropped the false positive to 0.026.

Then it earned its keep before it was pointed at anything: told to rank all 48
sub-paths of the demo, it put Craig's notch first, at (472,504) on the white
layer — "where the white band meets the black," found without looking. On the
spikes fixture, which is eight triangles and nothing else, the corners contribute
nothing and the whole score is one hard notch inside the largest triangle's hole
that no gate in the harness could see.

```embed
src: media/discrim.html
height: 520
caption: The validation that decides whether this is a measure or an opinion. Every genuine corner reads exactly zero; the defects sit two to three decades above the worst legitimate curve.
```

## The stage, decided by measurement

Walking the index image back through the pipeline put the notch at stage one,
already present in the quantized mask, before `majorityFilter` ever ran. Then the
decisive test: quantize with the ramp snap on, and with it off.

| | worst local | worst sustained |
|---|---|---|
| smart AA (ramp snap on) | 0.7695 | 0.1606 |
| anti-aliasing off (ramp snap off) | 0.7695 | 0.1606 |

Identical to four decimals. **The ramp snap contributes nothing.** Neither does
the boundary walk, nor the fitter's tolerance — from `1-quantized` through
`final` the local reversal moves 0.7695 to 0.7533, which is the two cleanup
stages removing two percent of it between them.

And the quantizer is not guilty either, which was the genuinely surprising part.
Those source pixels really are `(255,252,239)`. The artwork has a one-pixel-tall
white finger where the chin stroke's antialiased tip fades out, and we reproduce
it faithfully. It is faithful and it is wrong — residue below the scale of any
intended feature, rendered as a hard rectangle at 16x while everything around it
is a curve.

## Why it survives everything

The finger is protected twice over, and both guards are right:

- `majorityFilter` exempts it through `continuesRun` — every interior pixel has
  its own colour left and right, which is the exact signature of a one-pixel
  stroke, the thing that guard exists to save.
- `regularizeBoundaries` exempts it through `narrowHere` — it is bounded above
  and below within the reach, which is the exact signature of a corridor or a
  spike tip, the thing *that* guard exists to save.

So it reaches the tracer intact. The one thing a residue sliver is that a stroke,
a corridor and a spike tip are not: **sandwiched**. Its two flanks are different
colours from each other. `trimSlivers` is that test plus a length ceiling, and
nothing else.

## What the corpus said, including the parts that hurt

The first cut passed the fixture that motivated it and broke two others. The
canary fired exactly as the brief predicted: the local artwork's face lost 23 deg
off its bluntest corner (97.1 to 73.7) and gained ink with it, because the filter
was handing slivers to whichever flank had more neighbourhood — and at a corner
that flank is the outline. Ink is protected as a sliver's *own* colour; it now
also has to be protected as a sliver's *destination*. A second, plainer bug: both
sweeps read the original index image while writing to the copy, so the vertical
pass re-decided pixels the horizontal pass had already moved. That is what
*added* two slivers to the spikes fixture's band seam while removing the notch it
was aimed at.

With both fixed: 17 pass, 0 fail, 78 engine tests green. The staircase metric
across the corpus, trim off then on:

- **sustained** (the stair that repeats): 6 better, 1 worse, 10 unchanged.
  Frankie 0.0239 to 0.0140, the default twin 0.0189 to 0.0134, the fox 0.0704 to
  0.0654. A free side effect: the nose's long-standing ink-coverage aspiration
  moved 1.17x to 1.13x.
- **local** (the one-off notch): 5 better, **3 worse**. Frankie 0.2392 to 0.1091
  is the win, but the default twin went 0.3304 to **0.4894** and the local
  artwork 0.4237 to **0.7375**.

That second row is why `maxStaircaseLocal` is an aspiration on the mascot and not
a gate. The trim did not add reversal so much as concentrate it — the picture at
that site reads cleaner and the number reads worse — and a ratchet on a number
still moving in both directions would be a ratchet on noise.

```warning
One real regression that no gate catches: on the local artwork's muzzle crop, one
corner is genuinely 23 deg blunter (97.1 to 73.6) with the feature count
unchanged. Its face crop moved the same way but *gained* a feature and got
sharper on average (mean 108.7 to 115.7), so that one is a recovered detail
rather than a rounded one. The muzzle is not, and it wants a look before this
filter is trusted further.
```

```note
Nothing outside this repo was saved, fixtured, or quoted; what came back from the
brief was a bar, not an artefact. The bar: at 8x on a long shallow
near-horizontal edge — the hardest case there is — the outline should show no
visible steps on either side of the stroke, and the sharp corners in the same
drawing should stay sharp. Ours now has a number for both halves of that
sentence.
```
