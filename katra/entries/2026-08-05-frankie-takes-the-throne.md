---
publish: true
title: Frankie takes the throne
date: "2026-08-05"
time: "12:26:11"
tags:
    - mascot
    - fixtures
    - copy
hashes:
    - c9fa33d
    - 2e3521f
    - 70b710b
    - c78b1f8
    - 9fb47a9
    - 1fb260b
    - 02eca2d
    - c348d67
    - 50cff29
    - 28c0375
    - "7040442"
stat:
    f: 42
    a: 904
    d: 157
---

![The new before/after: Frankie, the maintainer's actual cat, 577 KB raster to 50 KB of curves](media/frankie-before-after.png)

The fox was always a placeholder: generated art standing in for a mascot with a
name. Frankie — Craig's actual orange tabby, photographed loafing on a duvet —
now holds the job. The pipeline built yesterday earned its keep immediately: the
swap was one source file, two constants, and `npm run assets`; everything
downstream (demo SVG, before/after, icon set, favicon, site copies) regenerated
itself, and the staleness gate in CI guarantees the site can never again show a
trace from an engine that no longer exists.

Getting his coat right took three rounds — the model kept inventing a white bib
he doesn't have, and the final saturated orange was a programmatic palette remap
of the approved drawing rather than another roll of the dice, because by that
point the drawing was the asset and the colour was a parameter.

The find of the day came from the new eyes-box instrument. Our engine drops
Frankie's green eyes with Enhance on (0.6% survival) and keeps them with it off
(99.2%) — one settings tick costs a palette slot. But measuring the reference product
against the same box turned up something better: its "preserved" green eye layer
is 69 RGB units from the source's actual olive. It didn't preserve his eyes; its
generative Enhance repainted them a nicer green. And the fox's cyan eyes are
dropped by BOTH products. The instrument that was built to catch our failure
caught the reference doing the thing we assumed only we did.

```note
The copy got honest today too, on Craig's call: "entirely on your machine" and
"no upload" were true until AI Enhance shipped and overstated after. The wedge
is now stated as it is — offline by default, one clearly-labelled opt-in
exception — which is both truer and, since the reference product can't say it
at all, still the sharper claim.
```

Also fixed on the way through: exemplar registration is now chosen by measuring
candidate alignments instead of trusting declared sizes, because the reference product
quietly trims transparent margins from its canvas — a bug that would have scored
every future die-cut exemplar as garbage.
