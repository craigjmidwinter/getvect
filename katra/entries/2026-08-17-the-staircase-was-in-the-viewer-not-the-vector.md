---
publish: true
title: The staircase was in the viewer, not the vector
date: "2026-08-17"
time: "21:01:34"
tags:
    - site
    - instruments
hash: 2eae870
stat:
    f: 10
    a: 711
    d: 6
---

Craig looked at the demo and said he had a hard time believing the outline was
innocent: *"look how jagged and aliased the ear is and it comes out smooth vs
the outline."* He was right, and two rounds of engine-side investigation had
been chasing the wrong thing.

The natural story was the sharp-corners-stay-sharp rule — the corner detector
mistaking each pixel step on a diagonal for a real corner, pinning it, and
forbidding the smoothing exactly there. It is a good hypothesis. It is also
wrong, and the numbers say so: along the jagged outline there were **0 to 1
corners per 60px**, against **0** on the ear arcs that come out smooth. The
outline was in fact smoothed *more* (0.35px mean shift vs 0.21px) and frozen
less (6–8% of points vs 22–34%). `detectCorners` runs on the low-passed ring
precisely so a three-pixel sawtooth cannot be pinned, and it was doing its job.

So the next question was where the steps entered the pipeline — and the answer
was that they never did. The shipped SVG contains **zero** runs of four or more
consecutive sub-2.2px segments anywhere in the file. Every large layer is 100%
cubics with no line commands; the white outline is 116 curves over 6419px, a
median of 30.8px per segment. Measured against the source silhouette across all
2580 boundary pixels, the traced outline sits at a median of **0.00px** off,
p90 1.00px, max 2.00px.

Nothing in that is consistent with a preserved staircase. The artifact was
clean, and production was serving it byte-for-byte.

The demo is a slider: source PNG and traced SVG stacked, the top one clipped to
a moving seam. Only the *vector* was clipped. The raster stayed underneath
across the whole stage, so the pane labelled TRACED SVG was really `vector over
raster` — invisible everywhere the artwork is opaque, because the vector covers
the raster exactly.

The one place it does not is the sticker's outer silhouette, the only edge in
the drawing that meets transparency. The fitter puts its curve on the *midline*
of the pixel staircase, which is correct, and which leaves about half the
source's edge pixels sticking out past it. Those showed through from below, at
16x, with `image-rendering: pixelated`. The demo was advertising a staircase the
SVG does not contain — on the outline, and nowhere else.

```compare
before: media/pane-shipped.png
after: media/pane-fixed.png
caption: The TRACED SVG pane at 16x on the ear notch, captured headlessly. Before — production, with the source PNG leaking out from under the vector along the silhouette; the warm fringe pixels along the steps are the source's anti-aliasing, which a seven-flat-colour SVG cannot produce. After — the raster given the complementary clip. The SVG is byte-identical in both.
```

The fix is that each pane should show one image:

```css
.demo-vector { clip-path: inset(0 0 0 calc(var(--pos) * 1%)); }
.demo-raster { clip-path: inset(0 calc(100% - var(--pos) * 1%) 0 0); }
```

Two complementary insets, so the seam lands under the divider. `--pos` already
lives on `.demo-stage`, which `.demo-raster` inherits exactly as the vector and
the divider do, and nothing transitions `clip-path` — the drag was never an
animation, so this adds one rectangular clip per frame on a layer that was
already composited. Verified as exact complements at 0/25/50/75/100, seamless
at 1x, and free of hairline gaps at 16x on interior boundaries where the raster
used to be sitting behind the vector.

Worth naming what this is *not*: it is not a fix to the engine, and nothing about
the fitter, the corner detector, or the assets changed. The ear-tip canary and
the corpus are untouched by construction. The notch is still mask geometry.

The lesson went into HARNESS.md next to the dead-gate rule, because it is the
same failure in a different costume — something that looked like evidence and
was not, with nothing to say so. A comparison view is an instrument. An
instrument that composites its layers can manufacture a defect the artifact does
not have, and this one billed us two rounds before anyone read the SVG instead
of a picture of it.

```note
Craig's skepticism found this. The aggregate per-layer numbers said the outline
was fine — right about the geometry, and useless about the view.
```

## Checking it without taking somebody's screen

Eyeballing the staircase is how this was found. It is not how it should be
checked, and the first two rounds of checking it were done by driving Craig's
own Chrome through the browser extension — which pops tabs to the front, and
did so in the middle of a timed chess game. That is now a standing rule: site
verification runs in a headless browser the script owns, never in the browser a
human is sitting in front of; if a check cannot be done headlessly it gets
deferred and reported rather than taking the screen.

`scripts/verify-demo-panes.mjs` replaces the eyeball with the property that
actually matters, which is exact rather than visual:

> The TRACED SVG pane must be a function of the SVG alone. Hide the raster layer
> entirely and the pane must not change by a single pixel.

It parks the demo on three sites — the ear notch and the ear crown at 16x, the
whole cat at 1x — screenshots the pane, sets `display:none` on the raster,
screenshots again, and compares the bytes. Headless Chromium, launched by the
script.

The check has teeth, which is the part worth proving: it passes on the fixed
tree and **fails on all three sites against production**, which still serves the
old CSS. A check that cannot fail is not evidence.

```note
Also measured, and worth recording because it was the wrong suspect: the full
suite runs 70s wall at a mean of 52% of a 14-core machine, peaking at 71%. The
complaint that it "hijacks the machine" was focus theft from the browser
extension, not load. `scripts/measure-load.mjs` is the meter that settled it.
```

## Correction: it was the app, not the extension

The focus theft had a second, worse source, and the first diagnosis was wrong.
Craig's video showed the real thing: the acceptance suite launching the *actual
GetVect app*, headed, once per spec — "VECTORIZING…" windows popping over a
timed chess game, about twenty-five times a run.

The app was already trying to be polite. `app.dock.hide()` before ready and
`setActivationPolicy('accessory')` at ready both stop the process becoming the
active app, and both were working. The window was then put on screen with
`showInactive()`, on the reasoning that a window which does not take the
keyboard is harmless.

That reasoning is the bug. `showInactive` still maps the window. Not stealing
the keyboard is no comfort when you are covering someone's screen.

So under test nothing shows the window at all. Playwright drives the renderer
over CDP, which needs no visible surface; `paintWhenInitiallyHidden` keeps the
compositor running so the DOM still lays out and paints; and
`backgroundThrottling: false` comes with it, because a never-shown window is a
background window and Chromium throttles rAF and timers in those.

A setting that can be undone by one line is not a fix, so `windowGuard.ts`
neuters `show`, `showInactive`, `focus`, `moveTop`, `setAlwaysOnTop`,
`maximize`, `restore`, `setFullScreen` and `app.focus()` under test, hides any
window built `show: true`, and records every attempt with its stack.
`z-window-guard.spec.ts` runs a real vectorize and then asserts both halves.

The two halves are separate on purpose, and putting `showInactive()` back proves
why: the **visibility** test still passes — the guard stopped it — while the
**attempt** test fails and names the call and the line. Prevention and
detection, doing one job each.

```note
Screenshot capture needed no exception: `npm run docs:screenshots` already runs
under GETVECT_E2E=1, and CDP captures a hidden window correctly. Verified by
regenerating the shots and looking at them, not assumed. Which turned up
something unrelated — the committed README screenshots are stale, showing a
control panel the app no longer has. Left alone; that is Craig's call.
```

Hiding the windows made the suite slightly faster, too: 70.2s to 64.1s wall, at
a mean of 49% of a 14-core machine. The load was never the problem, but it is
now measured rather than argued about.
