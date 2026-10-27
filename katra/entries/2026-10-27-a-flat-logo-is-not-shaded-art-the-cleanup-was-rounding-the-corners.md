---
title: 'A flat logo is not shaded art: the cleanup was rounding the corners'
date: "2026-10-27"
time: "16:16:18"
tags:
    - engine
    - quality
    - regression
hash: dcb377a
stat:
    f: 10
    a: 1011
    d: 22
summary: 'Small flat logos came back as soft blobs. Not smoothing: a 2x copy for small inputs, and skipping two index passes that round real geometry on flat marks.'
---

A three-colour flame logo, 219 pixels wide, came back from the default settings as soft blobs: the spikes rounded off, the small detached shards gone or fat, the thin white line between two colours closed, and the body of the flame drifted into a smoother silhouette than the one drawn. Then the same logo exported at 542 pixels on a transparent background failed the same way. Nothing in the harness could see it.

## What it was not

It was not the smoothing slider. Turning smoothing, despeckle and detail all the way to "keep everything" did not bring the spikes back. It was not alpha handling either: the transparent background and the white sticker outline came through fine, the outline as a layer of its own.

## What it was

Two things, found in this order.

**Size.** Every cleanup between the pixels and the tracer is defined in whole source pixels, so on an input under about 320 pixels a feature one or two pixels wide cannot be told from the noise those passes exist to remove. Tracing a 2x working copy and scaling the geometry back fixed that. The document, its viewBox and every export stay in source units, and the output stays byte-deterministic.

**The index-level passes Smart anti-aliasing adds.** The 3x3 majority votes and the seam regularizer round real geometry at any size. On the spikes fixture (384 pixels, nothing supersampled) a straight-edged triangle came back as a bowed arch with rounded corners, and either pass alone did it. With both off it came back straight and sharp. None of the fit-level experiments could have found this, which is why they all failed: the damage was done before the fitter saw the shape.

Both passes are now skipped for flat marks and kept for everything else. A mark is flat when it has few shapes (at most 120 regions of 16 pixels or more) and its pixels sit on its palette colour. The first condition alone was wrong, and the acceptance suite said so: a smooth gradient has few shapes too, and Smart came back byte-identical to Off. The second condition is what separates them (the gradient is 0.26 off-palette, the worst flat mark 0.058).

## What the full suite caught

Two more regressions, neither visible to the engine contracts. The gradient one above, and circle detection: the two rings of a disc were still found, but "concentric" was a one-pixel test in working pixels, so on a 2x copy a perfect ring stopped becoming a stroked circle. Both now have engine-level tests, and both were armed: break the fix, watch the test go red.

## Result

Mean error against the source, original engine to now: the small logo 4.45 to 1.81, the spikes fixture 1.68 to 1.01, the flat 512 logo 0.81 to 0.57. Fifteen of twenty-two earlier fixtures are identical in every metric: both gold-standard characters, the poster, the photo, the line art, the low-res poster, the gradient and the arcs. The cost: the speckled logo goes from 10 to 14 sub-paths.

## What did not work, so nobody repeats it

The thin spikes of the 542 pixel logo still come back as slightly bowed blades with blunt tips, where the source has straight edges and sharp points. The cyan spike's tip also retreats about two pixels, which is the half-coverage threshold doing what it does to a sliver two pixels wide. Tested and ruled out as the cause, each measured on that crop: corner detection span and angle, the peak-suppression radius, the probe radius, the boundary low-pass amplitude, and the fit tolerance. A larger straight-run tolerance made it worse (41 to 101 badly wrong pixels): it emits lines for runs that are not straight. A 2x copy with the old passes scored best on this logo, but fails the spikes fixture's staircase gate, and with the passes off at 2x the staircase measure is worse again (0.57 against 0.17).

The one change that helped the whole logo is halving the fit tolerance for flat marks: error 1.02 to 0.90, badly wrong pixels 0.28% to 0.17%, for 26% more bytes. It does nothing for the spike crop, and it silently moves what the Detail slider means for flat art, so it was not shipped as a tip fix. What would actually fix tips is boundary placement from the anti-aliasing coverage, which is a different piece of work.
