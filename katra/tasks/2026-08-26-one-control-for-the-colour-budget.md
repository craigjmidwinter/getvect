---
title: One control for the colour budget, and a label that says what it does
date: "2026-08-26"
time: "21:05:09"
tags:
    - ui
    - settings
    - palette
summary: colorCount has two controls in two panels with different ranges, and it is a detection ceiling rather than a colour count. Collapse to one, rename, and stop re-clamping saved values.
type: task
status: todo
effort: L
---

Parked deliberately: eleven spec files touch one control or the other, and a
large edit to the most-tested surface in the app is the wrong shape of work
while people are downloading it. Pick this up when the launch has settled.

## Two controls, one value

`colorCount` is written from two places:

- **the Colors slider**, `src/renderer/App.tsx:1536`, `min={colorFloor}
  max={64}`
- **the Input palette chips**, `App.tsx:1897`, from `PALETTE_SIZES` at
  `App.tsx:194` — `[1,2,3,4,5,6,8,12,15,16,18]`

One setting, two idioms, two panels, two ranges. Nothing on screen says that
clicking a chip moves the slider, and the slider goes to 64 while the chips stop
at 18.

## The confusion stacked on it, which is the worse half

`colorCount` is **not the number of colours you get**. It is a ceiling on
detection. Two independent things then reduce it, and they call for opposite
reactions from the user:

- the engine folds near-duplicate layers — `maxNearDuplicateFills: 0` is a gate,
  so anything within 32 RGB units merges;
- the image may simply not contain that many colours.

So the slider can read 52 while the result is 19. A control labelled COLORS that
does not produce that many colours will be misread by everyone, and the honest
number is already on screen one panel over as `PALETTE 19`. The existing hint
(`settingColorCountHint`, `App.tsx:1608`) already separates those two causes;
the label above it does not.

## The proposal

**Chips as the only control in the main flow.** Discrete, honest about being
coarse, and matching how people think — "give me eight colours", not "give me a
ceiling of sixty-four". Craig had no preference and left the choice here, so the
reasoning is recorded rather than the verdict alone:

- the chips already clear `palette` and `disabledColors`; the slider's continuous
  range invites dragging through values that differ by nothing after folding;
- REFERENCE B3 specifies exactly those eleven sizes as radio rows, so the chips
  are the spec'd control and the slider is the addition;
- eleven discrete choices can be read at a glance, which a 1..64 range cannot.

**Do not label it "maximum".** Accurate and still misleading: it implies a
shortfall is the user's fault for asking too high, when usually the image just
has fewer colours. Label the chips **"Detail — how many colours to look for"**
and let the Input palette panel keep showing the answer. Question in one panel,
answer in the other.

**Demote the slider to Advanced rather than delete it.** The chips stop at 18 and
Photo's floor is 16, so photographic work has almost no room; extending the chips
would break REFERENCE B3; and seven e2e specs drive `settingColorCount`, several
for reasons unrelated to colour (export status, decode parity). Demoting keeps
them exercising a real control.

## Saved settings above 18 — keep the value, do not re-clamp

`colorCount` is persisted per image. If the chips become primary and a saved
value is 52, no chip matches and the UI silently misrepresents the setting.

**Show the chips with none active, plus a "52 — set in Advanced" affordance that
reveals the slider.** Re-clamping to 18 would change someone's output without
telling them, which is the same silent substitution this repo has spent a day
removing. A value the UI cannot display is a reason to show it differently, not
a reason to change it.

## Rename `onAutoPalette`

`App.tsx:1023` is **discard-my-edits-and-recompute** — it sets `palette: null`,
and its own tooltip says "Discard palette edits and recompute from the image".
That is not palette-size auto-detection, which is a separate, unbuilt idea. Two
different things share a name and a reviewer has already nearly conflated them.

Rename this one to **`onResetPalette`**, button label **"Reset palette"**: it
describes what it does, and it frees "auto palette" for the detection feature.
Two call sites and one label; the button has no testid of its own.

## Cost — read this before starting

Eleven spec files reference one control or the other:

    settingColorCount   b-controls-affordance, b-engine, b2-presets,
                        b3-palette, d4-export-status, q-decode-parity
    paletteSizeOption   b3-palette, b3-palette-state, b-controls-affordance

This is not a small edit. It is the most-tested surface in the app, and several
of those specs use the colour control incidentally to reach some other state, so
they will need reading rather than find-and-replacing.

## Already shipped, so do not redo it

`tests/e2e/b3-palette-reset-parity.spec.ts` pins that **both** controls discard a
hand-edited palette. Whichever survives must keep that behaviour. See the
chronicle entry for why that spec exists.
