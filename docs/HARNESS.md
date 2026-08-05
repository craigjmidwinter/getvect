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
| `npm test` | Engine contract tests **then** the Playwright acceptance suite (`pretest` builds first). The engine tests run first because they are the fidelity contracts: if the picture regressed, the UI specs' green is not worth reading. |
| `npm run test:engine` | Engine contract tests (`node --test`, pure Node). Four files: `engine.test.mjs` (determinism, setting semantics, palette overrides, SVG grouping, EPS/DXF/PDF structure — must stay green), `parity.test.mjs` (the B2-B6 settings, D1 fill notation, D3 DXF colour distinctness and curve survival), `rendered.test.mjs` (rasterizes output: does the *picture* change, is it curve-fitted, is it economical in shapes, does it hold up against the exemplar), `alpha.test.mjs` (the input alpha channel: a transparent background must not be traced as an opaque one). |
| `npm run test:headed` | Same, with a visible window. |
| `npm run fixtures` | Regenerates `fixtures/` deterministically. |
| `npm run instruments` | Measures the app engine on every fixture. |
| `npm run instruments:selftest` | Measures the naive `instruments/reference-engine.mjs` instead — proves the measurement chain itself works. |
| `npm run screenshots` | Drives the app through load → vectorize → settings → export, capturing labelled PNGs. |
| `npm run clean` | Removes `dist/`, `test-results/`, `playwright-report/`. |

Useful environment variables:

- `PW_WORKERS=1` — serialize the e2e suite when debugging.
- `GETVECT_E2E=1` + `GETVECT_EXPORT_DIR=/tmp/x` — makes the main process skip the native
  save dialog and write exports to that directory. Set automatically by the harness.
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
| `tests/e2e/c-preview-interaction.spec.ts` | **C1** preview never blanks, busy overlay is centred · **C2** wheel zoom, pan clamping, controls inert when empty |
| `tests/e2e/d4-export-status.spec.ts` | **D4** export row does not re-flow · `data-last-export-path` invalidation · live `export-size` |
| `tests/e2e/q-decode-parity.spec.ts` | **quality-bar** a transparent PNG exports without an invented background · the app's exported SVG equals `engine.vectorize()` run headlessly on the same file (byte-identical on the flat fixture, structurally on the gold-standard one) |
| `tests/e2e/a2-decode-failure.spec.ts` | **A2** a file that decodes to nothing leaves no `image-list-item`, does not poison the workspace, and does not leave a stale `export-size` |
| `tests/e2e/c2-resize-fit.spec.ts` | **C2** shrinking the window re-fits the preview; a zoom the user chose survives a resize |
| `tests/e2e/b-controls-affordance.spec.ts` | **B2** Drawing disables the colour controls it cannot use · **B3** `merge-threshold` / `color-sort` are on screen at the default window size, colour-count hint is not clipped |

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

### One decode contract

The engine is handed `canvasIngest(decodeImageFile(file))` — the *same pixels the
renderer's canvas ingest produces*, including `(0,0,0,0)` for every fully transparent
pixel — while fidelity is judged against `flattenOnWhite(...)` of the same file.

This is not a detail. For one whole lap the instruments fed `vectorize()` a
white-flattened image no UI could produce, and reported `reference-snorlax` passing at
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
| `inkRecall` | fraction of the source's *ink* pixels (luma < 60) still darker than 128 in the re-raster — line art is too few pixels for MAE/SSIM to notice when a cleanup pass deletes it | ≥ 0.94 (snorlax) / ≥ 0.97 flat |
| `pathCount` / `shapeCount` | `<path>` count / all drawable elements | ≤ 200 on flat fixtures |
| `subPathCount` | `M`/`m` starts across every `d` attribute — the **honest shape count** | ≤ 200 flat / ≤ 1200 noisy |
| `tinySubPathRatio` | share of sub-paths whose bounding box is ≤ 1.5 px in both axes, i.e. single-pixel specks | < 0.02 flat / < 0.1 noisy |
| `curveCommandRatio` | `[CcSsQqTtAa] / ([CcSsQqTtAa] + [LlHhVv])` — "smooth curve-fitted outlines (no pixel staircase)" made countable | ≥ 0.5 (the exemplar scores 0.639) |
| `cubicCount` | cubic Bézier segments | — |
| `layerCount` | `<g fill>` colour layers | — |
| `nearDuplicateFillPairs` | pairs of colour layers within RGB distance 24 — the anti-aliasing halo signature | 0 on flat fixtures |
| `perColorCoverageDelta` | max change in a palette colour's area fraction between source and re-raster; catches hairline erosion that MAE/SSIM average away | ≤ 0.01 on flat fixtures |
| `sourceTransparentRatio` | share of source pixels with alpha < 128 | context (0.33 for snorlax, 0.60 for the sticker) |
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
  reference exemplar was produced at roughly 16 colours with Enhance on, so judging it
  at the 8-colour default would compare two different pictures.
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

### The D1 viewBox question

REFERENCE D1 describes the real product's SVG as "per-color `<g fill="rgb(...)">`
layers, 10× scaled viewBox", while this document requires `viewBox="0 0 w h"` in source
pixels because the instruments rasterize against it. Both cannot hold. The decision:
**adopt the `rgb(r,g,b)` fill notation, keep the 1× viewBox.** The 10× coordinate space
is a potrace-era artifact of the captured exemplar and carries no user-visible
behaviour, whereas the fill notation is what a diff against real output trips over.
`tests/engine/parity.test.mjs` and `tests/e2e/d5-export-formats.spec.ts` enforce the
notation; `tests/engine/engine.test.mjs` enforces the viewBox.

Side outputs for eyeballing: `artifacts/vector/<id>.svg`, `artifacts/raster/<id>.png`
(the re-rasterized SVG), `artifacts/diff/<id>.png` (absolute difference, ×4 amplified).

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
  `artifacts/e2e-results.json` is bigger. Use targeted queries:

  ```bash
  jq -r '.results[] | select(.status=="FAIL") | "\(.id): \(.failures|join("; "))"' artifacts/metrics.json
  jq '.results[] | select(.id=="reference-snorlax") | .metrics.exemplarSubPathRatio' artifacts/metrics.json
  jq -r '.suites[].specs[]? | select(.ok==false) | .title' artifacts/e2e-results.json
  grep -c '"status": "FAIL"' artifacts/metrics.json
  ```
- **Screenshots are the expensive artifact.** Read one deliberately chosen shot, not the
  sheet. `artifacts/screenshots/manifest.json` names every step, so pick by name first.
- **Diff images before full renders.** `artifacts/diff/<id>.png` says where a fixture is
  wrong in one glance; `artifacts/raster/<id>.png` is only worth opening once the diff
  has told you which fixture to look at.

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
| `reference/snorlax.png` | real 1046×833 artwork (**not** generated) | REFERENCE's gold-standard A/B source; instrumented twice, as `reference-snorlax` (16 colours, exemplar `reference/snorlax.svg`) and `reference-snorlax-6c` (6 colours, exemplar `reference/snorlax-clipart-6colors-min90.svg`) |
| `manifest.json` | ids, dimensions, per-fixture settings, exemplars, thresholds | consumed by the instruments |

`fixtures/reference/` is checked in, not generated: `npm run fixtures` lists those
entries and reports `MISSING` rather than trying to recreate them.

libvips has no BMP loader, so `instruments/lib/decode.mjs` carries a small 24/32-bit BMP
decoder. The app itself doesn't need it — Chromium decodes BMP natively.

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
  antiAliasing?: 'off' | 'smart' | 'mid';                                       // B4
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
function toDxf(result: VectorizeResult): string;

// Already implemented, no need to touch:
const DEFAULT_SETTINGS: VectorizeSettings;   // colorCount 8, detail 60, smoothing 50, despeckle 20
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
   "re-vectorize with this explicit `settings.palette`".

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
  Clustering always comes from the image with `k = palette.length`; slot *i* is then
  painted with `palette[i]`. That is what makes "change this swatch" repaint a region
  instead of stranding the new colour (see the comment in `vectorize`).
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
