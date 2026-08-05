---
title: The staircase that was never in the polyline
date: "2026-08-05"
time: "18:36:08"
tags:
    - engine
    - fitting
    - release
hashes:
    - e7b8e08
    - 6c0e72c
    - e47af84
    - 22d5d8b
    - c77474b
    - b7845c9
    - 490099e
    - e6cb61c
    - 52e01b9
    - 319e813
    - 0f1515e
    - c6288f4
stat:
    f: 37
    a: 2680
    d: 205
---

Craig looked at a cheek outline at high zoom and said the steps "read as pixels."
The obvious diagnosis — pixel staircase surviving boundary extraction — went into
the brief, and the agent killed it with one table: the boundary entering the
fitter is already smooth to 0.06 px RMS. The low-pass does its job. **The fitter
puts the staircase back.**

Two mechanisms, both in the Schneider fit: it accepts the first cubic inside the
error budget without any reparameterization, and it happily spans 116° of arc
with a single cubic — which a cubic cannot be. The curve sags 0.72 px mid-segment
and rejoins at the ends, under the 0.89 px budget, accepted. At segment length
scale that sag IS the undulation. It reads as pixels; it is polynomial sag.

The proposed metric died the same honest death: a frequency-band wobble measure
scored the exemplar's visibly-cleaner arcs seven times WORSE than ours, because
turning-per-unit-length rewards undulating around the truth over drawing it. The
replacement only measures where the answer is a fact: a new tracked fixture of
mathematically-exact antialiased circles, gated on RMS deviation from the
equation. Worst arc: 0.424 px before, 0.229 after, aspiration at the 0.08 the
boundary itself achieves. Corners survived (the spikes gate improved), seams
did not move, and every one of sixteen fixture rows got a better mean colour
error out of it.

```note
The same afternoon, v0.1.0 went out the door: tag-triggered release workflow,
a mount-verified dmg on GitHub Releases, a download button on the site that
resolves to it, and an updater that tells you and does not install — the silent
path is built, dormant, one metadata line from active the day a signing cert
exists. The copy grew its second honest exception: "two network touchpoints,
both in your control."
```

Three briefs in a row have now been corrected by their own agents — the fit
stage that wasn't (stripes), the L1 test that admitted everything, and the
staircase that was never in the polyline. The lesson the pit-crew post promised
keeps arriving on schedule: the diagnosis is a hypothesis, the instrument is
the judge, and the builder who measures before fixing beats the coordinator who
guessed.
