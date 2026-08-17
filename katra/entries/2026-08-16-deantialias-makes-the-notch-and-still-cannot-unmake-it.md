---
title: deAntialias makes the notch, and still cannot unmake it
date: "2026-08-16"
time: "21:57:56"
tags:
    - engine
    - preprocess
    - instruments
hash: a6db070
stat:
    f: 3
    a: 200
    d: 0
---

The brief was my own conclusion from the incidence lap: the evidence separating
residue from detail is destroyed by quantisation, so attack it in `deAntialias`,
before the mask stage, where the anti-aliased gradient still exists.

The premise was half right, and the half that was wrong is the interesting half.

## deAntialias is not failing to see the notch. It is making it.

The first thing I did was print what the pass actually does at the site, rather
than reason about it. Row 510, where the chin stroke tapers out over the bib:

```
   x | source        | after deAntialias | above(src)     | below(src)
 471 | 255,252,239   | 255,255,255       | 255,255,255    | 230,159, 83
 472 | 255,250,240   | 255,255,255       | 207,147, 95    | 230,159, 83
 473 | 253,247,235   | 255,255,255       | 139,123,100    | 230,158, 81
```

The source has a faint warm blend there. `deAntialias` snaps it to **pure white**
— and that is what manufactures the crisp one-pixel paper bridge which quantises
into the white layer, survives `continuesRun` and `narrowHere`, and reaches the
tracer as the notch on the marketing site. The stage I was sent to fix is the
stage that creates the defect.

## Why it does that, exactly

`supportMap` counts how many of the nine pixels in a window share the centre's
colour, and `SUPPORT_MIN` is 3 — enough support to count as "belongs to a
region", and therefore eligible to be one of the two ENDS a ramp is snapped
onto.

A one-pixel-tall run of residue has its left and right neighbours. That is three.
**The residue certifies itself as a flat region**, and then its neighbours are
snapped onto it. At (473,510) the pass literally chose the pixel beside it as the
light end of the ramp. Support is counted isotropically, so a 1-D chain and a 2-D
region are indistinguishable to it.

That is a real bug and a precise one, and it explains the incidence gradient from
last lap: it fires wherever many regions meet at pixel scale, which is what
photographs, engravings and low-resolution artwork are made of.

## The fix worked on incidence and failed on everything else

A region has extent in two directions; a line has extent in one. So: a pixel may
be a ramp end only if it has a same-colour neighbour horizontally **and**
vertically. Nothing is deleted — the change only withholds the right to be
treated as ground that other pixels get pulled onto.

Blind-spot incidence, per megapixel, on artwork nobody here drew:

| | before | after |
| --- | --- | --- |
| poster (letterforms) | 913 | **286** |
| lowres | 921 | **700** |
| lineart (engraving) | 992 | **851** |
| photo | 2604 | 2614 |

And then the corpus said no, loudly. On the same decision-carrying artwork:

- engraving `strictInkRecall` **0.815 → 0.691**, `layerCompactness` **1.13 → 18.9**
- photo `strictInkRecall` **0.963 → 0.897**
- poster wordmark corner **65.6° → 20.4°** — the canary, and it did not survive
- three fixtures failed their gates outright

The reason is the same sentence as the fix: a genuine one-pixel line is also
one-dimensional. Hatching, thin letterform strokes and drawn hairlines all lose
their right to be ramp ends, their anti-aliased skirts never resolve, and the
linework degrades into a fringe of intermediate colours. The incidence drop is
partly *that* — a differently-broken mask, not a better one.

## The measurement that ends the argument

Even with the fix in, the index image at the notch came out **byte-identical**.

```
   BEFORE                    AFTER
   510 BBBBBBBBBBBAAAAAAAAAA     510 BBBBBBBBBBBAAAAAAAAAA
```

Because preserving the blend does not help. Those six pixels sit **4.5 % to
12.3 %** of the way from paper to the body orange. Nearest-colour quantisation
assigns them to paper at 5 % tint exactly as it does at 0 %. The information is
not destroyed by quantisation — it is *there*, and it is 5 % strong, which is
below what any nearest-colour assignment can act on.

```embed
src: media/tint.html
height: 480
caption: The load-bearing measurement: the residue pixels sit 4.5-12.3% of the way from paper to the colour they arguably belong to. Nearest-colour quantisation cannot act on that, whether or not the earlier stage preserves it.
```


To close the gap you would have to repaint a pixel that is 88–95 % paper onto its
neighbour. That is not reading evidence, it is overruling it — and it is the same
judgement `trimSlivers` made, moved one stage earlier and no better founded.

## So: a third no, with a sharper reason

Not "we cannot tell". We can tell, precisely, and the signal is 5 %. The only
structural discriminator available before quantisation — one-dimensional versus
two-dimensional — is shared by genuine thin artwork, which is why the fix cost
the engraving a fifth of its ink and the wordmark two thirds of its corner.

Nothing shipped. The engine is exactly as it was.

## Where I think it actually lives

One number from the path-data lap has not been attacked and does not require
deciding anyone's intent: **a one-pixel mask feature becomes a 5.93px excursion
in the shipped geometry.** The cubic at the notch has a control point 10.7px
outside its own endpoint span.

Whether or not that pixel *should* be white, a one-pixel step has no business
producing six pixels of curve. That is a bounded, checkable defect in the fitter,
it is measurable against the arcs fixture whose answer comes from an equation,
and it needs no theory about what the artist meant. It is also the same organ
that produced the polynomial sag two laps ago.

```warning
Window. Everything above is 21 fixtures at their declared settings, one trace
each, A/B'd through a single env flag in one build; the pixel-level readings are
one site on one image; the incidence counts are the whole corpus. The four
public-domain images plus three rows of one un-redistributable drawing remain the
entire decision-carrying sample. The mascot is REPORTED here because the notch is
on the marketing site — it decided nothing.
```

![The demo at 16x, today, after this lap: unchanged. No fix shipped, so the notch Craig screenshotted is still there.](media/notch-today.png)

```note
The demo, checked as asked: re-traced and cropped at 16x, the notch is
**unchanged**. Its cubic still reads `c -2.56 4.81 -19.69 7.58 -9.03 15.97`, the
same control point at (464.34, 502.61), the same 5.93px of chord deviation. No
fix landed, so nothing moved, and the crop above is what Craig still sees.
```
