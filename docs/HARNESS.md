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
| `npm test` | Playwright acceptance suite (`pretest` builds first). |
| `npm run test:engine` | Engine contract tests (`node --test`, pure Node). Determinism, setting semantics, palette-override behaviour, EPS/DXF structure. |
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

Selectors are `data-testid` only. The full DOM contract is
[docs/TESTIDS.md](./TESTIDS.md) — read it before building UI, it is what makes the app and
the tests converge.

Reports land in `artifacts/e2e-results.json` (machine-readable), `artifacts/e2e-report/`
(HTML) and `artifacts/test-results/` (traces + failure screenshots).

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

Reported per fixture (`artifacts/metrics.json`):

| field | meaning | REFERENCE bar |
| --- | --- | --- |
| `meanColorError` | mean absolute per-pixel error over R,G,B, 0..255 | < 8 on flat fixtures |
| `rmsColorError`, `psnrDb` | context for the above | — |
| `ssim` | mean windowed structural similarity (8×8 windows, stride 4, luma) | ≥ 0.90 on flat fixtures |
| `pixelMismatchRatio` | fraction of pixels off by > 12 in any channel | — |
| `pathCount` / `shapeCount` | `<path>` count / all drawable elements | ≤ 200 on flat fixtures |
| `svgBytes` | exported SVG size | < 100 KB on flat fixtures |
| `wallClockMs` | measured around `vectorize()` | < 10 000 |
| `paletteSize` | length of the returned palette | — |

Per-fixture thresholds live in `fixtures/manifest.json` (generated, derived from
REFERENCE.md "Quality bar"); the photo fixture is deliberately loose because continuous-tone
images are not the target use case.

Side outputs for eyeballing: `artifacts/vector/<id>.svg`, `artifacts/raster/<id>.png`
(the re-rasterized SVG), `artifacts/diff/<id>.png` (absolute difference, ×4 amplified).

Exit codes: `0` everything measured passed · `1` something missed a threshold · `2` the
engine is still a stub · `3` the harness itself blew up.

**Sanity-check the instrument, not just the engine:** `npm run instruments:selftest` runs
the same pipeline against `instruments/reference-engine.mjs`, a deliberately naive
run-length tracer. It scores `meanColorError 0.00 / ssim 1.0000` on the flat fixtures
(pixel-exact geometry) and blows the economy budget with megabyte SVGs — which is exactly
the tradeoff a real tracer has to beat. If the selftest stops scoring ~0 error, the
measurement chain is broken, not the engine.

## `npm run screenshots`

Launches the app with Playwright and walks: launch → load three fixtures → auto-vectorize
→ lower colour count → lower detail → open palette editor → switch image → enable enhance
→ toggle preview → side-by-side → zoom in → zoom fit → export SVG. One labelled PNG per
step in `artifacts/screenshots/`, plus `manifest.json` recording `ok`/`skipped` and the
reason. It never fails the run — steps that aren't built yet are recorded as skipped and
still screenshotted, so each lap produces a comparable contact sheet.

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
| `unsupported-animation.gif` | valid 4×4 GIF89a | rejection (A2) — a real image the app must still refuse |
| `unsupported-notes.txt` | plain text | rejection (A2) |
| `manifest.json` | ids, dimensions, thresholds | consumed by the instruments |

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
5. **Decoding is not the engine's job.** Callers hand over RGBA: the renderer via canvas
   `getImageData()`, the instruments via sharp / the bundled BMP decoder.
6. **Palette overrides drive the palette editor.** Change / merge / remove all reduce to
   "re-vectorize with this explicit `settings.palette`".

`EngineNotImplementedError` remains exported for the instruments' `not-implemented`
status, but nothing throws it any more — every function above is implemented.

### How the implementation is put together

`src/engine/index.ts` is the public surface; the stages behind it live in their own
modules so each can be read on its own.

| module | responsibility |
| --- | --- |
| `preprocess.ts` | "Enhance" — 3×3 median denoise, colour simplification, majority filter. |
| `color.ts` | Histogram → median cut → Lloyd refinement → index image → despeckle. |
| `trace.ts` | Contour tracing via imagetracerjs's low-level pipeline; stroke banding and speck reconstruction. |
| `path.ts` | The geometry model, the compact path-data writer, and the parser the exporters read back. |
| `svg.ts` | SVG serialization: a backdrop `<rect>` plus one compound path per colour per stroke band. |
| `eps.ts` / `dxf.ts` | Geometry-level converters. They recover shapes by parsing the result's SVG — which is what keeps preview, SVG, EPS and DXF the same drawing. |

Two notes for anyone tuning it:

- **A palette override is an output colour table, not a set of cluster centres.**
  Clustering always comes from the image with `k = palette.length`; slot *i* is then
  painted with `palette[i]`. That is what makes "change this swatch" repaint a region
  instead of stranding the new colour (see the comment in `vectorize`).
- **Sub-pixel contours need help.** imagetracerjs puts nodes at midpoints between pixel
  corners, so a one-pixel region collapses to a zero-area contour that a fill renders as
  nothing. `trace.ts` rebuilds those from the index image as exact pixel squares, and
  strokes whatever thin contours remain. Removing that costs ~0.11 SSIM on the noisy
  fixture.

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
