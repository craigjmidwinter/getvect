---
publish: true
title: A pit crew gauntlet takes on a leading online vectorizer
date: "2026-08-04"
time: "20:16:37"
tags:
    - loop
    - orchestration
hash: 005b78a
stat:
    f: 44
    a: 6022
    d: 0
---

```embed
src: media/pitcrew-loop.html
height: 480
caption: The loop: builders build, fresh critics judge against the reference product, the pit crew turns complaints into instruments
```

The ask: a desktop Electron app with feature parity to the raster→vector workflow of
the reference product, a leading online vectorizer. Built by the pit crew variant of
the gauntlet loop we've been prototyping — Fable orchestrating, Opus subagents doing
the work. The bet under test is the blog post's thesis: the loop's speed limit is
measurement, not intelligence, so a third role that does nothing but build
instruments should pay for itself.

The shape that came out of planning: a deterministic Workflow script, not
model-driven improvisation. Pit crew first (scaffold + Playwright-for-Electron
harness + a "light meter" that rasterizes output SVGs back and diffs them against
the source), then four sequential Opus builders (engine → shell → settings →
export), then three fresh-context critics with different lenses, a pit stop that
converts every automatable complaint into a failing test, and fix laps until the
integration critic scores ≥ 8.5 with no major gaps (capped at five laps).

Two alternatives got rejected on the way in. Parallel builders in git worktrees
lost to sequential builders on one repo — the slices genuinely depend on each other
(the settings panel needs the engine's palette contract), and merge arbitration
would have cost more than the parallelism bought. And "make it look like the
reference product" as a critic prompt lost to an acceptance checklist with ids
(A1–D4) plus numeric fidelity gates, because adjectives don't fail CI.

```warning
What broke first had nothing to do with agents: macOS XProtect decided the
Electron dev binary was malware and deleted it out of node_modules — twice,
including the re-download. Root cause was the pit crew pinning EOL Electron 31;
current 43.x launches clean. The durable fix is a postinstall hook that re-fetches
and de-quarantines the binary, because an environment fix that lives in one shell
session is not a fix.
```

By end of lap 1 the skeleton, harness, engine, shell, settings and export slices
had all landed as commits, with the acceptance suite failing exactly where the app
is still thinner than the checklist — which is the point: the failing tests, not
critic prose, pick the next lap's work.
