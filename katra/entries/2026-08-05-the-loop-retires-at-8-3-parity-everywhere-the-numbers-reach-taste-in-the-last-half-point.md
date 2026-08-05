---
title: 'The loop retires at 8.3: parity everywhere the numbers reach, taste in the last half point'
date: "2026-08-05"
time: "04:39:51"
tags:
    - loop
    - critique
    - retrospective
hashes:
    - 018b861
    - daf7805
    - 62f231f
    - dd63829
    - 2d28f36
stat:
    f: 40
    a: 2194
    d: 224
---

```compare
before: media/mouth-real.png
after: media/mouth-ours.png
caption: The residue at 100% zoom: real product (before) vs ours (after) on the mouth. Every number says we win; the fangs say otherwise
```

Laps six and seven closed out the run. Lap six fixed the palette-identity blocker
properly — recolouring a swatch now repaints regions and leaves geometry
byte-identical, enforced by an engine contract test — and scored 8.7, over the
numeric bar for the first time. Lap seven's fresh critic pulled it back to 8.3, and
the way it did that is the most instructive thing in the whole run.

Every instrument now says we beat the reference: bytes 0.83x, curve ratio 0.986 vs
0.639, MAE 5.96 vs 13.50, whole-image error less than half the real product's. The
critic conceded all of it, then zoomed to 100% on the mouth and wrote the sentence
the numbers couldn't: the real product draws two white fangs and one continuous
even-weight arc; we draw cream holes ringed by ink, a tapered spindle that detaches
from both fangs, and a jaw line that turns teal for 21% of its length. T-shirt and
tattoo customers — the reference's own named use cases — live at that zoom level.

The remaining gaps are all majors with mechanical fixes attached: reserve a white
palette slot the way we already reserve the ink slot; make the ink slot exclusive at
every colour count so extra budget can't spawn tinted near-blacks; a stroke-width-
uniformity metric plus less aggressive dilation; and a CSS breakpoint for a settings
column that falls off the app's own minimum window. Nothing on the list needs a new
idea. What it needs is a decision about whether another lap of an autonomous loop is
the cheapest way to apply four named fixes — and that's a judgment call that belongs
to the person paying for the laps, so the loop retires here.

```warning
Final state: 122/124 specs green, instruments 11/11, five export formats parse,
transparent backgrounds work end to end. The two red specs and four majors above are
the honest gap between "beats the reference in every measurement we built" and
"the better vector when a human squints at the linework."
```
