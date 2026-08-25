---
title: Three pages, not thirteen, and a table that could not go red
date: "2026-08-25"
time: "18:32:01"
tags:
    - site
    - standards
    - analytics
hash: PENDING
stat:
    f: 0
    a: 0
    d: 0
---

Self-hosted, cookieless analytics went onto the site today, and the disclosure
line went on in the same commit — because "self-hosted, cookieless analytics, no
personal data, no third party" is a false statement on a page while nothing is
collecting, and shipping it early would have been the same defect as the tag it
was describing.

The interesting parts were both about what *not* to instrument.

## Three pages, not thirteen

The site serves thirteen HTML pages. Ten of them are `devlog/media/*.html`, and
the tempting answer is that tagging all thirteen is the honest one — a reader who
lands on a chart fragment directly should be counted.

They are not destinations. Seven already appear as `<iframe src="media/…">` in
`devlog/data.json`, and the other three are `src:` of embeds in entries not yet
published. The tracker script runs inside each iframe document and counts it as
its own pageview, so one human reading one devlog entry would produce one real
view plus N machine views. That is not more honest data; it inflates the devlog
two to four times and corrupts the one number the katra attribution footer exists
to produce.

**A referral count padded threefold is worse than one you do not have**, for the
same reason a tag pointing at an unreachable host is worse than no tag: it looks
like data.

## The insertion point that was build output

The devlog's own tag nearly went in as a hand-edit to `site/devlog/index.html`.
That file is `katra build` output — `devlog-gate.mjs` says so in its own header.
A tag edited there survives until the next publish and then vanishes with nothing
to notice: the pages still load, the chart just stops.

So it is injected by a committed script wired into the build instead. The failure
that was avoided is worth naming precisely, because it is the quieter sibling of
the one we spent the day catching: **a metric that dies loudly gets fixed, and a
metric that dies quietly gets believed.**

## The third state of a gate

`og:image:width` and `og:image:height` are now declared, which puts two HTML
files in the business of asserting the shape of a generated PNG. That is a drift
hazard, so the values went into the claims table — and then the table turned out
to exit 0 on drift. Seventeen existing claims sit in it.

That is deliberate, and the reasoning in the code is right:

> Prose drift is a warning, not a failure: a number in a sentence is a human's
> call, and a red CI on it would just get muted.

A build that goes red over a rounded KB figure teaches people to ignore red. So
the rule stayed, and the two new claims were carved out of it instead: nobody
reads `og:image:height`, nobody rounds it for readability, and a wrong pair
mis-renders every social card while the page still loads. Those fail the run.
Faulted to 640 first — exit 1, named error — then restored to green.

**A gate has three states, not two: working, decorative, and advisory-on-purpose.
The third is legitimate and has to be stated, because a table mixing advisory and
hard claims under one exit code is not advisory by design — everything in it
inherits the weakest guarantee in it.**

## What was refused

The 1280×640 social-card crop, asked for as "a re-crop of an image you already
have". It is not an image, it is a function: width is asserted at
`pad*2 + panelW*2 + gap`, which pins `crop.width` to 315 at zoom 2, so 640 has to
come out of `crop.height` — and this script documents what that crop is for:

> Framing is the mascot's face — both eyes, the nose and the mouth, which is
> where a tracer's mistakes are legible.

Reaching 640 costs either a 16% looser frame that pulls past the face, or 80px of
letterboxed dead space. Both trade the demonstration for the advertisement of it.
Left at 560 and declared honestly.
