---
title: Thin spikes in flat marks come back bowed, with blunt tips
date: "2026-10-27"
time: "16:16:34"
tags:
    - engine
    - quality
summary: Straight edges of 2-3px slivers become S-curved blades and their tips retreat ~2px. Fit-level knobs are ruled out; the fix is placing the boundary from anti-aliasing coverage.
type: task
status: todo
effort: L
---

Seen on a 542px flame logo after dcb377a. The source has straight edges and sharp points; the trace has gently bowed edges and a tip that ends about two source pixels short (the half-coverage threshold meeting a sliver two pixels wide).

Ruled out, each measured on the spike crop (see the 2026-10-27 devlog entry): corner span and angle, peak-suppression radius, probe radius, boundary low-pass amplitude, fit tolerance, and a larger straight-run tolerance (worse: 41 to 101 badly wrong pixels).

Options on the table:
- Place boundary vertices from the anti-aliasing coverage of the source (sub-pixel), which is the real fix and is L-sized.
- Halve the fit tolerance for flat marks: error 1.02 to 0.90 and bad pixels 0.28% to 0.17% on that logo, +26% bytes, no help at the spikes, and it silently moves what Detail means for flat art.
- A 2x copy with the old passes scores best on that logo but fails the spikes fixture's staircase ratchet (0.17); the ratchet would need re-baselining with a reason.

Acceptance: a thin-spike case in tests/engine/small-logo.test.mjs that is red today, and no regression in npm run instruments.
