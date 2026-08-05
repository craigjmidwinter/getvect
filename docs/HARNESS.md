# Harness guide

Everything the pit crew installed: how to run it, what each number means, and the one
interface builders have to implement.

## Quick start

```bash
npm install        # also repairs/signs the Electron binary (scripts/verify-electron.mjs)
npm start          # build + launch the app
npm test           # acceptance suite (red by design until features land)
npm run instruments   # fidelity metrics -> artifacts/metrics.json
npm run screenshots   # flow screenshots -> artifacts/screenshots/
npm run docs:screenshots # the README's three screenshots -> docs/assets/
```

## npm scripts

| script | what it does |
| --- | --- |
| `npm start` | `npm run build` then `electron .`. Always runs the real bundle. |
| `npm run dev` | Vite dev server (renderer HMR) + Electron pointed at it via `VITE_DEV_SERVER_URL`. Iteration only — never what the suite tests. |
| `npm run build` | `build:node` (tsc → `dist/main`, `dist/engine`) + `build:renderer` (Vite → `dist/renderer`). |
| `npm run build:node` | Main process + engine only. What the instruments need. |
| `npm run build:renderer` | Renderer bundle only. |
| `npm run typecheck` | Type-checks both projects without emitting. |
| `npm test` | `scripts/run-tests.mjs`: engine contract tests **then** the Playwright acceptance suite (`pretest` builds first), **both always run**, exit code non-zero if either failed. The engine tests run first because they are the fidelity contracts: if the picture regressed, the UI specs' green is not worth reading. It used to be `node --test … && playwright test`, and that `&&` meant two red engine contracts hid the entire 108-test e2e suite from the documented entry point — the green e2e number was only reachable by bypassing `npm test`. Extra arguments pass through to Playwright: `npm test -- -g "\[B3\]"`. |
| `npm run test:engine` | Engine contract tests (`node --test`, pure Node). Four files: `engine.test.mjs` (determinism, setting semantics, palette overrides, SVG grouping, EPS/DXF/PDF structure — must stay green), `parity.test.mjs` (the B2-B6 settings, D1 fill notation, D3 DXF colour distinctness and curve survival, B3's colour-budget contract — at 6/8/12/16, a fold may only cost a colour when it removes a near-duplicate, and at the budget the exemplar was captured at we must deliver the five distinguishable colours the real product's own capture reduces to — B4's "the default pipeline keeps every colour family the image has", and B3's fold reversibility — the sub-1 % colour fold the panel blames for the shortfall must be switchable off by `mergeThreshold`, and reach at least what turning Enhance off already reaches, without buying the colours back as near-duplicates — B3's palette-override identity — feeding a returned palette straight back must repaint nothing, recolouring one swatch must leave every contour where it was, and a merge must survive the next setting change (the override is matched against `result.slots`, not the deduped `result.palette`), on the gold standard as well as the flat fixture), `rendered.test.mjs` (rasterizes output: does the *picture* change, is it curve-fitted, are colour boundaries smooth sweeps rather than sawtooth — globally (`layerCompactness` vs the exemplar) **and locally** (`layerBoundaryWobble`, turning per unit boundary length, which is what sees a cubic fitted to a noisy threshold) — do outlines come back solid (`strictInkRecall` vs the exemplar, in the face and paw crops), does the default pipeline keep a warm region warm, is it economical in shapes — at the Enhance-on **and** the default settings — does it hold up against the exemplar, and does the salient region of the gold standard survive the cleanup passes; the gold-standard source is handed to the engine through `canvasIngest()`, the same one-decode contract the instruments use, because the white-flattened variant of the same artwork paints 0.46 % of the paw a hue the source does not contain where the alpha-preserving ingest paints 0.000 %), `alpha.test.mjs` (the input alpha channel: a transparent background must not be traced as an opaque one). |
| `npm run test:headed` | Same, with a visible window. |
| `npm run fixtures` | Regenerates `fixtures/` deterministically. |
| `npm run instruments` | Measures the app engine on every fixture. |
| `npm run instruments:selftest` | Measures the naive `instruments/reference-engine.mjs` instead — proves the measurement chain itself works. |
| `npm run screenshots` | Drives the app through load → vectorize → settings → export, capturing labelled PNGs. |
| `npm run docs:screenshots` | Re-captures the three screenshots README.md embeds, so the public shots cannot drift from the app. |
| `npm run clean` | Removes `dist/`, `test-results/`, `playwright-report/`. |

Useful environment variables:

- `PW_WORKERS=1` — serialize the e2e suite when debugging.
- `GETVECT_E2E=1` + `GETVECT_EXPORT_DIR=/tmp/x` — makes the main process skip the native
  save dialog and write exports to that directory. Set automatically by the harness.
- `GETVECT_AI_DIR` — where the AI Enhance key store lives while `GETVECT_E2E=1`. Set by
  the harness to a temp directory per test, so a run can never touch the developer's own
  saved key (and `safeStorage`, i.e. the login keychain, is not called at all under e2e).
- `GETVECT_AI_STUB_DELAY_MS` — how long the offline AI Enhance stub takes to "answer"
  (default 250). A spec that needs to observe the in-flight state widens it via
  `test.use({ extraEnv: … })`.
- `VITE_DEV_SERVER_URL` — set by `npm run dev`; when absent the main process loads
  `dist/renderer/index.html`.

## `npm test` — acceptance suite

Playwright drives the packaged app through the `_electron` launcher (no browser download
is needed; **do not** run `npx playwright install`). Specs live in `tests/e2e/` and every
title is prefixed with its REFERENCE.md checklist id:

| spec file | checklist coverage |
| --- | --- |
| `tests/e2e/smoke.spec.ts` | none — harness self-check (launch, title, preload bridge, no console errors). Must always be green. |
| `tests/e2e/a-ingest.spec.ts` | **A1** drop zone + picker + PNG/JPEG/BMP + drag-drop · **A2** unsupported `.txt`/`.gif`/mixed drop · **A3** image list + selection |
| `tests/e2e/b-engine.spec.ts` | **B1** auto-vectorize, progress, 10s/1024px + non-blocking UI · **B2** the four sliders each change output · **B3** palette shown / changed / merged / removed · **B4** enhance toggle |
| `tests/e2e/c-preview.spec.ts` | **C1** toggle + side-by-side · **C2** zoom in/out/fit, pan, view sync · **C3** preview SVG == exported SVG |
| `tests/e2e/d-export.spec.ts` | **D1** SVG validity + dimensions · **D2** EPS structure · **D3** DXF structure · **D4** default filenames, main-process save path, selected image |
| `tests/e2e/d5-export-formats.spec.ts` | **D5** PDF structure (MediaBox, xref) · **D5** PNG bitstream + size · **D5** default filenames · **D1** per-colour `<g fill>` layers + `rgb(r,g,b)` notation |
| `tests/e2e/a-ingest-behaviour.spec.ts` | **A1** a second drop/pick selects the new image · **A1** drag-hover feedback (`data-dragging`) · **A2** toast lifetime (auto-dismiss, manual dismiss, not wiped by an unrelated success) |
| `tests/e2e/b1-stability.spec.ts` | **B1** no layout jump while tracing: settings panel and preview pane stay put, palette editor stays mounted |
| `tests/e2e/b2-presets.spec.ts` | **B2** the four model presets · Detail Level enum · Sketch grayscale · Drawing B/W + threshold · colour slider vs actual palette |
| `tests/e2e/b3-palette.spec.ts` | **B3** the eleven candidate palette sizes · output colour groups · disable → transparent background · merge threshold · sort order · panel size cap |
| `tests/e2e/b4-quality.spec.ts` | **B4** Noise Reduction / Anti-aliasing selects · halo suppression · enhance invents no colours |
| `tests/e2e/b5-advanced.spec.ts` | **B5** Roundness / Minimum Area / Overlap / Circle Detection |
| `tests/e2e/b6-result-style.spec.ts` | **B6** Filled vs Stroked layers, in the preview and in the export |
| `tests/e2e/c-preview-interaction.spec.ts` | **C1** preview never blanks, busy overlay is centred, no pan readout with no image and no clipped `preview-view-label` badges in side-by-side · **C1** the `preview-view-label` badges keep ≥ 3:1 contrast with their own background composited over a white preview (over light artwork the chip lands at luma ~155 with ~160-180 text and the label vanishes) · **C2** wheel zoom, pan clamping, controls inert when empty |
| `tests/e2e/d4-export-status.spec.ts` | **D4** export row does not re-flow · `data-last-export-path` invalidation · live `export-size` |
| `tests/e2e/q-decode-parity.spec.ts` | **quality-bar** a transparent PNG exports without an invented background · the app's exported SVG equals `engine.vectorize()` run headlessly on the same file (byte-identical on the flat fixture, structurally on the gold-standard one) |
| `tests/e2e/a2-decode-failure.spec.ts` | **A2** a file that decodes to nothing leaves no `image-list-item`, does not poison the workspace, and does not leave a stale `export-size` |
| `tests/e2e/c2-resize-fit.spec.ts` | **C2** shrinking the window re-fits the preview; a zoom the user chose survives a resize |
| `tests/e2e/b-controls-affordance.spec.ts` | **B2** Drawing disables the colour controls it cannot use · **B3** `merge-threshold` / `color-sort` / the first `color-group-toggle` are on screen at the default window size, **every** output colour group is reachable there (not just the first — an 8-group list shipped with its last entry behind a scrollbar), none of the colour controls is clipped by a scrolling ancestor at an 18-colour palette, nothing inside the panel is hidden by unscrollable overflow at the app's 900x640 minimum, the panel does not scroll **horizontally** there and the three output-colour controls are drawn inside the viewport without a scroll gesture (the whole OUTPUT COLOURS column sat 227px off to the side: `settings-panel` scrollWidth 863 vs clientWidth 636, reachable but with no affordance saying so), colour-count hint is not clipped, `palette-auto-button` carries the same chrome as the panel's other buttons, every colour-group label renders its `#rrggbb` without clipping and the list does not scroll horizontally · **B2** the Photo preset never displays a colour count the engine will not use (its `presetColorCount` floor is 16, so a live slider reading 4 delivers 10-16) |
| `tests/e2e/d3-dxf-variants.spec.ts` | **D3** the `dxf-curves` control exists and defaults to `splines` · the `lines` variant flattens to POLYLINE/VERTEX with no SPLINE and describes the same drawing (same extents) · **D4** the select is disabled with no image loaded (it was the one live control in a fully greyed export row) and enabled again once a result exists |
| `tests/e2e/ai-enhance.spec.ts` | **AI Enhance (bring your own key)** — the `ai` option of `enhance-toggle` is inert without a key and live with one · the key never comes back to the renderer (field, DOM, storage, and no `get*` on the bridge) · the privacy notice is rendered text at the control, not a tooltip · a successful run swaps the working image (the traced `viewBox` becomes the stub's 256×160) and shows "Enhancing with AI…" while it does · a bad key and a dead network each fall back to the un-enhanced image with a specific message · a provider that answers in JPEG rather than PNG is still accepted (`reply-jpeg`, the `best` tier's real behaviour) · `local` and `ai` are alternatives and both stay reachable (returning to `local` restores the classical result exactly). Fully offline: `aiEnhance:run` routes to the deterministic stub in `src/main/aiEnhance.ts` under `GETVECT_E2E=1`, and the key store is a per-test temp dir (`GETVECT_AI_DIR`), never the real one |
| `tests/e2e/b3-palette-state.spec.ts` | **B3** the colour-count hint attributes the shortfall to the image or to the settings (`data-shortfall`), and never blames the image for our own fold · **B3** `palette-auto-button` restores the palette and the candidate size the edit replaced |

Selectors are `data-testid` only. The full DOM contract is
[docs/TESTIDS.md](./TESTIDS.md) — read it before building UI, it is what makes the app and
the tests converge.

Everything from `a-ingest-behaviour.spec.ts` down is **expected to be red** until the
matching REFERENCE feature lands — that is the point of a gauntlet lap. Green specs
above the line are regressions if they turn red.

REFERENCE section E (stretch features) is deliberately **not** instrumented: REFERENCE
itself grades those as minor, and a check nobody intends to satisfy is noise. If one is
picked up, add its spec here at the same time.

Reports land in `artifacts/e2e-results.json` (machine-readable), `artifacts/e2e-report/`
(HTML) and `artifacts/test-results/` (traces + failure screenshots).

Playwright's `use.actionTimeout` only reaches pages created by the browser fixtures, so
the `page` fixture in `tests/e2e/helpers.ts` calls `page.setDefaultTimeout(8_000)`
itself. Without it a missing testid costs 30 s per test and a red lap takes minutes.

Run a slice:

```bash
npx playwright test -g "\[B2\]"          # one checklist item
npx playwright test tests/e2e/d-export.spec.ts --headed --workers=1
npx playwright show-report artifacts/e2e-report
```

## `npm run instruments` — the light meter

Pure-Node, no Electron. For each fixture it decodes the source, calls the engine's
`vectorize()`, rasterizes the returned SVG **back to the source dimensions** with resvg,
and diffs.

Rasterization lives in `instruments/lib/render.mjs` (`rasterizeSvg`,
`rasterizeExemplarContent`) and the engine tests import the same functions, so a number in
`artifacts/metrics.json` and a number in a `node --test` failure message describe the same
picture. They did not always: an engine test that rasterized a capture with a padded
viewBox against that declared box was comparing our paw against the exemplar's empty
margin and passing for it.

### One decode contract

The engine is handed `canvasIngest(decodeImageFile(file))` — the *same pixels the
renderer's canvas ingest produces*, including `(0,0,0,0)` for every fully transparent
pixel — while fidelity is judged against `flattenOnWhite(...)` of the same file.

This is not a detail. For one whole lap the instruments fed `vectorize()` a
white-flattened image no UI could produce, and reported the gold-standard row passing at
2.82× the exemplar's sub-paths for a document the user could not obtain: through the app
the same fixture traced its transparent background as **opaque black**, took the dominant
palette slot for it, and came out at 4.9×. A number measured on pixels the product never
sees is not a measurement of the product.

So: **if you change how the renderer decodes, change `canvasIngest()` in the same
commit.** `tests/e2e/q-decode-parity.spec.ts` is the guard — it exports SVG through the
UI and compares it to `engine.vectorize()` run headlessly on the same file at the same
settings — and it is meant to go red the moment the two drift apart.

Reported per fixture (`artifacts/metrics.json`):

| field | meaning | REFERENCE bar |
| --- | --- | --- |
| `meanColorError` | mean absolute per-pixel error over R,G,B, 0..255 | < 8 on flat fixtures |
| `rmsColorError`, `psnrDb` | context for the above | — |
| `ssim` | mean windowed structural similarity (8×8 windows, stride 4, luma) | ≥ 0.90 on flat fixtures |
| `pixelMismatchRatio` | fraction of pixels off by > 12 in any channel | — |
| `inkRecall` | fraction of the source's *ink* pixels (luma < 60) still darker than 128 in the re-raster — line art is too few pixels for MAE/SSIM to notice when a cleanup pass deletes it | ≥ 0.95 (the fox) / ≥ 0.97 flat |
| `strictInkRecall` | ink pixels (luma < 60) that come back **still < 60**. `inkRecall`'s "kept" test accepts anything darker than 128, which answers "was this stroke erased" and not "is it still a stroke": on the gold standard's paw it scores us 0.997 against the real product's 1.000 for toe arcs that come back visibly thinner | reported; gated per region (below) |
| `inkComponentRatio` | 8-connected components of the trace's ink field over the source's (components under 4 px ignored). An outline broken into dashes multiplies its component count while `inkRecall` barely moves | reported |
| `regions[]` | one entry per `salientRegion` / `salientRegions` box: `inkRecall`, `strictInkRecall`, `inkComponentRatio`, `meanColorError`, `ssim`, plus the exemplar's own values and our ratio to them | see `salientRegions` below |
| `regionInkRecall` / `regionStrictInkRecall` / `regionMeanColorError` / `regionSsim` | the same numbers **aggregated to the worst region** — min for the "more is better" ones, max for error | `minRegionInkRecall` 0.93 on the gold standard; `minRegionStrictInkRecall` 0.94 at the defaults |
| `regions[].foreignColorRatio` / `regionForeignColorRatio` | share of a crop painted a colour the **source crop does not contain** (nearest source colour further than 32 in RGB — the same window `nearDuplicateFillPairs` uses; at 40 the teal that painted a fifth of the gold standard's lower jaw sat 40.2 from the nearest colour its crop contains and the muzzle reported 0.00 % — source colours quantized in 4-unit cells so its own antialiased in-betweens count as present). A *categorical* error rather than a metric one: 123 teal pixels inside a cream muzzle move MAE by hundredths, move SSIM by nothing and move ink recall by nothing, and are the first thing a person names. The table's `leak%` column is the worst region's | 0 for the real exemplar everywhere, and 0 for us on the transparent source; the white-flattened variant scores 0.46 % on the paw, which is what `reference-fox-white` pins. Gated per crop (`maxForeignColorRatio`) at 0.05 % |
| `regionStrictInkRecallRatio` | our strict ink recall over the exemplar's, in the region where we are worst relative to it. Absolute strict recall cannot be gated globally — the exemplar itself scores 0.859 there because it drops antialiased skirts — but "the real product's line is more solid than ours" is a fair question anywhere | ≥ 0.87 on the gold standard (ours is 0.90 on the muzzle, the worst crop; 1.0 is the number to aim at) |
| `strokeWidth` / `sourceStrokeWidth` / `strokeWidthRatio` | per region: the trace's local stroke width on the source's own medial axis (the shorter of the horizontal and vertical ink runs through each skeleton point, 0 where the trace has no ink there), the source's, and ours over it. Only where the source is drawing a *stroke* — a point whose longer run is at least 3× its shorter one — because inside a filled region every interior pixel is on some medial axis and its "width" is the region: with blobs counted, one eye outvoted every line in the gold standard's face box | reported |
| `strokeWidthCv` / `strokeWidthCvRatio` | the coefficient of variation of that width, and ours over the exemplar's in the crop where we are worst. **The thing REFERENCE's blind A/B is decided on, and the thing every other ink metric here reads backwards**: a line that thickens, thins and breaks recalls more ink and joins more components than an even one, so `regionStrictInkRecall` once scored us 0.967 against an exemplar's 0.755 for a mouth arc that tapered to a spindle and detached from both fangs. Gated as a ratio because the absolute cv belongs to the artwork (a drawn line genuinely varies) while "less even than the real product's trace of the same line" belongs to us | `maxStrokeWidthCvRatio` on `reference-fox`. **A ratchet, not parity**: ours is 1.64x on the muzzle crop (cv 0.455 against the exemplar's 0.277) and the bar is 1.8; the number to aim at is 1.15x |
| `strokeWidthOverExemplar` | our fattening over the exemplar's, worst region. On the face crop the real product traces the source's stroke at 1.01x and we trace it at 1.12x, i.e. 1.11x its fattening | `maxStrokeWidthOverExemplar` 1.25 on `reference-fox` |
| `regions[].bandFit` / `bandStep` / `bandStepExcess` / `bandSpread` / `bandCount`, and `regionBandFit` / `regionBandStep` / `regionBandStepExcess` aggregated to the worst crop | **Shading-band quality** (`metrics.mjs shadingBandQuality`) — the only metric here that is not about an edge. Every other ink/geometry number in this file was built on flat clipart with a black outline, where the interesting failures live *on* the outline; soft-shaded artwork fails somewhere else, and it fails invisibly. `bandFit` asks *is each band the colour of what it covers* — for every flat colour the trace paints in the crop, the distance from its fill to the mean **source** colour under it, area-weighted, in 0..255 units. `bandStepExcess` asks *how much of the seam did we invent* — the largest (our step between two touching bands) minus (the distance between those two bands' own mean source colours). A real colour edge scores ~0 however huge it is (the fox scores 0.0–0.2 everywhere, which is the sanity check); a seam drawn across a soft ramp scores its whole contrast. `bandStep` alone is reported but not gated: a crop big enough to hold a face also holds a real edge, and the biggest step in the shaded fixture's face box is two blues in the ear. Ink is excluded from all of it — a drawn outline is *supposed* to be a hard step — and `bandSpread` (how much source variation each band swallows) is context: it belongs to the artwork and the colour budget, not to the tracer. Bands are found as **peaks** (heaviest colour claims everything within 12 RGB units, repeat) rather than by exact pixel value, because our raster is antialiased and an exemplar in a padded viewBox is rendered at 2× and resampled — grouped exactly, the real product's face reported *one* band and a seam of zero on a picture that visibly has two | gated on `local-snorlax` (see "Local fixtures"): the face crop holds `maxBandFit` 3.5 and `maxBandStepExcess` 10 |
| `layerCompactness` / `layerCompactnessRatio` | mean `perimeter / (2·√(π·area))` over the `<g fill>` layers covering ≥ 1 % of the drawing (1.0 = a disc), and ours over the exemplar's. The sawtooth-vs-sweep difference between clipart and a posterized photo, which MAE cannot see (both sides of a ragged seam are nearly the right colour), ink recall cannot see (no ink) and sub-path count cannot see (one region either way). Computed from path data, not by rasterizing each layer, so it stays pure and deterministic | ≤ 0.8× the exemplar's on the gold standard (its mean is 4.55; ours is 2.99, i.e. 0.66×). The bar was 1.1× when we were the ragged one; on this artwork the real product carries the extra perimeter, because two of its seven layers are near-identical browns whose boundaries interleave |
| `layerWobble` / `layerWobbleRatio` | mean **turning per unit boundary length** over the same layers, and ours over the exemplar's. Compactness is a *global* perimeter-over-area ratio and cannot tell a genuinely intricate shape from a smooth one traced onto a noisy threshold; this walks every boundary at the same fraction of that drawing's own diagonal (so the exemplar's 10× viewBox needs no scale factor) and measures how much the heading changes per unit travelled. A soft shading gradient crossed by one arc scores low; the same gradient crossed by a sawtooth scores high **however few sub-paths it is written in and however many of its commands are cubics** — which is exactly the hole `curveCommandRatio` leaves: our commands *are* curves, and they can be curves fitted to a wobble the real product never had. Flat fixtures score 6-13, the gold-standard exemplar 80.2, ours 28.4 | ≤ 0.45× the exemplar's on `reference-fox` (ours is 0.35×; `reference-fox-default` is 0.36×, reported not gated). The bar is below 1 because on this artwork we are the smooth one — the real product spends two of its seven layers on near-identical browns whose boundaries interleave |
| `sourceColors` / `paletteShortfall` | the palette size **before** our own folds, and `min(requested, sourceColors) − delivered`. Separates "the image ran out" from "our cleanup merged them": 8 requested, 6 found, 5 delivered is a shortfall of 1 and nothing to do with the picture | ≤ 1 on `reference-fox` and `reference-fox-default`, ≤ 2 on `reference-fox-white`, ≤ 3 on the 16-colour row. The exemplar settles what "enough" is: its capture at the 8-colour setting carries seven `<g fill>` layers, two pairs of which are inside the halo window `maxNearDuplicateFills: 0` forbids us — fold those and the real product's own answer is the five we deliver |
| `exemplarRegionInkRecall` / `regionInkRecallRatio` | the exemplar's ink recall in that same region, and ours over it — < 1 means the real product renders the salient region better than we do | reported; the A/B in one number |
| `pathCount` / `shapeCount` | `<path>` count / all drawable elements | ≤ 200 on flat fixtures |
| `subPathCount` | `M`/`m` starts across every `d` attribute — the **honest shape count** | ≤ 200 flat / ≤ 1200 noisy |
| `tinySubPathRatio` | share of sub-paths whose bounding box is ≤ 1.5 px in both axes, i.e. single-pixel specks | < 0.02 flat / < 0.1 noisy |
| `curveCommandRatio` | `[CcSsQqTtAa] / ([CcSsQqTtAa] + [LlHhVv])` — "smooth curve-fitted outlines (no pixel staircase)" made countable | ≥ 0.5 (the exemplar scores 0.639) |
| `cubicCount` | cubic Bézier segments | — |
| `layerCount` | `<g fill>` colour layers | — |
| `nearDuplicateFillPairs` | pairs of colour layers within RGB distance **32** — the anti-aliasing halo / patchwork signature. The window was 24, which reported 0 for a gold-standard output carrying layers 26.6 and 27.0 apart (visibly two near-identical creams mottled across one region); this is one of the few bars where we are stricter than the real product rather than chasing it — its own capture of the gold-standard artwork ships two pairs inside the window (10.9 and 8.0 apart), and folding them is most of why our palette comes back one colour shorter than its seven layers | 0 on flat fixtures **and on the gold standard** |
| `dxfBytes` / `dxfSplineCount` / `dxfVertexCount` / `epsBytes` / `epsCurveCount` / `dxfEpsBytesRatio` | D3 export structure, computed only for fixtures that gate it (`minDxfSplines`, `maxDxfEpsBytesRatio`). A DXF that flattens every fitted cubic into VERTEX runs is 12× the EPS of the same drawing | ≥ 10 SPLINE (25 today), ≤ 3× the EPS (2.23× today) |
| `perColorCoverageDelta` | max change in a palette colour's area fraction between source and re-raster; catches hairline erosion that MAE/SSIM average away | ≤ 0.01 on flat fixtures |
| `sourceTransparentRatio` | share of source pixels with alpha < 128 | context (0.765 for the fox, 0.60 for the sticker) |
| `transparentAreaColorError` | mean colour error **over those pixels only**, against the source flattened on white | ≤ 8 wherever the source has alpha. Leaving the background out of the drawing scores ~0 (resvg composites on white) and so does flattening it to white; inventing an opaque backdrop scores ~255 |
| `backdropFill` | fill of the full-bleed `<rect>`, or `null` | reported, not gated — it is the *why* behind `transparentAreaColorError` |
| `svgBytes` | exported SVG size | < 100 KB on flat fixtures |
| `wallClockMs` | measured around `vectorize()` | < 10 000 |
| `paletteSize` | length of the returned palette | — |
| `exemplar*Ratio` | our bytes / sub-paths / paths / MAE divided by the exemplar's | REFERENCE lines 80-83 |

**Why sub-paths.** `pathCount` is not a shape count: `src/engine/svg.ts` emits one
compound `<path>` per colour layer, so a thousand specks can hide inside a single
element and pass a "≤ 200 paths" bar by definition. `subPathCount` and
`tinySubPathRatio` are what REFERENCE's "not thousands of specks" actually means.

Per-fixture thresholds live in `fixtures/manifest.json` (generated by
`npm run fixtures`, derived from REFERENCE.md "Quality bar"); the photo fixture is
deliberately loose because continuous-tone images are not the target use case.

A fixture entry may also carry:

- `settings` — an override merged over `DEFAULT_SETTINGS` for that fixture only. The
  reference exemplar was produced at 8 colours with Smart anti-aliasing, Minimum Area
  5px² and Enhance on, so judging it at anything else would compare two different
  pictures.
- `compareTo` — the image fidelity is measured against, when that is not the source
  itself. Exactly one kind of fixture needs it: a noisy one. Speck removal is a feature
  (B4/B5 and the despeckle slider) and SSIM's variance term punishes it — the clean
  artwork scores 0.35 against the speckled version of itself — so measuring a denoised
  trace against the noise would reward reproducing every speck and call recovering the
  drawing a failure. `logo-noisy-512` is therefore scored against `logo-flat-512.png`,
  i.e. "did the artwork come back?", at the *flat* fixture's thresholds (MAE 8, SSIM 0.9).
- `exemplar` — a path (relative to `fixtures/`) to real the reference product output for the
  same source. The runner measures it through the identical pipeline and reports
  `exemplarBytesRatio` / `exemplarSubPathRatio` / `exemplarPathRatio` /
  `exemplarMeanColorErrorRatio`, gated by `maxBytesRatio` / `maxSubPathRatio` /
  `maxPathRatio` / `maxMeanColorErrorRatio`. This is REFERENCE's "blind A/B" turned
  into numbers, so critics do not have to eyeball crops.

  **An exemplar has to be registered against the source before it can be ratioed
  against.** `rasterizeExemplarContent` decides how, on the file's own declared size:

  - The real product writes the source's pixel dimensions into the capture when the
    drawing is already in source coordinates —
    `fox-sticker-clipart-8colors-smartAA.svg` says `width="1024" height="1024"` for a
    1024×1024 source — and then the only correct thing is to rasterize it as declared.
    It scores MAE 1.03 / SSIM 0.997 / ink recall 0.999 that way.
  - A capture that declares *anything else* has drawn its artwork inside a padded
    frame. The retired exemplar this was first measured on declared an 11520×9280
    viewBox for a 1046×833 source and used the top-left quarter of it, so rasterizing
    the declared box scored the real product MAE 63.55 and
    `exemplarMeanColorErrorRatio` came out 0.08 for anything we emitted — the
    fidelity half of the gate measured nothing. Those are rendered at 2×, trimmed to
    the uniform border and resized to the source.

  Getting the discriminator backwards is not a small error in either direction:
  trimming the fox exemplar (a sticker with a 76.5 % transparent margin) crops it to
  the ink and stretches that to the frame, which scores the real product MAE 77.1 and
  puts its paw where our muzzle is. `meanColorErrorAsDeclared` keeps the straight
  viewBox number for context, and the stdout line names the size it rasterized at.
- `salientRegion` / `salientRegions` — `{ x, y, width, height }` in source pixels, or a list of
  `{ name, x, y, width, height }`. Every fidelity number
  is area-weighted, and REFERENCE's blind A/B is decided on the part of the picture a
  person looks at: the gold standard's face is 7 % of the canvas and three quarters of
  the rest of it is transparent, so losing the mouth curve and an eye moves whole-frame
  ink recall by hundredths and every gate stays green. A fixture that declares one gets `regionInkRecall` / `regionStrictInkRecall` /
  `regionMeanColorError` / `regionSsim` / `inkComponentRatio`, the crop written to
  `artifacts/region/<id>.png` (further boxes go to `artifacts/region/<id>-<name>.png`), and
  — when it also declares an exemplar — the exemplar's own region scores beside them.

  **A box may carry its own thresholds.** `salientRegions[].thresholds` accepts
  `maxMeanColorError`, `minSsim`, `minInkRecall`, `minStrictInkRecall`,
  `maxInkComponentRatio`, `maxForeignColorRatio`, `maxStrokeWidthCvRatio`,
  `maxBandFit`, `maxBandStep`, `maxBandStepExcess` and `maxBandFitRatio`,
  checked against that crop alone and
  reported as `region "<name>" <metric> …`. The aggregate gates read the *worst* crop,
  which is the right default and the wrong tool when two crops deserve different numbers:
  on `reference-fox-default` the aggregate colour-error bar is 12 because the muzzle
  scores 10.91, while the face carries its own bar of 10 and the muzzle and paw carry a
  ~0 colour-leak bar instead. One aggregate number cannot say all three.

  **A crop can be too big to ask the question.** The face box contains the head's own
  orange, so orange is a colour that crop legitimately has and orange specks inside the
  white muzzle are invisible to any measurement taken over it. The `muzzle`
  box (140×90 at 455,455 — the nose, the mouth arcs and the white around them) is where
  the crop's own palette is small enough for the question to have an answer: our run at
  the exemplar settings, our run at the defaults and the real exemplar all score 0.000 %
  foreign colour there, while the white-flattened variant of the same artwork scores
  0.46 % on the paw.

  **One box was not enough.** On the gold standard the face is where line art is lost and
  the *paw* is where a whole colour family can be lost — a warm brown sock, mean
  rgb(133,73,37), inside an orange leg inside a black outline, and exactly the kind of
  region a pre-trace ramp snapper collapses onto its neighbours' extremes. On the retired
  exemplar that failure shipped: with only the face declared, the instruments reported
  9 pass / 0 fail on a build whose default output rendered a warm brown paw pad a cool
  teal at region MAE 33.5. Gates read the **worst** region, so adding a box can only
  tighten a fixture, never loosen it.

### The D1 viewBox question

REFERENCE D1 describes the real product's SVG as "per-color `<g fill="rgb(...)">`
layers, 10× scaled viewBox", while this document requires `viewBox="0 0 w h"` in source
pixels because the instruments rasterize against it. Both cannot hold. The decision:
**adopt the `rgb(r,g,b)` fill notation, keep the 1× viewBox.** The 10× coordinate space
is a potrace-era artifact of the captured exemplar and carries no user-visible
behaviour, whereas the fill notation is what a diff against real output trips over.
`tests/engine/parity.test.mjs` and `tests/e2e/d5-export-formats.spec.ts` enforce the
notation; `tests/engine/engine.test.mjs` enforces the viewBox.

Local fixtures (see below) write the same four under `artifacts/local/` instead, so the
tracked contact sheet stays reproducible from a clone.

Side outputs for eyeballing: `artifacts/vector/<id>.svg`, `artifacts/raster/<id>.png`
(the re-rasterized SVG), `artifacts/diff/<id>.png` (absolute difference, ×4 amplified),
`artifacts/region/<id>.png` (the salient-region crop of the re-raster — the cheapest
image in the harness to read, and the one that settles the gold-standard A/B).

Exit codes: `0` everything measured passed · `1` something missed a threshold · `2` the
engine is still a stub · `3` the harness itself blew up.

**Sanity-check the instrument, not just the engine:** `npm run instruments:selftest` runs
the same pipeline against `instruments/reference-engine.mjs`, a deliberately naive
run-length tracer. It scores `meanColorError 0.00 / ssim 1.0000` on the flat fixtures
(pixel-exact geometry) and blows the economy budget with megabyte SVGs, 1025× the
exemplar's sub-path count and a curve-command ratio of exactly 0 — which is precisely
the tradeoff a real tracer has to beat, and a useful sanity check that the new
structural metrics point the right way. If the selftest stops scoring ~0 error, the
measurement chain is broken, not the engine.

## `npm run screenshots`

Launches the app with Playwright and walks: launch → load three fixtures → auto-vectorize
→ lower colour count → lower detail → open palette editor → candidate palette sizes →
Sketch → Drawing → Clipart detail level → noise reduction / anti-aliasing → advanced
vectorization (roundness, minimum area, overlap, circle detection) → stroked layers →
transparent background → switch image → enable enhance → toggle preview → side-by-side →
zoom in → zoom fit → export SVG. One labelled PNG per step in `artifacts/screenshots/`,
plus `manifest.json` recording `ok`/`skipped` and the reason. It never fails the run —
steps that aren't built yet are recorded as skipped and still screenshotted, so each lap
produces a comparable contact sheet and the `skipped` count is itself a progress metric.

Shots are captured at **1x device scale** (`--force-device-scale-factor=1`, plus a sharp
downscale to 1280 px as a backstop for HiDPI buffers), and `manifest.json` records
`shotWidth` / `capturedWidth` / `downscaledTo1x`. A retina 2560 px sheet costs an agent
roughly 4× the tokens of the 1280 px one and shows exactly the same UI.

## Token-lean output (read this before consuming the harness)

The instruments and the suite are read mostly by agents, and an agent that `Read`s a
whole report burns its context on JSON it did not need.

- **The stdout table is the interface.** `npm run instruments` prints one row per fixture
  plus a failure line per fixture; that is the full picture, and it is a few hundred
  tokens. Same for `npm test` — the reporter's summary is the answer.
- **Query the JSON, never read it whole.** `artifacts/metrics.json` is ~40 KB and
  `artifacts/e2e-results.json` is bigger. **Never `Read` either file in full** — open
  them only through a targeted query:

  ```bash
  jq -r '.results[] | select(.status=="FAIL") | "\(.id): \(.failures|join("; "))"' artifacts/metrics.json
  jq '.results[] | select(.id=="reference-fox") | .metrics.exemplarSubPathRatio' artifacts/metrics.json
  jq '.results[] | select(.id=="reference-fox") | {regionInkRecall:.metrics.regionInkRecall, vsExemplar:.metrics.regionInkRecallRatio}' artifacts/metrics.json
  jq -r '.results[] | select(.metrics.regions) | .id as $i | .metrics.regions[] | "\($i)/\(.name): strict \(.strictInkRecall) MAE \(.meanColorError)"' artifacts/metrics.json
  jq -r '.results[] | select(.metrics.regionForeignColorRatio) | "\(.id): leak \(.metrics.regionForeignColorRatio*100)%"' artifacts/metrics.json
  jq -r '.results[] | select(.metrics.paletteShortfall) | "\(.id): \(.metrics.paletteSize) of \(.settings.colorCount) delivered"' artifacts/metrics.json
  jq -r '.results[] | select(.metrics.layerWobbleRatio) | "\(.id): wobble \(.metrics.layerWobble) vs \(.metrics.exemplarLayerWobble) = \(.metrics.layerWobbleRatio)x"' artifacts/metrics.json
  jq -r '.suites[].specs[]? | select(.ok==false) | .title' artifacts/e2e-results.json
  grep -c '"status": "FAIL"' artifacts/metrics.json
  ```
- **Screenshots are the expensive artifact.** Read one deliberately chosen shot, not the
  sheet. `artifacts/screenshots/manifest.json` names every step, so pick by name first.
- **Diff images before full renders.** `artifacts/diff/<id>.png` says where a fixture is
  wrong in one glance; `artifacts/region/<id>.png` (plus `artifacts/region/<id>-<name>.png` for a
  fixture's further boxes) is a small crop of exactly the part that decides the
  gold-standard A/B; `artifacts/raster/<id>.png` is only worth opening
  once one of those has told you which fixture to look at.

## Fixtures

`npm run fixtures` regenerates everything from pure math with a seeded PRNG, so output is
reproducible. Shapes are drawn **without antialiasing**, so the flat fixtures contain
exactly six colours and palette assertions can be exact.

| file | what | why |
| --- | --- | --- |
| `logo-flat-512.png` | 512×512, 6 colours, hard edges | primary flat-colour target |
| `logo-noisy-512.png` | same mark + seeded speckle & 2×2 blobs | despeckle (B2) and enhance (B4) |
| `logo-flat-1024.png` | 1024×1024 version | responsiveness bar (< 10 s) |
| `photo-gradient-512x384.jpg` | continuous-tone JPEG | JPEG ingest; the non-target case |
| `shapes-256.bmp` | 24-bit uncompressed BMP | BMP ingest (A1) |
| `sticker-alpha-256.png` | 3 flat colours on a **fully transparent** background | the alpha channel — REFERENCE's sticker/decal use case. Every other generated fixture is opaque, which is how transparent-background tracing stayed broken for a lap |
| `unsupported-animation.gif` | valid 4×4 GIF89a | rejection (A2) — a real image the app must still refuse |
| `unsupported-notes.txt` | plain text | rejection (A2) |
| `reference/fox-sticker.png` | real 1024×1024 artwork, **76.5 % transparent** (**not** generated) | REFERENCE's gold-standard A/B source; instrumented three times, as `reference-fox` (8 colours + Smart AA + min-area 5 + Enhance — the settings the checked-in exemplar was captured at — exemplar `reference/fox-sticker-clipart-8colors-smartAA.svg`, regions = the face, the **muzzle** and the paw), `reference-fox-16c-nomerge` (16 colours + Enhance with `mergeThreshold: 0` — a bigger request with the colour fold explicitly turned off, see below) and `reference-fox-default` (**no `settings` key at all**, regions = face / muzzle / paw, each with its own bar — whatever `DEFAULT_SETTINGS` says today, on real artwork. The other rows pin a configuration, which is how the default a user actually gets went unmeasured while its output painted a region the wrong hue). On this artwork the defaults are also the Enhance-off configuration, so `-default` carries the default-settings economy ratios rather than a separate `-noenhance` row measuring the identical run twice |
| `reference/fox-sticker-white.png` | the same artwork, white-flattened (**not** generated) | the opaque counterpart, as `reference-fox-white`: same picture, same settings, no alpha, **absolute** bars only (there is no real-product capture of the flattened variant to ratio against). It is the control that attributes a difference to the ingest rather than the tracer — and it earns its keep, because the paw crop comes back with 0.46 % of its pixels painted a hue the source does not contain where the transparent source scores 0.000 % |
| `manifest.json` | ids, dimensions, per-fixture settings, exemplars, thresholds | consumed by the instruments |

`fixtures/reference/` is checked in, not generated: `npm run fixtures` lists those
entries and reports `MISSING` rather than trying to recreate them.

**Why a fixture row exists just to set `mergeThreshold: 0`.** `reference-fox` asks for 8
colours and gets 5, and the exemplar mostly justifies the number (the real product's own
capture carries seven `<g fill>` layers, but two pairs of them are inside the 32-unit halo
window that `maxNearDuplicateFills: 0` forbids us, which leaves five distinguishable
colours) — the panel, though, did not: the hint attributed the shortfall to "the cleanup
settings", and the only cleanup control that speaks about colour groups could not reach
it, because `src/engine/index.ts` computed `groupThreshold =
max(opts.mergeThreshold, opts.enhance ? 1 : 0)`. With Enhance on, dragging MERGE THRESHOLD
to 0 changed nothing. So `reference-fox-16c-nomerge` runs a *sixteen*-colour request with
the fold explicitly off and gates `maxPaletteShortfall: 3` — a ratchet on today's number
(5 delivered), not the fix. 2 is the number to aim at, because turning *Enhance* off
instead reaches 6 delivered on the same request with `nearDuplicateFillPairs` still 0, so
the target is known-reachable.

The `max(...)` is gone: `groupThreshold` is
`opts.mergeThreshold` and nothing else, and what Enhance does about quantization debris
instead is raise the *area* floors — a colour that only ever appears in 15×15 scraps loses
the scraps on the picture rather than its seat in the palette, and a layer the floor would
empty entirely is retraced at Minimum Area so no swatch names a colour the drawing does
not contain. `tests/engine/parity.test.mjs` asks the same question at the engine level.

libvips has no BMP loader, so `instruments/lib/decode.mjs` carries a small 24/32-bit BMP
decoder. The app itself doesn't need it — Chromium decodes BMP natively.

## Local fixtures — measuring against artwork we cannot ship

Some of the artwork this engine most needs to be measured against cannot be redistributed.
This repo is public; its original gold standard was a soft-shaded character illustration
plus the real the reference product capture of it, and both were purged from the tree **and from
git history** for licensing before the repo went public. That purge was correct and it
also deleted the only measurement of a whole class of failure — every fixture that
remains is *flat* clipart with a hard outline, so nothing here could see what a soft
gradient does to a quantizer, and the engine regressed by neglect on that class until a
band boundary was being drawn straight through a character's face.

The answer is not to re-commit the artwork. It is that **a file you may not redistribute
is still a file you may measure against.**

### The mechanism

- **`fixtures/local/` is git-ignored in its entirety** (`.gitignore`). Nothing under it is
  tracked — not the manifest, not the images, not a `.gitkeep`. That is deliberate: a
  tracked placeholder is a directory somebody can accidentally `git add -A` into, and the
  only safe rule for a public repo is that the path is invisible to git, full stop. Put
  your own assets there; nothing else has to happen.
- **The merge happens in the consumer, never in the generator.** If
  `fixtures/local/manifest.local.json` exists, `instruments/run-instruments.mjs` appends
  its `fixtures[]` to the tracked set at runtime (`loadFixtures()`). `npm run fixtures`
  does not know the directory exists, so nothing local can ever be written into the
  tracked `fixtures/manifest.json`.
- **Absence is never a failure.** No directory, no manifest, an unreadable manifest, a
  manifest naming an image that is not there — each of those logs at most one line and
  runs the tracked set exactly as it would have. CI and a fresh clone see zero difference:
  no rows, no skips, no exit code.
- **Local rows are labelled.** They print as `[local] <id>` in the table and in every
  stdout line, and their side outputs go to `artifacts/local/{vector,raster,diff,region}/`
  rather than beside the tracked ones — so nobody mistakes one of these numbers for
  something a reviewer can reproduce from a clone.
- A local row's gates are enforced like any other, and a local **failure** does fail the
  run. That is the point: the whole exercise is worthless if the numbers cannot go red.

### The schema

`manifest.local.json` is `{ "fixtures": [ … ] }` and each entry is exactly a tracked
manifest entry — `id`, `file`, `kind`, `format`, `width`, `height`, `supported`,
`settings`, `exemplar`, `compareTo`, `salientRegion(s)`, `thresholds`, `note` — with
**every path relative to `fixtures/local/`** rather than to `fixtures/`. Anything the
tracked manifest can say, this can say. Underscore-prefixed keys (`_doc`, `_note`,
`_assets`) are ignored by the runner and are where the local set documents itself, since
no reviewer will ever see the file.

```jsonc
{
  "fixtures": [{
    "id": "local-something",          // prints as "[local] local-something"
    "file": "something.png",          // fixtures/local/something.png
    "exemplar": "something.svg",      // fixtures/local/something.svg
    "supported": true,
    "settings": { "colorCount": 16, "enhance": true },
    "salientRegions": [{ "name": "face", "x": 300, "y": 200, "width": 360, "height": 200,
                         "thresholds": { "maxBandFit": 3.5 } }],
    "thresholds": { "meanColorError": 7, "maxMs": 10000 }
  }]
}
```

### What the local set is measuring today

The shaded character artwork and its real-product captures, as `local-snorlax` (16 colours
+ Enhance + Smart AA — the configuration the band defect was reported at) and
`local-snorlax-default` (`DEFAULT_SETTINGS`, no `settings` key). Both declare the face,
the muzzle and the paw pad. Everything they gate is a ratchet measured on the build that
introduced them, except the two band bars on the face crop, which are aspirational — see
`shadingBandQuality` above and the `_note` in the manifest.

### The ceiling, stated plainly

**The real product's "Enhance image with AI" is not a filter. It is generative
image-to-image re-illustration.** Captured from the live product on this subject, the
canvas it hands its own tracer has the busy background removed outright, the airbrushed
shading repainted as clean flat bands, the outlines redrawn at uniform weight, and the
whole thing resampled to a different size. Their tracer is then tracing art that is
*already flat*. That is why its band placement beats histogram quantization, and why its
own bands sit **further** from the source than ours do (`bandFit` 11.35 against our 3.30
on the face): it is not approximating the source, it has replaced it.

Ours is classical: edge-preserving smoothing, then quantization. So:

- The achievable goal for our Enhance path is to approximate the **flattening**, not the
  repaint. Get the band colours onto the mean of what they cover and stop inventing
  contrast at the seam — both of which are measurable (`bandFit`, `bandStepExcess`) and
  both of which moved.
- Shaded-art parity with the real product has a **structural ceiling** without a model, and
  chasing the last of it with classical tuning will cost flat art. The exemplar-relative
  band ratios on this subject are therefore reported, not gated; the absolute bars are what
  hold.
- `fixtures/local/snorlax-enhanced-input.png` is that captured canvas, kept as the evidence
  behind this paragraph.

And one tension worth naming, because it is ours and not theirs: the only classical way to
soften that seam further is to **keep** more of the ramp — three or four bands across the
face instead of two. The shaded artwork's ramp steps are rgb(240,228,217), rgb(224,212,201),
rgb(210,198,187), rgb(198,186,179), i.e. 26–31 RGB units apart, which is *inside* the
32-unit window `maxNearDuplicateFills: 0` calls a halo. That bar was written for flat art,
where two layers that close are one region split into a patchwork; on shaded art the same
two layers are the gradient. Nothing here resolves that today — the flat fixtures' bar wins,
and the seam is the price. Worth revisiting only with a fixture-kind-aware window, never by
loosening the flat bar.

## Engine interface contract

The tracer must be a **pure module** — no Electron, no DOM, no `fs`, no network — because
the instruments import it directly from Node and the renderer runs it in a worker.
Implement the functions in [`src/engine/index.ts`](../src/engine/index.ts); types are in
[`src/engine/types.ts`](../src/engine/types.ts). **Do not change these signatures** without
updating `instruments/run-instruments.mjs` and this document in the same commit.

```ts
interface RgbColor { r: number; g: number; b: number }          // 0..255

interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;   // tightly packed RGBA, row-major, top-left origin
}

interface VectorizeSettings {
  colorCount: number;        // 2..64
  detail: number;            // 0..100  (0 = simplified, 100 = follow every pixel)
  smoothing: number;         // 0..100  (0 = polylines, 100 = max curve fitting)
  despeckle: number;         // 0..100  (0 = keep every speck)
  enhance: boolean;          // denoise + colour simplification preprocessing
  palette?: RgbColor[] | null;  // explicit palette overrides the computed one

  // --- REFERENCE B2-B6. Names and value domains are fixed by docs/TESTIDS.md,
  // because the e2e suite drives them through <select>/<input> values of the
  // same spelling.
  preset?: 'clipart' | 'photo' | 'sketch' | 'drawing';          // B2, default 'clipart'
  detailLevel?: 'maximum'|'ultra'|'very-high'|'high'|'medium'|'low'|'minimum';  // B2
  bwThreshold?: number;      // 0..255, Drawing preset luminance split          // B2
  disabledColors?: number[]; // palette indices to omit entirely (transparency) // B3
  mergeThreshold?: number;   // percent coverage; groups smaller than it merge   // B3
  sortOrder?: 'coverage' | 'brightness' | 'hue';                                // B3
  noiseReduction?: 'off' | 'low' | 'high';                                      // B4
  antiAliasing?: 'off' | 'smart' | 'mid';   // B4, default 'smart' (see below)
  roundness?: 0 | 1 | 2;     // three curve-fitting levels                      // B5
  minArea?: 0 | 5 | 90;      // px^2 speck removal                              // B5
  overlap?: 'full' | 'high'; // whether lower layers are painted under upper    // B5
  circleDetection?: boolean;                                                    // B5
  resultStyle?: 'filled' | 'stroked';                                           // B6
}

type VectorizePhase = 'preprocess'|'quantize'|'trace'|'simplify'|'serialize'|'done';
type ProgressCallback = (p: { phase: VectorizePhase; progress: number }) => void;

interface VectorizeResult {
  svg: string;               // complete standalone SVG; viewBox = "0 0 width height"
  palette: RgbColor[];        // ordered by descending pixel coverage
  pathCount: number;
  width: number;
  height: number;
  durationMs: number;
  sourceColors: number;      // palette size BEFORE our own colour folds — lets the
                             // UI tell "the image ran out" from "a cleanup merged
                             // them" (docs/TESTIDS.md `color-count-hint`)
  slots: RgbColor[];         // one entry per colour SLOT of the engine's segmentation,
                             // in the same coverage rank, duplicates included.
                             // `palette` is this with duplicates collapsed. An edit is
                             // expressed against THIS array, because it is what
                             // `settings.palette` is positionally matched to: hand back
                             // the deduped palette after a merge and k-1 colours land on
                             // k slots, shifting every colour past the merge
}

// The five functions to implement:
function vectorize(
  image: RasterImage,
  settings?: VectorizeSettings,
  onProgress?: ProgressCallback,
): Promise<VectorizeResult>;

function computePalette(image: RasterImage, colorCount: number): Promise<RgbColor[]>;
function enhanceImage(image: RasterImage): Promise<RasterImage>;
function toEps(result: VectorizeResult): string;
function toDxf(result: VectorizeResult, options?: { curves?: 'splines' | 'lines' }): string;
// 'splines' (default) = R2000 with degree-3 SPLINE entities, curve geometry intact;
// 'lines' = R12 with everything flattened into POLYLINE vertices. Both variants are
// downloads the real product offers (fixtures/reference/OBSERVED-UI.md).
// The renderer MUST expose the choice (`dxf-curves`, docs/TESTIDS.md): an option no
// control can reach is not a feature the product has. If that is not wanted, delete the
// parameter, this line, the testid and tests/e2e/d3-dxf-variants.spec.ts together.

// Already implemented, no need to touch:
const DEFAULT_SETTINGS: VectorizeSettings;   // colorCount 8, detail 60, smoothing 50,
                                             // despeckle 20, antiAliasing 'smart'
function serialize(result: VectorizeResult, format: 'svg'|'eps'|'dxf'): string;
function isSupportedInput(nameOrMime: string): boolean;
const SUPPORTED_INPUT_EXTENSIONS: readonly string[];
const SUPPORTED_INPUT_MIME_TYPES: readonly string[];
```

Obligations beyond the types:

1. **Deterministic.** Same `(image, settings)` ⇒ byte-identical `svg`. Otherwise the
   instruments cannot distinguish a regression from noise. Seed anything stochastic.
2. **Non-blocking.** Call `onProgress` at least once per phase and yield between phases;
   the renderer runs `vectorize` off the UI thread (worker or `ipcRenderer` to a utility
   process). REFERENCE B1 requires the UI to stay responsive and the e2e suite probes it.
3. **`svg` is the deliverable.** It is what the preview shows (C3) and what SVG export
   writes (D1) — the same string, unmodified.
4. **`viewBox="0 0 width height"`** in source pixels; the instruments rasterize against it.
5. **Decoding is not the engine's job — but the alpha channel is.** Callers hand over
   RGBA: the renderer via canvas `getImageData()`, the instruments via sharp / the
   bundled BMP decoder plus `canvasIngest()`. The `A` byte is data, not padding: a
   canvas returns `(0,0,0,0)` for a transparent pixel, so an engine that reads only RGB
   sees a black rectangle and traces REFERENCE's whole sticker/decal use case with an
   invented opaque background. Whether the engine drops those pixels from the drawing or
   flattens them onto white is its choice; treating them as opaque black is not one.
   Gated by `maxTransparentAreaColorError` and `tests/engine/alpha.test.mjs`.
6. **Palette overrides drive the palette editor.** Change / merge / remove all reduce to
   "re-vectorize with this explicit `settings.palette`" — and therefore an override is an
   *output colour table*, never a new clustering target. **`vectorize(img, {…s, palette:
   r.palette})` must return `r.svg` with only the fills possibly changed**, at every
   setting, on every image. Cluster at `presetColorCount(opts)` and run the identical fold
   sequence whether or not `opts.palette` is set, apply the override after the folds by
   coverage rank (the order the palette editor displays), and treat a shorter override as
   a remove/merge of the trailing slots rather than as a new `k`.

`EngineNotImplementedError` remains exported for the instruments' `not-implemented`
status, but nothing throws it any more — every function above is implemented.

### How the implementation is put together

`src/engine/index.ts` is the public surface; the stages behind it live in their own
modules so each can be read on its own.

| module | responsibility |
| --- | --- |
| `preprocess.ts` | "Enhance" (median denoise → colour simplification → majority filter → snap back onto source colours), Noise Reduction, and the pixel-level anti-aliasing ramp snap. |
| `color.ts` | Histogram → median cut → Lloyd refinement → dark-ink reservation → index image → despeckle, plus the output colour-group merges and sort orders. |
| `trace.ts` | Boundary extraction: imagetracerjs's edge-node walk gives the *exact* pixel-corner polygon of each region, then Minimum Area filters it. |
| `fit.ts` | Corner detection, staircase centring, Schneider cubic fitting and circle detection — everything that turns a boundary polygon into smooth geometry. |
| `path.ts` | The geometry model, the path-data writer, and the parser the exporters read back. |
| `svg.ts` | SVG serialization: a backdrop `<rect>` plus one compound path (and any detected `<circle>`s) per colour, each colour wrapped in its own `<g fill="rgb(…)">` layer (REFERENCE D1). |
| `eps.ts` / `dxf.ts` / `pdf.ts` | Geometry-level converters. They recover shapes by parsing the result's SVG — which is what keeps preview, SVG, EPS, DXF and PDF the same drawing. PNG is the exception: it is a raster, so the renderer draws the exported SVG into a canvas (`src/renderer/lib/raster.ts`). |

Two notes for anyone tuning it:

- **A palette override is an output colour table, not a set of cluster centres.**
  Clustering always comes from the image with `k = presetColorCount(opts)`, and every
  cleanup and fold runs identically whether or not `settings.palette` is set. Only then
  is slot *i* painted with `palette[i]` (`repaintSlots` + the "6. Repaint" step of
  `vectorize`). That is what makes "change this swatch" repaint a region instead of
  stranding the new colour — and what keeps a *no-op* edit a no-op. A shorter override is
  a remove: the slots it does not reach are painted with the nearest colour that survived,
  which is why nothing is re-quantized behind the user's back.
- **Trace the exact boundary, then fit it.** imagetracerjs's own `internodes` +
  `batchtracepaths` place every node at the midpoint between two pixel corners, which
  halves every corner, erodes hairlines and collapses a one-pixel region to zero area —
  the reason an earlier version of this engine carried a stroke-compensation table and a
  pixel-rebuild fallback. The engine now takes `pathscan`'s integer pixel-corner polygon
  (area-exact by construction) and does its own fitting in `fit.ts`, so those crutches
  are gone: measured on the flat fixture, mean colour error fell 0.80 → 0.74 while the
  curve-command ratio rose 0.31 → 0.88 and the SVG shrank.
- **Every command letter is written out.** SVG lets a repeated command drop its letter;
  this writer does not, because `curveCommandRatio` (and any human reading the file)
  counts letters, and eliding them makes a staircase of a thousand `l` segments look
  like a handful of commands. It costs about a byte per segment.
- **Enhance is a bundle, not a filter.** It turns on the denoise pass *and* smart
  anti-aliasing, folds away colour groups under 1 % coverage, raises the minimum region
  area to one ten-thousandth of the canvas, and applies half of that number as a
  *document* floor at trace time (a bounding-box test, so a hairline still clears it —
  it removes the small lobes a ragged edge sheds, which are attached to their parent
  region and therefore invisible to any despeckle). That is what makes the gold-standard
  A/B land inside REFERENCE's 3×/5× economy limits at the exemplar's own settings.
- **Transparency is a group with no colour.** `opacityMask()` splits the input at
  alpha 128; those pixels are excluded from the histogram (so they cannot win a palette
  slot), carry `TRANSPARENT_INDEX` through the whole index image (so they join no layer
  and no despeckle merges them away), and suppress the backdrop `<rect>` entirely — the
  layers no longer partition the canvas, so a full-bleed rect would be an invented
  background rather than a free optimisation. Their RGB is still *read* by the 3×3
  neighbourhood filters, so `bleedTransparent()` first dilates the drawn colours
  outwards a few pixels and flattens the rest to the mean drawn colour: a canvas hands
  back `(0,0,0,0)`, and without the bleed every sticker grows a black bruise round its
  edge where the median and anti-aliasing passes read that as artwork.
- **A fold re-centres its survivor; it does not crown a winner.** The halo fold
  (`mergeSimilarColors`, run by Smart anti-aliasing) collapses palette entries closer than
  `HALO_FOLD_PERCENT`. It used to keep the *first* entry of each group — which, since the
  palette arrives in coverage order, means the biggest histogram peak repaints everything
  it swallowed with its own colour. On flat art that is invisible: the near-duplicates it
  folds are a halo one unit wide. On *shaded* art it is the defect: a soft ramp arrives
  here as four modes, whichever of them covers the most of the whole image eats the other
  three, and a band whose pixels average rgb(210,198,188) came back rgb(197,186,179) —
  13 units too dark across 44 % of a character's face, the muddy grey a person names
  instantly and that no other instrument here could see (outline fine, leak 0 %, wobble
  under the exemplar's, and a 13-unit miss over half a crop is inside every colour-error
  bar). The grouping decision is still made on the original colours, so the fold cannot
  fold *differently* and the colour count every existing gate was measured against is
  unchanged; only the survivor moves, to the coverage-weighted mean of its group. Measured:
  the shaded fixture's face went from `bandFit` 6.16 / `bandStepExcess` 16.5 to 3.30 / 8.9
  and its region colour error from 12.54 to 10.92, while every fox crop improved or held
  (face 4.07 → 3.91, paw 1.35 → 1.20, muzzle 6.39 → 6.34).

  Perceptual-space clustering (Oklab/CIELab) was the other candidate and is the wrong tool
  *here*, for a reason worth writing down: both compress lightness at the top of the range,
  so a cream ramp gets **fewer** cluster centres in Lab than in RGB, not more — the
  opposite of what this artwork needs. The existing note on `assignDist` records the other
  half of the same finding (Lab ΔE stretches the dark end so far that ink pixels leave the
  ink slot: whole-frame ink recall 0.989 → 0.677).
- **Cleanups must not eat line art.** A one-pixel stroke is a *minority* in every 3×3
  window it passes through, so both the median filter and the majority filter would
  erase exactly the strokes REFERENCE's use cases are made of. Both now spare a pixel
  whose two opposite neighbours share its colour (`continuesRun` / `continuesColorRun`):
  an impulse has no such support, a line always does. Curve fitting had the same bug in
  continuous form — an absolute tolerance is a large fraction of a thin shape — so the
  fit tolerance is capped at 30 % of the contour's own mean thickness (`2·area/
  perimeter`). Together those took ink recall on the gold standard from 0.909 to 0.942.

## Environment caveats

- **macOS deletes an unsigned Electron.app on first launch.** On recent macOS the
  freshly-extracted `node_modules/electron/dist/Electron.app` is removed by Gatekeeper the
  moment you exec it — the symptom is `spawn .../Electron ENOENT` on every test even though
  the file was there a second ago. `scripts/verify-electron.mjs` runs on `postinstall`,
  detects it, strips xattrs and applies an ad-hoc signature. If you ever see that ENOENT,
  run `npm run postinstall` (or `codesign --force --deep --sign - node_modules/electron/dist/Electron.app`).
- **Electron's own postinstall can silently no-op** in sandboxed installs, leaving `dist/`
  with only licence files. The same guard script re-runs `node_modules/electron/install.js`.
- **No browser download needed.** The suite uses `_electron`; skip `npx playwright install`.
- **Linux/CI** needs a display for Electron — wrap `npm test` in `xvfb-run -a`.
- **Everything else is offline** after `npm install`: sharp and resvg ship prebuilt
  binaries, fixtures are generated locally, and the app makes no network calls at runtime
  (the renderer CSP in `src/renderer/index.html` enforces `default-src 'self'`).
- `artifacts/` is git-ignored; it is fully regenerable from the scripts above.
