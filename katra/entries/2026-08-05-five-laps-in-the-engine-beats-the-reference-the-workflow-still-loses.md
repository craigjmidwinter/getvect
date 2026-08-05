---
title: 'Five laps in: the engine beats the reference, the workflow still loses'
date: "2026-08-05"
time: "02:02:40"
tags:
    - loop
    - critique
    - instruments
hashes:
    - afb337e
    - b0f7d04
    - d06bdb0
    - d10080f
    - cc3e39b
    - f2a5e16
    - d64eb9d
    - "6679031"
    - c6dc04d
    - 48fde9b
    - c5f606a
    - 3ce650f
    - 4f6013d
stat:
    f: 154
    a: 11450
    d: 1171
---

```embed
src: media/lap-scores.html
height: 480
caption: Integration-critic score by lap. The lap-5 dip is the critic inventing a sharper instrument, not the app getting worse
```

![Lap-5 blind A/B: source | our engine at 16c+Enhance | real the reference product. Ours keeps shading the exemplar throws away (MAE 5.65 vs 13.50)](media/ab-full.png)

![The identity test that stopped the loop: left is the engine's output, right is the same image after feeding the engine's own palette back to it unchanged. A no-op edit should be invisible](media/identity-override.png)

Laps three through five were the loop doing what the pit-crew thesis said it would,
including the uncomfortable parts.

Lap three opened on the blocker lap two's spotless scoreboard had hidden: the engine
never read the alpha channel, and the instruments couldn't see it because the decode
path they used flattened transparency onto white while the app's own decode flattened
it onto black. The fix landed as one of my favourite commit messages in the repo —
"transparency is a group with no colour" — and the instrument that would have caught
it now decodes through the renderer's pipeline instead of its own. The measured-on-a-
picture-the-app-cannot-produce failure mode is dead.

By lap five the engine itself crossed the line that matters: in the blind A/B against
the real product's own gold-standard export, ours is closer to the source and keeps
shading the exemplar throws away — MAE 5.65 vs the exemplar's 13.50, curve ratio
0.866 vs 0.639, 70 sub-paths vs 65. On the license-clean fox sticker it's not close:
29 sub-paths and 13.6 KB against the real product's 63 paths and 35.5 KB at matched
settings. The tracer is no longer the gap.

Then the lap-5 critic did the thing fresh context is for: it invented a sharper
instrument than any we'd built. Feed the engine the exact palette it just returned —
a no-op edit by definition — and the geometry changes. Root cause: a palette override
re-clusters from scratch at the override's length instead of repainting the slots the
user was shown, so every palette operation silently re-segments the drawing. Every
b3-palette spec passed because they all run on the flat logo fixture, where the
identity happens to hold. Real artwork breaks it in the first minute of use.

```note
The score went 7.0 → 7.4 → 8.0 → 7.5, and the dip is the healthiest data point on
the chart. Nothing regressed — the critic measured something nobody had thought to
measure. That is the difference between a plateau and a ceiling.
```

The loop hit its five-lap cost cap with the bar unmet, so the cap is raised two laps
and lap six is running now, seeded with the identity proof and a mechanical fix:
cluster once, fold once, and apply the override as a repaint of surviving slots, with
an engine contract test asserting byte-identical geometry under an identity override.

Still shaky: the identity test only covers two settings combinations, the Photo
preset's dead slider range is honesty-by-dimming rather than an actual wider gamut,
and nobody has run the app on a photograph of a human being yet.
