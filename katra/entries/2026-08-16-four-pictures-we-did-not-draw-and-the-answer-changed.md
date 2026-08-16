---
title: Four pictures we did not draw, and the answer changed
date: "2026-08-16"
time: "18:49:43"
tags:
    - fixtures
    - process
    - instruments
hash: "14024e2"
stat:
    f: 14
    a: 599
    d: 36
---

Last lap ended with a rule and no way to apply it. Every fixture now declared who
made it; the count of artwork nobody here drew, in a fresh clone, was **zero**.
So `trimSlivers` came out — not because it was proven bad, but because nothing in
the repo was entitled to say either way.

This lap that stopped being true, and the answer changed.

## The licence comes before the file

`scripts/source-fixture.mjs` fetches an image from Wikimedia Commons in a fixed
order: ask for the metadata, **refuse anything whose licence is not on the
allowlist**, and only then download. There is no override flag, on purpose — the
failure being prevented is an asset whose terms nobody can state, and a flag is
how that failure gets committed at 11pm. Everything it writes goes into
`fixtures/third-party/LICENSES.md` next to the file: licence, usage terms,
author, credit, the Commons page, and the exact URL the bytes came from.

Rasters only. We take images and trace them ourselves; no other product's traced
SVG goes in there, which also keeps this lap clear of the question already open
about `fixtures/reference/`.

Four public-domain pictures, picked to be the cases the corpus had none of:

| | what it brings |
| --- | --- |
| `third-party-poster` | **letterforms** — three sizes of serif type over flat poster colour, plus a real scanned sky gradient |
| `third-party-photo` | a **real photograph** with genuine JPEG ringing, rescaled by Commons' own thumbnailer |
| `third-party-lineart` | a 19th-century **engraving** — dense cross-hatching, almost entirely one-pixel runs |
| `third-party-lowres` | a **250px, heavily compressed** poster, where the pixel grid IS most of the signal |

```gallery
- src: media/g1.jpg
  caption: third-party-poster — WPA travel poster, 1938. The corpus had no letterforms at all.
- src: media/g2.jpg
  caption: third-party-lineart — a 19th-century engraving, almost entirely one-pixel runs.
```

The engraving was chosen adversarially. If a filter that judges one-pixel runs is
going to break something, it will break that.

## The retrial

Then the question the rule actually wants, asked of the seven fixtures nobody
here drew (four new, three local):

| fixture | verdict |
| --- | --- |
| `third-party-photo` | **neutral-or-better** on every axis |
| `third-party-poster` | sustained staircase a hair worse, strict ink recall worse |
| `third-party-lineart` | **sustained staircase worse** 0.0863 → 0.0931, colour error and SSIM worse |
| `third-party-lowres` | **sustained staircase 0.0660 → 0.1322 — doubled**, and six other metrics worse |
| `local-artwork` | ink and SSIM worse, zero staircase gain |
| `local-artwork-default` | better (sustained −21%, paw-pad corner +12.3°) |
| `local-artwork-enhanced` | local better, wobble and compactness marginally worse |

The low-resolution row is the one that settles it, and it settles it against the
filter's own thesis. That fixture is the case `trimSlivers` was *aimed at* — the
one where the pixel grid is most of what you see — and the filter doubles the
staircase measure there. I rendered the site the instrument pointed at rather
than trusting the number, and it is visible: a new hook on the upper-left lobe, a
stepped left edge where there had been a clean diagonal.

```compare
before: media/lrsite-off.png
after: media/lrsite-on.png
caption: third-party-lowres at 20x, trimSlivers off then on. The filter aimed at low-resolution artwork doubles the sustained staircase there: a new hook top-left, a stepped left edge where there was a clean diagonal. At 250px a one-pixel sliver is not residue, it is the shape.
```

The reason is one the whole design missed. The guard that made the filter safe
last lap is an **area** test — a region under 196px² is a shape, not a boundary.
Area does not scale with resolution the way detail does. At 250px a colour region
is comfortably over that floor while its entire boundary is two or three pixels
of detail, so the guard waves the filter through and the filter eats the drawing.
**At 250px a one-pixel sliver is not residue, it is the shape.**

## So the answer is still no, and now it is evidence

`trimSlivers` stays out. Not on the strength of "we could not tell" this time, but
on four pictures nobody here drew, three of which it makes worse — including,
squarely, the case it was built for.

Worth stating plainly what changed with the corpus: on the mascot this filter
looked like a clear win, and on the mascot it *is* one. The measurement was never
wrong. It was answering a question about our cat.

```warning
Window. Four public-domain images plus three rows of one un-redistributable
drawing — seven fixture rows over five distinct pictures, one trace each at their
declared settings, plus a rendered check of the single worst site. That is enough
to refuse a change; it is nowhere near enough to characterise "a user's images".
Nothing here is a screenshot, nothing came off a phone, and `kind: 'photo'` is one
picture. Sourcing those is the obvious next lap, and it is still a sourcing job
rather than an engineering one.
```

```note
One threshold in this lap was set by guessing and then corrected by measuring:
I gave the photograph an SSIM bar of 0.6, it scored 0.4985, and tracing it at the
Photo preset (which is what a user would pick) moved it to 0.4988. A real
photograph reduced to nine flat colours simply scores about 0.50. Rather than
lower the bar to wherever it landed — the exact move this whole area is about — the
photograph now carries structural gates only, and its quality numbers are reported
and gate nothing until someone decides what good looks like for a photograph.
```
