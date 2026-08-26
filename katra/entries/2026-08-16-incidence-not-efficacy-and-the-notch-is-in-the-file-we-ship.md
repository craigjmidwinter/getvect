---
publish: true
title: Incidence, not efficacy — and the notch is in the file we ship
date: "2026-08-16"
time: "18:59:04"
tags:
    - instruments
    - engine
    - process
hash: ab388f8
stat:
    f: 3
    a: 296
    d: 0
---

Craig: *"i don't understand we can prove that we are substantially worse
vectorizing our logo than the reference is in this exact way. presumably other
works have this issue as well? or maybe this is weirdness that only occurs on the
marketing site?"*

He caught an asymmetry I had walked straight past. **Every number I produced
measured the efficacy of the FIX, and I reported it as the incidence of the
DEFECT.** Those are different questions, and only one of them had ever been
asked. When `trimSlivers` bought nothing on the local artwork at 16 colours, I
called that a failure. It is not: it is evidence the fix is irrelevant *there*,
and it says nothing about whether that drawing had the defect at all. Nobody
checked. I did not check.

And the cause I had written down was structural — a residue finger that
`continuesRun` protects because it looks like a thin stroke and `narrowHere`
protects because it looks like a spike tip, two individually-correct guards with
a gap between them. Nothing in that sentence is about a cat. Craig's "presumably
other works have this issue" is a prediction my own diagnosis makes.

## Counting the cause instead of the cure

So: count sandwiched one-pixel runs that BOTH guards protect, per megapixel,
on the index image exactly where the filter would have run. `continuesRun` and
`narrowHere` are copied out of `preprocess.ts` verbatim rather than paraphrased,
because the entire claim is "these two leave a gap" and a paraphrase of either
would be measuring something else.

| fixture | provenance | blind spots / Mpx |
| --- | --- | --- |
| `third-party-photo` | third-party | **2604** |
| `third-party-lineart` | third-party | **992** |
| `third-party-lowres` | third-party | **921** |
| `third-party-poster` | third-party | **913** |
| `local-artwork-default` | third-party | 49 |
| `reference-frankie-default` | in-house | 18 |
| `reference-frankie` | in-house | 17 |
| `local-artwork` | third-party | 13 |
| `reference-fox` (3 rows) | in-house | 0–3 |
| all 8 synthetic | synthetic | **0** |

Craig is right, and it is not close. The defect is **50–150× more common on real
artwork than on our mascot**. It is not marketing-site weirdness and it is not
Frankie-specific.

The zeros are the other half of the story. Every synthetic fixture scores
exactly none — including `arcs-560x256` and `spikes-bands-384`, which ARE
antialiased, so this is not simply "we drew them with hard edges". Real artwork
has many colours meeting at pixel scale; our generated fixtures have three or
four meeting cleanly. **We drew a corpus that cannot exhibit this defect**, which
is why nothing caught it for two laps and why the only fixture that showed it at
all was the one drawing we had that a person made.

## The uncomfortable half of the same table

Set incidence beside what the filter actually did:

| | blind spots / Mpx | what `trimSlivers` did |
| --- | --- | --- |
| `third-party-photo` | 2604 | neutral-or-better |
| `third-party-lineart` | 992 | **worse** |
| `third-party-lowres` | 921 | **worse — sustained doubled** |
| `third-party-poster` | 913 | slightly worse |
| `local-artwork-default` | 49 | better |
| `reference-frankie` | 17 | better — the original "win" |
| `local-artwork` | 13 | irrelevant, and cost ink |

**The filter helps where the defect is rare and hurts where it is common.** That
is not a coincidence, it is the mechanism: at 17 per megapixel a sandwiched
one-pixel run is genuinely anomalous, so it is residue. At 900+ per megapixel it
is the texture of the picture — it *is* the drawing — and removing it removes
the drawing.

```embed
src: media/incidence.html
height: 480
caption: The number this whole argument was missing — incidence of the cause, with what the fix did there. Zero on everything we generated; 900–2600 per megapixel on artwork a person made.
```

I tried to split the two automatically: residue should be a BLEND, its colour
lying between the two regions it separates, the same argument
`regularizeBoundaries` makes about fringes. It scored Frankie's notch at **zero
blend slivers** — the one case whose answer I know for certain. White is not
between black and orange; it is the paper showing through where a stroke tip
faded. The classifier fails its own known-positive, so it is not a classifier and
I have thrown it away rather than reported it.

That failure is itself the finding: **at the mask stage, residue and detail have
the same local description.** The information that separates them — was this
pixel an anti-aliasing ramp between two flats? — exists in the source and is
destroyed by quantisation before this filter ever runs. Any real fix has to
happen while the ramp is still visible, in `deAntialias`, not after.

## The notch is in the file we ship

Craig's third possibility was cheap to settle and worth settling: is the notch in
the geometry, or in how the marketing site rasterises at 4x? Everyone who has
ever *looked* at it looked through a renderer.

Reading the `d` attribute as text — no rasteriser, no flattener, no sampling —
the white layer of the shipped demo asset contains:

```
c -2.56 4.81 -19.69 7.58 -9.03 15.97
```

From (484.03, 495.03) to (475.00, 511.00), with its second control point at
**(464.34, 502.61)** — 10.7px outside the span of its own endpoints. The curve
reaches x = 471.54, which is **3.46px beyond its leftmost endpoint**, and
deviates **5.93px from its own chord**.

So the notch is in the numbers, in the document we ship. Every renderer draws it
because the path says to. The demo is innocent. And note the amplification: a
**one-pixel** tongue in the mask becomes a **5.93px** excursion in the geometry,
which is why something a pixel tall is obvious at 4x zoom.

## The bar, looked at not taken

Same artwork, same feature, in a browser: their chin stroke tapers to a clean
point where it meets the white, and the white/orange boundary runs past it
unbroken. No excursion, no step. Craig's claim that we are substantially worse
on this exact edge is correct, and now we have our side of it as a number —
5.93px of chord deviation where they have a taper.

## Re-deciding

The rule stands and did not need weakening: our artwork cannot anchor a
threshold. But "cannot anchor a threshold" was never "cannot demonstrate a bug",
and I let those blur together.

- **The defect is real, general, and worst on exactly the artwork users bring.**
  Craig is right about all three. That belongs in the backlog as a live bug, not
  as a closed question.
- **The stated reason for removing `trimSlivers` was wrong.** "It bought nothing
  on `local-artwork`" was reasoning from a drawing with 13 blind spots per
  megapixel — the fix was irrelevant there, not failed.
- **The removal itself still stands, on better evidence.** Of the four
  highest-incidence images, the filter is neutral on one and worse on three. It
  fails hardest exactly where the defect is most common, and `third-party-lowres`
  — the low-resolution case it was aimed at — is the one whose staircase measure
  it doubles.

A fix is wanted and this was not it.

```warning
Window. Incidence: 21 fixtures at their declared settings, one trace each,
counted on the index image. That is the whole corpus, and the corpus is five
distinct real pictures. "50–150x more common on real artwork" rests on four
public-domain images against two of ours; it is a large effect on a small sample,
and the direction is what I would defend, not the multiplier. Everything from
`local-artwork` is un-redistributable and absent from CI. The path-data reading
covers ONE notch on ONE asset — it proves that notch is geometric, not that every
notch is.
```

```note
The residue-versus-detail split is the open problem, and it now has a shape: it
cannot be done from the index image, because quantisation has already thrown away
the evidence. The place to try is `deAntialias`, where a ramp is still a ramp.
```
