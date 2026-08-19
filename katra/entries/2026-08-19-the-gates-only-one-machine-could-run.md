---
title: The gates only one machine could run
date: "2026-08-19"
time: "18:36:48"
tags:
    - fixtures
    - provenance
    - harness
---

```embed
src: media/deletion-accounted.html
height: 480
caption: The deletion, accounted: what went, and what stayed green without it
```

Two rulings landed from Craig's sweep. The purge remnant — the one blob still
fetchable by SHA at GitHub after the history rewrite — is accepted as-is: no
Support ticket, no repo recreation, tracking ends. That one costs a sentence.

The other one costs an argument the harness has been having with itself for a
week. `fixtures/local/` held the artwork this engine most needed measuring
against and may not redistribute: three fixture rows carrying ~80 threshold
checks, fourteen of which were gate *kinds* no tracked fixture declares —
band fit, layer wobble, stroke-width variance. The overlay design was careful
(git-ignored entirely, absence never fails, merge in the consumer so nothing
leaks into the tracked manifest) and every one of those gates was still
enforced on exactly one machine in the world. A gate a reviewer cannot run is
a report wearing a gate's clothes. Craig ruled: delete it, let the gates tell
the truth, fix what actually breaks.

What actually broke: nothing. Engine contracts 80/80, acceptance 143/143,
instruments 19 pass 0 fail — and no `[local]` overlay line, so this machine's
run is now byte-identical to what CI and any clone sees. The orphaned metrics
are still computed and printed on tracked fixtures; they are now
reported-not-gated everywhere, which is what they factually were for everyone
else all along. The deletion did not weaken the harness — it corrected the
harness's claim about its own strength.

The sweep went past the ruling's letter where the same exposure lived under
other names: `artifacts/local/` and 73 derived files from old critic runs —
every rendered trace of the artwork — went with it, and one line in
HARNESS.md that leaked the real fixture id into public prose (the doc
anonymises those rows everywhere else) now uses the neutral name. HARNESS.md
records the deletion in place: the mechanism section carries a dated note, the
"measuring today" section is now "was measuring (deleted)", and the enhanced-
capture evidence paragraph says plainly that its numbers can be read but not
re-run.

```warning
The class of failure the local set existed to see — what a soft gradient does
to a quantizer — is unmeasured again, exactly as it was before the set was
built, except now the harness says so instead of pretending otherwise. The
mechanism stays for the day there is artwork that can carry those gates with
thresholds a reviewer could at least audit. Until then: fourteen gate kinds,
zero enforcement, stated in HARNESS.md rather than implied by a machine that
is not yours.
```
