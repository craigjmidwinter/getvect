---
title: 'Shipping day: a domain, an icon, and one pixel under the next layer'
date: "2026-08-05"
time: "11:15:24"
tags:
    - release
    - site
    - quality
hashes:
    - 08d50b1
    - 9ddf441
    - "7922592"
    - 1eb9b81
    - e0b286d
    - 532be2f
    - b2fea9a
    - 9669f9d
    - 7c24d75
    - eb1033f
    - 6910d78
    - 7e80a6d
    - 9caa2b4
    - de67fa6
stat:
    f: 52
    a: 6538
    d: 425
---

![The wordmark that ended up on the door: Sedgwick Ave Display outlines in hot pink, no glow — Craig's call, and the right one](media/wordmark-pink-preview.png)

Five agents worked the repo in parallel today, fenced by file paths, and the day
ended with GetVect looking like a product instead of a repo: a landing page and
docs live at https://getvect.midwinter.io (DNS set in Cloudflare next to the www
record that was already pointing at Pages, cert issued, HTTPS enforced), a real
GetVect.app with the fox in the Dock, and a devlog like this one to explain it all.

The engine round was the best forensics of the project. The white hairlines
between fills turned out to be a compositing truth, not a tracing bug: trim every
layer to exactly its own pixels and any rasterizer will leak backdrop through the
shared anti-aliased edge. The fix is one pixel of under-extension beneath later
layers — invisible everywhere except inside the crack it closes. Sliver pixels on
the real artwork: 521 → 51. The fused claws were the ink bias eating a corridor
between two strokes from both sides; a two-pixel gap guard keeps them apart, and
a new tracked spikes-and-bands fixture keeps both defects measurable forever.
The corner problem — claws render as lozenges, not triangles — stays open and
honestly documented: the lever that fixes it (112° is known-reachable) pushes two
fox stroke ratchets over their bars, and a ratchet loosened to claim a win is not
a ratchet.

The Best-tier enhance failure was the day's best bug: the pro model answers the
identical request in JPEG where flash answers PNG, and our strict PNG check
rejected every valid response. The offline stub only ever spoke PNG, so the suite
stayed green through a fully broken feature — the same instrument-blind-spot
lesson this project keeps re-learning, now with a JPEG regression spec. And a
proper collateral find: renaming the app changed the Keychain service name,
silently orphaning the saved key while hasKey() vouched for it; it now answers by
decrypting, which is the only honest answer there is.

```warning
Residue, named: claw corners at 65° vs the 112° target; enforce-https and the
signing/notarization runbook are the remaining release chores; and the corner fix
wants fixture-kind-aware regularization, not a loosened fox gate.
```
