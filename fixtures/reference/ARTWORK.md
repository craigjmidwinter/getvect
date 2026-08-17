# The gold-standard artwork in this directory

Both images here are this project's own, MIT-licensed with the rest of the repo. They are
the two most detailed pictures the harness traces, so a lot of the engine's behaviour was
worked out on them — but note what that means and does not mean: **they gate nothing.**

A picture we drew cannot tell an improvement from a change tuned to it. Every bar in the
harness is anchored on artwork nobody here drew (`fixtures/third-party/`) or on fixtures
generated from equations, and `tests/engine/provenance.test.mjs` enforces it. These two are
measured and reported every run, and their numbers decide nothing. See
`docs/HARNESS.md`, "Who is allowed to decide that a change is an improvement".

## Frankie — the current mascot and primary demo fixture

`frankie-sticker.png` is original artwork of the maintainer's own cat, an orange tabby.
1195×896, **53.0 % transparent** pixels, with `frankie-sticker-white.png` as the
white-flattened variant. The artwork was generated with an image model from a photo of him
and then hand-corrected for coat colour and markings.

At Clipart / 8 colours / Smart anti-aliasing our engine delivers 7 `<g fill>` layers: white,
light cream, pink (nose and ears), body orange, olive (the eyes), stripe orange, ink.

The **eyes** are the interesting region and the reason the fixture names a colour: they are
about 0.3 % of the canvas, so folding their olive `rgb(187,161,80)` into the surrounding
cream moves mean colour error by hundredths and SSIM by nothing. At default settings we keep
99.2 % of the olive; with our own Enhance on we keep 0.6 % of it —
**[issue #2](https://github.com/craigjmidwinter/getvect/issues/2)**. That is why
`colorPresence` exists as a metric at all.

## The fox — predecessor mascot, retained

`fox-sticker.png` is an original generated mascot, chroma-keyed to real alpha. 1024×1024,
**76.5 % transparent** pixels, with `fox-sticker-white.png` as the white-flattened variant.

Because it is three quarters transparent it is the strongest alpha guard in the suite: a
trace that paints the alpha-0 background opaque scores ~255 on
`maxTransparentAreaColorError` instead of the ~0.1 it should.

Its cyan eyes, `rgb(72,182,210)`, are dropped by our engine in every configuration — the
same class of finding as Frankie's, and also in issue #2.

## The anti-aliasing finding

The single measurement that shaped the engine most, replicated across three subjects at
otherwise identical settings:

| subject | AA off | Smart AA | path reduction |
| --- | --- | --- | --- |
| the fox | 637 paths / 189 KB | 63 paths / 35.5 KB | −90 % |
| Frankie | 758 paths / 132.7 KB | 41 paths / 22.3 KB | −94.6 % |
| an earlier pale-coat variant of Frankie (not checked in) | 354 paths | 67 paths | −81 % |

This is why Smart is the default (`src/engine/index.ts DEFAULT_SETTINGS.antiAliasing`) and
why shipping it off meant the configuration a user actually gets was the one nothing had
been tuned for.
