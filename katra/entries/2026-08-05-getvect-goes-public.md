---
title: GetVect goes public
date: "2026-08-05"
time: "08:32:26"
tags:
    - release
    - publish
hashes:
    - 93e1dc0
    - c704b10
    - e28302a
    - 7e63aaf
    - 665702a
    - 459578a
    - a92ea3f
    - 1021f5f
stat:
    f: 38
    a: 1732
    d: 939
---

![The mascot that replaced the exemplar we couldn't ship: our engine's own trace, 29 sub-paths and 13.6 KB against the reference product's 63 and 35.5 KB](media/fox-before-after.png)

The last mile was legal, not technical. The gold-standard exemplar that steered five
laps of critics was Nintendo artwork — perfect for a private quality bar, impossible
in a public repo. Getting rid of it properly took more care than expected, and two of
the traps were found by an agent rather than a checklist: a katra screenshot with the
character visible but no telltale filename, and the fact that force-pushing a
rewritten history leaves the old blobs fetchable by SHA on GitHub until garbage
collection — so the remote had to be deleted and recreated, not force-pushed.

The replacement had a nice symmetry to it. A generated fox sticker — chroma-keyed to
real alpha, 76.5% transparent — went through the reference product the same way the
original exemplar had, and came back a *stronger* fixture than the one it replaced:
more transparency to guard the alpha path, fully-known capture settings, and the
Smart-AA finding replicated on a second subject (637 paths to 63). The cutover also
flushed out a rasterizer bug that had been silently flattering us: the exemplar
renderer cropped transparent art to its ink before comparing, which would have made
every fox gate decorative. Instruments only measure what they actually see.

A final surgical round closed the loop's residue first: white highlights got a
reserved palette slot the way ink already had, the ink slot became exclusive so a
jaw line can't turn teal halfway, the settings panel learned to wrap at narrow
windows, and stroke-width uniformity became a gated metric — set as a ratchet at
today's numbers, with the honest 1.15× parity target written beside it.

```note
Shipped state: 124 e2e + 51 engine specs green, instruments 10/10, five export
formats, transparent backgrounds end to end, and a fidelity A/B where the engine
beats the product it was cloned from on every number we know how to compute — with
the one number we don't (whether a human prefers our linework at 100% zoom) named
plainly in the manifest comments as the remaining gap.
```

https://github.com/craigjmidwinter/getvect — MIT, no account, no credits, no upload.
