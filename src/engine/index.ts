/**
 * GetVect vectorization engine — PUBLIC INTERFACE.
 *
 * This module is intentionally pure: no Electron, no DOM, no filesystem, no
 * network. It is imported by
 *   - the renderer (via a worker / IPC call) to produce previews and exports, and
 *   - `instruments/run-instruments.mjs` (via `dist/engine/index.js`) to measure
 *     fidelity headlessly.
 *
 * Pipeline (each stage is a separate module so it can be reasoned about alone):
 *
 *   preprocess  src/engine/preprocess.ts  optional denoise + colour simplification
 *   quantize    src/engine/color.ts       histogram → median cut → Lloyd → indices
 *   despeckle   src/engine/color.ts       drop sub-threshold connected regions
 *   trace       src/engine/trace.ts       imagetracerjs contour scan + curve fit
 *   serialize   src/engine/svg.ts         a backdrop rect + a compound path per colour
 *   convert     src/engine/eps.ts, dxf.ts geometry-level EPS / DXF from the SVG
 *
 * Do NOT change the exported signatures — the e2e suite and the instruments
 * harness are written against them. If a signature genuinely has to change,
 * update docs/HARNESS.md and instruments/run-instruments.mjs in the same commit.
 */

import {
  TRANSPARENT_INDEX,
  computePaletteSync,
  coverageOf,
  despeckleIndices,
  mapToPalette,
  mergeSimilarColors,
  mergeSmallGroups,
  normalizePalette,
  opacityMask,
  packRgb,
  remapIndices,
  sortedOrder,
  toBlackAndWhite,
  toGrayscale,
} from './color';
import { resultToDxf, type DxfOptions } from './dxf';
import { resultToEps } from './eps';
import { resultToPdf } from './pdf';
import {
  bleedTransparent,
  cloneRaster,
  deAntialias,
  enhanceSync,
  majorityFilter,
  reduceNoise,
  regularizeBoundaries,
} from './preprocess';
import { renderSvg } from './svg';
import { maskForIndex, traceMask, type TraceOptions, type TracedLayer } from './trace';
import {
  EngineNotImplementedError,
  type DetailLevel,
  type ProgressCallback,
  type RasterImage,
  type ResolvedSettings,
  type RgbColor,
  type VectorizePhase,
  type VectorizeResult,
  type VectorizeSettings,
} from './types';

export * from './types';
export { hexOf, parseHex, rgbOf } from './color';

/** Input formats the app accepts (REFERENCE A1/A2). */
export const SUPPORTED_INPUT_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.bmp'];
export const SUPPORTED_INPUT_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/x-ms-bmp',
];

/**
 * Export formats (REFERENCE D1-D3, D5).
 *
 * `png` is the odd one out: it is a raster, so the engine cannot produce it —
 * rasterization needs a renderer (the app uses a canvas; see
 * src/renderer/lib/raster.ts). `VectorExportFormat` is the subset `serialize()`
 * can turn into a text document.
 */
export type VectorExportFormat = 'svg' | 'eps' | 'dxf' | 'pdf';
export type ExportFormat = VectorExportFormat | 'png';
export const VECTOR_EXPORT_FORMATS: readonly VectorExportFormat[] = ['svg', 'eps', 'dxf', 'pdf'];
export const EXPORT_FORMATS: readonly ExportFormat[] = [...VECTOR_EXPORT_FORMATS, 'png'];

/** MIME type per export format — used for the save dialog and for blobs. */
export const EXPORT_MIME: Record<ExportFormat, string> = {
  svg: 'image/svg+xml',
  eps: 'application/postscript',
  dxf: 'image/vnd.dxf',
  pdf: 'application/pdf',
  png: 'image/png',
};

/**
 * Defaults used for the automatic vectorization that runs on image load
 * (REFERENCE B1). The instruments harness measures with exactly these unless
 * a fixture overrides them.
 */
export const DEFAULT_SETTINGS: ResolvedSettings = {
  colorCount: 8,
  detail: 60,
  smoothing: 50,
  despeckle: 20,
  enhance: false,
  palette: null,
  // B2 — flat artwork is the primary target, so Clipart is the default model.
  // Detail Level `high` is the neutral step: it multiplies the numeric Detail
  // slider by 1, so both controls stay meaningful (see `detailFor`).
  preset: 'clipart',
  detailLevel: 'high',
  bwThreshold: 128,
  // B4 — Noise Reduction is off by default: it is a correction, and a
  // correction nobody asked for is a surprise.
  noiseReduction: 'off',
  /**
   * Anti-aliasing defaults to Smart, because that is what the real product
   * does: `fixtures/reference/OBSERVED-UI.md` records "Smart AA was ON by
   * default here" for a plain clipart upload, and its measured effect at
   * otherwise identical settings is 354 paths -> 67 (-81 %). Ours is the same
   * shape of win — 1747 sub-paths -> 603, 396 KB -> 160 KB on the gold-standard
   * artwork — so shipping it off by default meant the configuration a user
   * actually gets was the one nothing was tuned for.
   *
   * It is a *default*, not a bundle member: `enhance` no longer forces it on
   * (see `smartAa` below), so "Anti-aliasing: Off" means off whatever else is
   * ticked.
   */
  antiAliasing: 'smart',
  // B5 — the reference product's own defaults: middle roundness, 5px² specks
  // dropped.
  roundness: 1,
  minArea: 5,
  /**
   * Overlap stays `high` — each layer trimmed to its own pixels.
   *
   * `full` used to measure better on boundary raggedness, and it costs one of
   * REFERENCE's own controls to get there: a stacked layer's mask is the union
   * of itself and everything painted after it, so B5's circle detection can no
   * longer see a disc as a disc, and every layer inherits the outline of every
   * speck above it. The bottom layer gets the benefit without the price — see
   * `silhouetteLayer` below, which now hands it to the INK layer, where the
   * saving is largest (2.87 mean layer compactness against the real product's
   * 2.67, from 3.33 when the dominant colour had it and the linework was
   * traced as a network of ribbons).
   */
  overlap: 'high',
  circleDetection: false,
  resultStyle: 'filled',
  disabledColors: [],
  mergeThreshold: 0,
  sortOrder: 'coverage',
};

// --- setting → algorithm parameter mapping ---------------------------------
//
// The four sliders are the whole user-facing surface of the engine, so the
// mapping from 0..100 to tracer parameters is spelled out here rather than
// scattered through the pipeline. Each one must observably change the output
// across its whole range (REFERENCE B2).

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const norm = (v: number) => clamp(Number.isFinite(v) ? v : 0, 0, 100) / 100;

/**
 * Detail Level (B2) × the Detail slider.
 *
 * The enum is a multiplier rather than a replacement so the two controls cannot
 * contradict each other: `high` is 1.0 (neutral), `maximum` pushes the slider
 * toward every pixel step, `minimum` collapses it to loose shapes.
 */
const DETAIL_LEVEL_FACTOR: Record<DetailLevel, number> = {
  maximum: 1.6,
  ultra: 1.4,
  'very-high': 1.2,
  high: 1,
  medium: 0.75,
  low: 0.45,
  minimum: 0.15,
};

export function detailFor(detail: number, level: DetailLevel): number {
  return clamp(detail * (DETAIL_LEVEL_FACTOR[level] ?? 1), 0, 100);
}

/**
 * Detail → curve-fitting tolerance, in pixels: how far the fitted outline may
 * stray from the region's exact pixel boundary. High detail tracks every pixel
 * step; low detail lets a curve cut across several pixels of staircase, which
 * is what "simplified geometry" means in practice.
 */
export function toleranceFor(detail: number, roundness: number): number {
  const d = norm(detail);
  // The floor is not arbitrary: a pixel staircase deviates ~0.5px from the
  // smooth edge it approximates, so a tolerance under that forces the fitter to
  // chase every step and the "curve" degenerates back into the staircase. Above
  // it, one cubic replaces dozens of h1/v1 pairs. At detail 100 the tolerance
  // drops below the step height on purpose — that is what "every pixel step"
  // means.
  const base = 0.25 + (1 - d) ** 2 * 4;
  // Roundness only nudges the tolerance — how *closely* the outline follows the
  // pixels is Detail's job. What Roundness really moves is `straightToleranceFor`.
  const byRoundness = [1, 1, 1.4][clamp(Math.round(roundness), 0, 2)];
  return round4(base * byRoundness);
}

/**
 * Smoothing × Roundness → the angle that counts as a corner.
 *
 * Everything below the threshold is absorbed into a curve. At smoothing 0 with
 * the sharpest roundness almost every turn is a corner, so the output is a
 * polyline; at the top only genuine corners survive and the fitter runs long
 * sweeps through the rest. This is the knob REFERENCE B5 calls "3 curve-fitting
 * levels" and B2 calls smoothing — they compose rather than fight.
 */
export function cornerAngleFor(smoothing: number, roundness: number): number {
  const s = norm(smoothing);
  const byRoundness = [0.55, 1, 1.7][clamp(Math.round(roundness), 0, 2)];
  return round4(clamp((0.22 + s * 0.95) * byRoundness, 0.1, 1.4));
}

/**
 * Roundness → how flat a run has to be before it is emitted as a line.
 *
 * This is the half of Roundness you can see. The angular level lets a gentle
 * sweep collapse into a straight segment (an outline of facets); the round level
 * keeps everything but a genuinely straight edge as a curve. Corner sharpness
 * and fit tolerance move with it, but this is what decides "curve or line".
 */
export function straightToleranceFor(roundness: number): number {
  // The angular level is allowed to exceed the fit tolerance: faceting a sweep
  // into straight segments is the look that level exists to produce.
  return [1.6, 0.4, 0.08][clamp(Math.round(roundness), 0, 2)];
}

/** How many vertices the corner detector averages direction over. */
export function cornerSpanFor(smoothing: number, roundness: number): number {
  const s = norm(smoothing);
  return clamp(Math.round(2 + s * 3 + roundness), 2, 7);
}

/**
 * How many 1-2-1 passes centre the staircase before fitting. Smoothing 0 means
 * "polylines": the boundary is handed to the fitter exactly as the pixels drew
 * it, staircase and all.
 *
 * The range is what makes the control legible. `tolerance + s` only ever spans
 * 1..2 passes at the default detail, and two passes of a 1-2-1 average move a
 * boundary by well under a pixel — the SVG changed, the picture did not, which
 * is the definition of a cosmetic control. Scaling the slider across the whole
 * 0..5 range gives the top of the slider something to do: five passes visibly
 * round a staircase, and corners stay pinned throughout (src/engine/fit.ts), so
 * "smoother" never means "melted".
 */
export function smoothPassesFor(smoothing: number, tolerance: number): number {
  const s = norm(smoothing);
  if (s === 0) return 0;
  return clamp(Math.round(tolerance * 0.5 + s * 4.5), 1, 6);
}

/**
 * How thick a blend band may be and still be collapsed into the two regions it
 * separates (`despeckleIndices` `onlyFringe`), in pixels.
 *
 * A fraction of the picture, not a fixed pixel count. Quantizing a soft edge
 * leaves a band of an in-between colour along every seam, and how wide that
 * band comes out depends on how wide the *edge* was — which scales with the
 * artwork: the same drawn edge is three pixels on a 256px sticker and twelve on
 * a 1046px illustration. The old fixed 3 therefore cleaned up small images and
 * left big ones with a mid-tone ribbon threaded between every pair of regions,
 * which is perimeter spent on a colour that is not in the drawing.
 *
 * Width alone never removes anything: `onlyFringe` also requires the band's
 * colour to lie BETWEEN its two neighbours, so a genuine third shade — one that
 * is not on the line joining the two it sits between — is not a fringe at any
 * thickness.
 */
export function fringeThickness(width: number, height: number, smartAa: boolean): number {
  const base = Math.max(2, Math.round(Math.min(width, height) / 60));
  return smartAa ? base : Math.max(2, Math.round(base * 0.66));
}

/**
 * Smoothing → how far along the boundary the pre-fit low-pass averages, in
 * pixels of arc length (src/engine/fit.ts `lowPassClosed`).
 *
 * This is the length scale of the wobble it can remove, so it has to be a few
 * pixels: the sawtooth a nearest-colour decision leaves on a soft shading
 * gradient has a period of four to eight pixels, and a window narrower than the
 * tooth just tracks it. At Smoothing 0 it is off — "no smoothing" has to mean
 * the boundary the pixels drew, staircase, wobble and all.
 */
export function boundaryRadiusFor(smoothing: number): number {
  const s = norm(smoothing);
  if (s === 0) return 0;
  return clamp(Math.round(s * 16), 1, 16);
}

/**
 * Smoothing × Detail → how far that low-pass may move a point, in pixels.
 *
 * Detail is the control that means "how closely paths follow pixel edges", so
 * it owns the amplitude: at Detail 100 the boundary is reproduced as found and
 * this collapses to almost nothing, at low Detail a seam may be redrawn by a
 * couple of pixels. Smoothing scales it the same way it scales everything else.
 * Thin shapes then get their own, much smaller cap from their own thickness
 * (src/engine/trace.ts `fitOptionsFor`), which is what keeps a hairline from
 * being averaged into the paper.
 */
export function boundaryShiftFor(smoothing: number, detail: number): number {
  const s = norm(smoothing);
  const d = norm(detail);
  if (s === 0) return 0;
  // 2.0px at the defaults (Smoothing 50, Detail 60) — enough to straighten the
  // two-to-three-pixel sawtooth a nearest-colour decision leaves on a shading
  // gradient; 0.5px at Detail 100, where the boundary is the answer.
  return round4(s * (1 + (1 - d) * 7.5));
}

/**
 * Minimum Area is a px² number, but the two sliders that also talk about size
 * scale it rather than fighting it:
 *
 *   Detail — "loose shapes" means loose shapes, not the same specks with softer
 *            edges, so low detail raises the floor and high detail lowers it.
 *   Despeckle — 0 means *keep everything* (that is what the control says it
 *            does), which is the one case that overrides the floor entirely.
 *
 * Both are multipliers, so `minArea: 0` stays 0 and the documented 0/5/90 steps
 * are exact at the default slider positions.
 */
export function areaScaleFor(detail: number, despeckle: number): number {
  const d = norm(detail);
  const byDetail = 0.5 + (1 - d) ** 2 * 3.125; // 1.0 at the default detail of 60
  const dp = norm(despeckle);
  const byDespeckle = despeckle <= 0 ? 0 : 0.25 + dp * 3.75; // 1.0 at the default of 20
  return round4(byDetail * byDespeckle);
}

/**
 * Despeckle → minimum surviving region area, in pixels.
 *
 * Speckle is a *pixel-scale* phenomenon — a scan artefact is a few pixels
 * across whether the scan is 256px or 4096px wide — so the threshold is the
 * area of a disc of radius `r` pixels, not a fraction of the canvas.
 * The default (20) clears anything under a ~2px radius, i.e. ~13px²; at 100 it
 * takes out blobs up to a ~10px radius.
 */
export function minAreaFor(despeckle: number, _width: number, _height: number): number {
  const d = norm(despeckle);
  if (d === 0) return 0;
  const radius = d * 10;
  const px = Math.PI * radius * radius;
  return px < 2 ? 0 : Math.round(px);
}

/**
 * Despeckle → maximum L1 colour distance (0..765) a speck may sit from its
 * surroundings and still be merged away.
 *
 * Area alone is the wrong test for "is this noise?". A stray pixel that is
 * *barely* different from the region around it is sensor or compression grain
 * and should go. A stray pixel that is wildly different is either deliberate
 * detail or an impulse the viewer can see — merging that silently repaints part
 * of the picture. So the noise filter is two-sided: a region has to be both
 * small *and* low-contrast. Turning the slider up widens both tolerances until,
 * at 100, contrast stops mattering at all.
 *
 * The default (20) allows ~51 per channel, which covers scan jitter and JPEG
 * ringing while leaving hard specks of real colour alone.
 */
export function maxContrastFor(despeckle: number): number {
  const d = norm(despeckle);
  if (d >= 1) return Infinity;
  return round4(d * 765);
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Enhance's region floor, as a fraction of the canvas.
 *
 * "Enhance image with AI" is a *simplification* bundle (REFERENCE B4, and
 * OBSERVED-UI's record of what the real product's own version did: a busy
 * patterned background became near-white), so its floor is proportional to the
 * canvas rather than a pixel count — ~218px² on the 1046×833 gold-standard
 * artwork, ~65px² on a 512px logo. That is a ~15×15 scrap: below it, a region
 * is a piece of background texture or a lobe shed by a ragged edge, not a
 * feature anyone drew. Line art is exempt (`keepElongated` + `protect`), which
 * is what lets the floor be this frank without eating a mouth or an eyelid.
 */
const ENHANCE_FLOOR_DIVISOR = 4000;

/**
 * How much of the Enhance region floor carries over to the *document* floor.
 *
 * The two floors measure different things: the index-image pass counts a
 * region's pixels, the trace-time pass measures a fitted shape's bounding box,
 * and a box overstates everything that is not a rectangle (a diagonal sliver's
 * box can be ten times its area) — which is why the multiplier used to be a
 * half: a like-for-like number reached the diagonal strokes.
 *
 * It can be frank now because the strokes are no longer exposed to it. The ink
 * layers keep the plain Minimum Area (`inkTraceOptions` below) and, since the
 * linework became the silhouette layer, the drawing's outline is ONE contour
 * that no area test can nibble. What is left for this floor to see is the
 * 3-10px lobes a ragged colour boundary sheds — attached to their parent
 * region, so invisible to every despeckle — and those are pure cost: on the
 * gold standard they carried a fifth of some layers' perimeter for a fortieth
 * of their area.
 */
const SHAPE_FLOOR_OF_REGION_FLOOR = 2;

/**
 * How different a small region may be from its surroundings and still be
 * cleaned up by the Enhance floor (L1 over RGB, 0..765).
 *
 * The floor exists to flatten a busy background, and area alone cannot tell a
 * scrap of background pattern from a feature: both are ~60px². A blind
 * 87px² floor therefore ate the gold-standard artwork's face — both white
 * fangs, one eye, the mouth broken into blobs — while every whole-frame gate
 * stayed green, because the face is 8 % of the canvas (ink recall inside it:
 * 0.865 against 0.912 with the bundle off). The linework the floor destroyed is
 * exactly the linework that is *loud*: white teeth inside a black mouth, a
 * black eye on a cream face.
 *
 * So the floor gets the same two-sided test the despeckle noise filter has had
 * all along (`maxContrastFor`): small AND quiet. 255 is a third of the L1
 * range — a region a third of the colour space away from everything it touches
 * is a feature of the drawing, whatever its area. Measured on the gold-standard
 * artwork this moves face ink recall 0.865 -> 0.959 and whole-frame 0.942 ->
 * 0.977, for eight extra sub-paths out of 153.
 */
const ENHANCE_FLOOR_MAX_CONTRAST = 255;

/**
 * Luma below which a palette entry is the drawing's ink rather than one of its
 * colours. Same number `reserveDarkest` uses to decide a palette slot is worth
 * spending on the outline (src/engine/color.ts).
 */
const INK_LUMA = 60;

/**
 * Smart anti-aliasing's near-duplicate fold, as a percentage of the L1 range.
 *
 * A halo layer is a near-duplicate of the colour it hugs, so the fold is a
 * colour-distance question — but the threshold is not free to be generous. It
 * is set at exactly the point that *guarantees* the survivors stay outside the
 * 32-unit Euclidean window `nearDuplicateFillPairs` calls a duplicate: the
 * worst case for a given L1 distance is an equal split across the three
 * channels, so L1 > 32·√3 = 55.4, i.e. 7.25 % of 765.
 *
 * It used to be 8 %, which is 61 units — six units of margin nobody asked for,
 * and on the gold-standard artwork those six units cost two whole output
 * colours: a 16-colour request delivered 8 groups where a 12-colour request
 * delivered 9, so asking for MORE colours handed back FEWER. At 7.25 % the same
 * request delivers 10 and the closest surviving pair is 34.7 apart, still
 * outside the window.
 */
const HALO_FOLD_PERCENT = 7.25;

/**
 * Which palette slots hold dark ink — the line art the cleanup passes must not
 * simplify.
 *
 * Only the *darkest* qualifying entry counts: on a dark-heavy picture half the
 * palette can sit under the luma bar, and exempting half the palette from every
 * floor is not a protection, it is switching the floor off.
 */
function darkInkSlots(palette: RgbColor[]): Uint8Array | undefined {
  let darkest = -1;
  let bestLuma = INK_LUMA;
  for (let i = 0; i < palette.length; i++) {
    const luma = 0.299 * palette[i].r + 0.587 * palette[i].g + 0.114 * palette[i].b;
    if (luma < bestLuma) {
      bestLuma = luma;
      darkest = i;
    }
  }
  if (darkest < 0) return undefined;
  const flags = new Uint8Array(palette.length);
  flags[darkest] = 1;
  return flags;
}

/**
 * Luma at or above which a palette slot is the drawing's highlights. Same
 * number `reserveExtremes` spends a slot on them with (src/engine/color.ts).
 */
const HIGHLIGHT_LUMA = 245;

/**
 * The slots an area floor is not allowed to empty: the drawing's ink and its
 * highlights, one entry each.
 *
 * The ink half is old (`darkInkSlots`). The light half is the other end of the
 * same argument, and it is the one the gold standard exposed: a white highlight
 * is BY CONSTRUCTION small — the fangs and eye glints on the reference artwork
 * are ~150px² each against Enhance's ~218px² floor — and unlike a stroke it is
 * compact, so `keepElongated` does not save it either. Reserving a palette slot
 * for white and then letting the floor merge every region painted with it
 * delivers a swatch naming a colour that appears nowhere in the drawing:
 * measured on this fixture, the delivered palette carried rgb(253,249,242) and
 * the rendered SVG had zero pixels above luma 230 where the source has 382.
 *
 * Only the extreme entry at each end counts, for `darkInkSlots`' reason: an
 * exemption granted to half the palette is not a protection, it is switching
 * the floor off.
 */
function protectedSlots(palette: RgbColor[]): Uint8Array | undefined {
  const flags = darkInkSlots(palette) ?? new Uint8Array(palette.length);
  let lightest = -1;
  let bestLuma = HIGHLIGHT_LUMA;
  for (let i = 0; i < palette.length; i++) {
    const luma = 0.299 * palette[i].r + 0.587 * palette[i].g + 0.114 * palette[i].b;
    if (luma >= bestLuma) {
      bestLuma = luma;
      lightest = i;
    }
  }
  if (lightest >= 0) flags[lightest] = 1;
  return flags.some((f) => f === 1) ? flags : undefined;
}

/**
 * Every palette slot dark enough to be drawing ink, not just the darkest one.
 *
 * `darkInkSlots` is deliberately narrow because it exempts regions from *area*
 * floors, and exempting half a dark picture's palette from a floor switches the
 * floor off. `regularizeBoundaries` is a shape filter with no floor to switch
 * off: what it needs to know is which colours a stroke can be drawn in, and a
 * soft outline quantizes into two or three of them (on the gold standard,
 * rgb(32,24,10) and rgb(28,47,53) both carry parts of the same outline).
 */
function inkSlotsOf(palette: RgbColor[]): Uint8Array | undefined {
  const flags = new Uint8Array(palette.length);
  let any = false;
  for (let i = 0; i < palette.length; i++) {
    const luma = 0.299 * palette[i].r + 0.587 * palette[i].g + 0.114 * palette[i].b;
    if (luma < INK_LUMA) {
      flags[i] = 1;
      any = true;
    }
  }
  return any ? flags : undefined;
}

/**
 * Path-data precision. One decimal is *exact* here, not a compromise: the
 * tracer places every node on a pixel corner or on the midpoint between two of
 * them, so every coordinate it can produce is a multiple of 0.5. A second
 * decimal would only add bytes.
 */
const PATH_PRECISION = 2;

/** Line width used by the stroked result style (REFERENCE B6). */
const STROKE_WIDTH = 1;

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function resolveSettings(settings?: Partial<VectorizeSettings> | null): ResolvedSettings {
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const minArea = Number.isFinite(s.minArea) ? Math.max(0, Number(s.minArea)) : DEFAULT_SETTINGS.minArea;
  return {
    colorCount: Math.round(clamp(s.colorCount, 1, 64)),
    detail: clamp(s.detail, 0, 100),
    smoothing: clamp(s.smoothing, 0, 100),
    despeckle: clamp(s.despeckle, 0, 100),
    enhance: Boolean(s.enhance),
    palette: s.palette ?? null,
    preset: oneOf(s.preset, ['clipart', 'photo', 'sketch', 'drawing'] as const, 'clipart'),
    detailLevel: oneOf(
      s.detailLevel,
      ['maximum', 'ultra', 'very-high', 'high', 'medium', 'low', 'minimum'] as const,
      'high',
    ),
    bwThreshold: Math.round(clamp(Number(s.bwThreshold ?? 128), 0, 255)),
    noiseReduction: oneOf(s.noiseReduction, ['off', 'low', 'high'] as const, 'off'),
    antiAliasing: oneOf(s.antiAliasing, ['off', 'smart', 'mid'] as const, 'off'),
    roundness: clamp(Math.round(Number(s.roundness ?? 1)), 0, 2) as 0 | 1 | 2,
    minArea,
    overlap: oneOf(s.overlap, ['full', 'high'] as const, 'high'),
    circleDetection: Boolean(s.circleDetection),
    resultStyle: oneOf(s.resultStyle, ['filled', 'stroked'] as const, 'filled'),
    disabledColors: Array.isArray(s.disabledColors)
      ? s.disabledColors.filter((n) => Number.isInteger(n) && n >= 0)
      : [],
    mergeThreshold: clamp(Number(s.mergeThreshold ?? 0), 0, 100),
    sortOrder: oneOf(s.sortOrder, ['coverage', 'brightness', 'hue'] as const, 'coverage'),
  };
}

/**
 * Colour budget the preset asks for (REFERENCE B2).
 *
 * Clipart and Sketch take the user's number. Photo is the "Many Colors" model,
 * so it never runs below 16 — a photograph quantized to eight colours is a
 * poster, not a photo. Drawing is two-tone by definition; the palette falls out
 * of the luminance threshold, so the count is just a ceiling.
 */
function presetColorCount(opts: ResolvedSettings): number {
  switch (opts.preset) {
    case 'photo':
      return Math.min(64, Math.max(opts.colorCount, 16));
    case 'drawing':
      return 2;
    default:
      return opts.colorCount;
  }
}

/**
 * Per-preset fitting bias.
 *
 * Photo boundaries are gradient boundaries: there is no "true" edge to follow
 * to the pixel, so the fit is allowed to be looser and rounder. Clipart, Sketch
 * and Drawing all want the drawn edge reproduced.
 */
function presetFitScale(opts: ResolvedSettings): { tolerance: number; cornerAngle: number } {
  const bias =
    opts.preset === 'photo'
      ? { tolerance: 1.6, cornerAngle: 1.35 }
      : { tolerance: 1, cornerAngle: 1 };
  // Enhance is a simplification bundle, and an outline that is allowed to cut a
  // little wider across a cleaned-up edge is part of that: it is the difference
  // between "denoised" and "denoised and *simpler*".
  if (opts.enhance) bias.tolerance *= 1.3;
  return bias;
}

/** Yield to the event loop so a host that runs this inline stays responsive. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function report(
  onProgress: ProgressCallback | undefined,
  phase: VectorizePhase,
  progress: number,
): void {
  if (!onProgress) return;
  try {
    onProgress({ phase, progress: clamp(progress, 0, 1) });
  } catch {
    /* a broken progress sink must never fail a vectorization */
  }
}

/**
 * Convert a decoded raster image into an SVG.
 *
 * Deterministic: the same (image, settings) pair produces a byte-identical
 * `svg`. Nothing in the pipeline consults `Math.random`, the clock, or an
 * unordered iteration order.
 */
export async function vectorize(
  image: RasterImage,
  settings: VectorizeSettings = DEFAULT_SETTINGS,
  onProgress?: ProgressCallback,
): Promise<VectorizeResult> {
  const started = now();
  const opts = resolveSettings(settings);
  const width = image.width | 0;
  const height = image.height | 0;

  if (width <= 0 || height <= 0 || image.data.length < width * height * 4) {
    throw new Error(
      `vectorize(): expected ${width * height * 4} RGBA bytes for ${width}x${height}, got ${image.data.length}`,
    );
  }

  // 1. Preprocess -----------------------------------------------------------
  //
  // Order matters: the optional cleanups run first (each one only removes
  // information the tracer would otherwise have to spend shapes on), and the
  // preset's colour-space change runs LAST so "Sketch is grayscale" and
  // "Drawing is two-tone" are guaranteed by construction rather than by luck.
  report(onProgress, 'preprocess', 0.02);
  /**
   * The alpha channel, honoured (REFERENCE's headline use cases — stickers,
   * decals, t-shirt art — arrive as PNGs with a transparent background).
   *
   * `opaque` is null for ordinary artwork, and then every alpha-aware branch
   * below is a no-op. When it is not null, the see-through pixels are: excluded
   * from the histogram (so they cannot win a palette slot), marked
   * `TRANSPARENT_INDEX` in the index image (so they join no layer), and barred
   * from becoming the backdrop rect — which together are the difference between
   * exporting a sticker and exporting a black rectangle.
   */
  const opaque = opacityMask(image);
  let source: RasterImage = opaque ? bleedTransparent(image, opaque, 3) : image;
  source = opts.enhance ? enhanceSync(source) : source;
  source = reduceNoise(source, opts.noiseReduction);
  /**
   * "Enhance image with AI" is a bundle, not a filter (REFERENCE B4, and
   * OBSERVED-UI's record of what it did to the real product's output: a busy
   * patterned background became near-white). On top of the denoise +
   * colour-simplification pass it adds a minimum shape area proportional to the
   * canvas — one ten-thousandth of it, ~87px² on the 1046x833 reference
   * artwork, ~26px² on a 512px logo. A checkbox that only nudges the output is
   * not the control the reference product has.
   *
   * What it deliberately does NOT do any more is reach into Anti-aliasing.
   * It used to force Smart on whenever the control read "Off", so the two
   * settings produced byte-identical documents and the UI reported a state the
   * engine was not in. OBSERVED-UI step ③ has them as independent controls, so
   * they are independent controls: Smart is simply the *default* (above).
   */
  const smartAa = opts.antiAliasing === 'smart';
  if (smartAa || opts.antiAliasing === 'mid') {
    source = deAntialias(source, smartAa ? 2 : 1);
  }
  if (opts.preset === 'sketch') source = toGrayscale(source);
  else if (opts.preset === 'drawing') source = toBlackAndWhite(source, opts.bwThreshold);
  report(onProgress, 'preprocess', 0.12);
  await tick();

  // 2. Quantize -------------------------------------------------------------
  //
  // A palette override is an *output colour table*, not a set of cluster
  // centres, and it is applied at the very END of the colour pipeline (see
  // "6. Repaint" below). The segmentation — clustering, every cleanup pass,
  // every fold — is computed from the image alone and is byte-for-byte the same
  // whether or not `settings.palette` is set. That is the whole contract: a
  // palette edit repaints, it never re-segments.
  //
  // It used to cluster at `override.length` instead, which quietly made every
  // palette-editor operation a re-quantization: an un-overridden 16-colour run
  // clusters at 16 and folds down to 8, while the override run clustered from
  // scratch at k=8, so slot i was paired with a cluster from a *different*
  // segmentation. Feeding a palette straight back unchanged moved the drawing.
  report(onProgress, 'quantize', 0.15);
  const override = normalizePalette(opts.palette);
  const clusters = computePaletteSync(source, Math.max(1, presetColorCount(opts)), opaque);
  let indices = mapToPalette(source, clusters, opaque);
  /**
   * Anti-aliasing, the half that works on regions rather than pixels.
   *
   * OBSERVED-UI's reading of the reference product's Smart anti-aliasing is
   * "a pre-trace edge cleanup (edge-aware smoothing of the quantized regions)",
   * and that is what this is: a majority filter over the *index* image, which
   * can only ever remove a local minority. Ragged one-pixel transition bands —
   * the halo an antialiased edge quantizes into — are exactly local minorities,
   * so they disappear and the boundary they were fringing comes out shorter and
   * straighter. The pixel-level pass above cannot do this on its own: on a soft
   * gradient it finds no ramp to snap, yet the quantized regions are still
   * ragged.
   */
  const indexPasses = smartAa ? 2 : opts.antiAliasing === 'mid' ? 1 : 0;
  for (let i = 0; i < indexPasses; i++) {
    indices = majorityFilter(indices, width, height, clusters.length, TRANSPARENT_INDEX);
  }
  /**
   * ...and the seams between the regions, which a 3×3 vote cannot straighten.
   *
   * A sawtooth two pixels deep is a local majority in every 3×3 window it
   * appears in, so `majorityFilter` preserves it and the tracer faithfully
   * reproduces every spike. That is the difference between our 16-colour output
   * and the real product's: same colours, same silhouettes, but our shading
   * boundaries arrive as a saw and theirs as a single sweep. See
   * `regularizeBoundaries`.
   */
  const clusterInk = inkSlotsOf(clusters);
  const seamPasses = indexPasses > 0 ? indexPasses + 1 : 0;
  for (let i = 0; i < seamPasses; i++) {
    indices = regularizeBoundaries(
      indices,
      width,
      height,
      clusters.length,
      TRANSPARENT_INDEX,
      clusterInk,
    );
  }
  /**
   * ...and the half a 3×3 window cannot reach.
   *
   * A fringe two or three pixels wide is a local *majority*, so the filter
   * above preserves it, and it can be far bigger than any speck threshold — the
   * grey band along the reference artwork's mouth is 40×3. What marks it is
   * that it is thin and its colour lies between the two regions it separates,
   * so that is what gets tested. Nothing else is touched: a thin band that is
   * not in-between is line art, and lines are the point of the picture.
   *
   * It also runs for Noise Reduction "high", the other setting that manufactures
   * blend bands: simplifying to 16 colours leaves a band of an in-between colour
   * wherever two regions meet, and a filter that creates fringes should clean up
   * after itself.
   */
  const collapseFringes = indexPasses > 0 || opts.noiseReduction === 'high';
  if (collapseFringes) {
    despeckleIndices(indices, width, height, {
      minArea: 0,
      palette: clusters,
      onlyFringe: true,
      maxThickness: fringeThickness(width, height, smartAa),
      transparentIndex: TRANSPARENT_INDEX,
    });
  }
  report(onProgress, 'quantize', 0.32);
  await tick();

  // 3. Despeckle ------------------------------------------------------------
  //
  // Three filters, deliberately different in kind:
  //   Minimum Area (B5) is a promise about the *document* — nothing smaller
  //   than N px² is in it — so it merges regardless of how loud the speck is,
  //   and regardless of shape.
  //   The Despeckle slider is a noise filter: it also weighs contrast, because
  //   a tiny region that is wildly different from its surroundings is either
  //   deliberate detail or an impulse the viewer can see.
  //   The Enhance floor is a canvas-proportional cleanup. Both *noise* filters
  //   exempt strokes (`keepElongated`): line art is thin, so an area-only test
  //   deletes it — an 87px² floor on the 1046px reference artwork ate the
  //   character's mouth and eyelids and left dashes behind. Minimum Area does
  //   not get the exemption, because its promise is about area, full stop.
  const minArea =
    opts.minArea * areaScaleFor(detailFor(opts.detail, opts.detailLevel), opts.despeckle);
  if (minArea > 1) {
    despeckleIndices(indices, width, height, {
      minArea,
      palette: clusters,
      transparentIndex: TRANSPARENT_INDEX,
    });
  }
  const enhanceFloor = opts.enhance && opts.despeckle > 0 ? (width * height) / ENHANCE_FLOOR_DIVISOR : 0;
  const inkSlots = protectedSlots(clusters);
  if (enhanceFloor > 1) {
    despeckleIndices(indices, width, height, {
      minArea: enhanceFloor,
      palette: clusters,
      keepElongated: true,
      maxContrast: ENHANCE_FLOOR_MAX_CONTRAST,
      protect: inkSlots,
      transparentIndex: TRANSPARENT_INDEX,
    });
  }
  const noiseArea = minAreaFor(opts.despeckle, width, height);
  if (noiseArea > 1) {
    despeckleIndices(indices, width, height, {
      minArea: noiseArea,
      palette: clusters,
      maxContrast: maxContrastFor(opts.despeckle),
      keepElongated: true,
      /*
       * Deliberately NOT given the highlight exemption the Enhance floor gets.
       * The Enhance floor is a simplification — "this scrap is background
       * texture" — and a drawn highlight is not background texture. This one is
       * a noise filter, and a bright speck is exactly what it exists to remove:
       * on `fixtures/logo-noisy-512.png` exempting the light slot here kept the
       * seeded speckle and took the trace from 13 sub-paths to 105.
       */
      transparentIndex: TRANSPARENT_INDEX,
    });
  }
  /**
   * One more seam pass, on the index image as the tracer will actually see it.
   *
   * Every despeckle above rewrites a region wholesale into a neighbour, which
   * leaves the *former* region's outline behind as a kink in the seam it just
   * joined — the cleanup that removed a shape adds raggedness to the shape that
   * absorbed it. Running the regularizer before the floors therefore tidies a
   * boundary the floors then re-roughen.
   */
  for (let i = 0; i < seamPasses; i++) {
    indices = regularizeBoundaries(
      indices,
      width,
      height,
      clusters.length,
      TRANSPARENT_INDEX,
      clusterInk,
    );
  }
  report(onProgress, 'simplify', 0.4);
  await tick();

  // Re-rank by what actually survived quantization + despeckle, and drop
  // entries no pixel ended up using. This runs whether or not the caller
  // supplied a palette: the rank it produces IS the slot numbering the override
  // is matched against, and it is the order the palette editor displays.
  let computed: RgbColor[];
  {
    const coverage = coverageOf(indices, clusters.length);
    const kept = clusters
      .map((color, i) => ({ color, i, n: coverage[i] }))
      .filter((e) => e.n > 0)
      .sort((a, b) => b.n - a.n || a.i - b.i);
    computed = kept.map((e) => ({ ...e.color }));
    const indexMap = new Uint8Array(clusters.length);
    kept.forEach((e, rank) => {
      indexMap[e.i] = rank;
    });
    remapIndices(indices, indexMap);
  }
  if (computed.length === 0) computed = [{ r: 0, g: 0, b: 0 }];
  /**
   * What the image had to give, measured before the folds below. Everything
   * after this point is a choice we made, not a limit of the artwork, and the
   * UI has to be able to say which is which.
   */
  const sourceColors = computed.length;

  // Two different collapses. Both are part of the *segmentation*, so they run
  // identically with and without a palette override — an override that arrives
  // one slot short of the folded table is a remove, not a licence to fold
  // differently:
  //   - Smart anti-aliasing folds away halo layers, which ARE near-duplicates
  //     of the colour they hug, so it merges by colour distance
  //     (`HALO_FOLD_PERCENT`).
  //   - The output-groups merge threshold folds away colours that barely appear
  //     (REFERENCE B3), which is a coverage question.
  if (smartAa) computed = mergeSimilarColors(indices, computed, HALO_FOLD_PERCENT).palette;
  /**
   * The output-groups merge threshold is the ONLY thing that folds by coverage,
   * and it is the control the panel shows (REFERENCE B3).
   *
   * Enhance used to force it to 1 % on top of whatever the user had set, which
   * is how a 16-colour request came back with eight: three of the eight it took
   * were quantization debris, and the other five were the halo fold's, but the
   * hint could only blame "the cleanup settings" for all of them and no control
   * on the panel could give any of them back — `merge-threshold: 0` and the
   * default produced byte-identical documents. A fold nobody can undo is not a
   * setting.
   *
   * What Enhance does about debris instead is what a simplification bundle
   * should do: it raises the *area* floors (`enhanceFloor` above), so a colour
   * that only ever appears in 15×15 scraps loses those scraps to their
   * neighbours on the picture, not its seat in the palette.
   */
  const groupThreshold = opts.mergeThreshold;
  if (groupThreshold > 0) computed = mergeSmallGroups(indices, computed, groupThreshold);

  // 6. Repaint --------------------------------------------------------------
  //
  // `slots` is the colour each surviving slot is painted with; `palette` is
  // that list with duplicates collapsed, which is what the SVG groups by. With
  // no override the two are the same array.
  //
  // All three palette-editor operations (REFERENCE B3) fall out of the one
  // `settings.palette` knob, and none of them touches a contour:
  //   change — slot i is repainted with override[i]. Re-clustering on the new
  //            colour instead would strand it: recolour the dominant paper tone
  //            to magenta and nearest-colour matching hands every paper pixel to
  //            some other entry, so the colour the user just picked never
  //            appears in the output.
  //   merge  — two slots are given the *same* colour, so they collapse into one
  //            layer and the palette shrinks by one. The segmentation is
  //            untouched, so the surviving colour keeps exactly the geometry it
  //            had and simply gains the merged region.
  //   remove — the override is one entry short of the slot table. The orphaned
  //            slots are painted with the nearest surviving colour, so the
  //            removed colour cannot appear anywhere; the picture is not
  //            re-segmented behind the user's back.
  const slots = override ? repaintSlots(computed, override) : computed.map((c) => ({ ...c }));
  /** Slot -> output entry, and the distinct output colours in slot order. */
  const palette: RgbColor[] = [];
  const slotToEntry = new Uint8Array(slots.length);
  {
    const entryOf = new Map<number, number>();
    for (let i = 0; i < slots.length; i++) {
      const key = packRgb(slots[i].r, slots[i].g, slots[i].b);
      let entry = entryOf.get(key);
      if (entry === undefined) {
        entry = palette.length;
        entryOf.set(key, entry);
        palette.push({ ...slots[i] });
      }
      slotToEntry[i] = entry;
    }
    if (override) remapIndices(indices, slotToEntry);
  }

  const finalCoverage = coverageOf(indices, palette.length);

  // 4. Trace ----------------------------------------------------------------
  report(onProgress, 'trace', 0.45);
  const detail = detailFor(opts.detail, opts.detailLevel);
  const bias = presetFitScale(opts);
  const tolerance = toleranceFor(detail, opts.roundness) * bias.tolerance;
  const traceOptions: TraceOptions = {
    tolerance,
    cornerAngle: cornerAngleFor(opts.smoothing, opts.roundness) * bias.cornerAngle,
    cornerSpan: cornerSpanFor(opts.smoothing, opts.roundness),
    smoothPasses: smoothPassesFor(opts.smoothing, tolerance),
    boundaryRadius: boundaryRadiusFor(opts.smoothing),
    boundaryShift: boundaryShiftFor(opts.smoothing, detail),
    straightTolerance: straightToleranceFor(opts.roundness),
    circleDetection: opts.circleDetection,
    minArea,
    /**
     * Enhance is a simplification bundle, so its canvas-proportional floor has
     * to reach the *document*, not just the index image.
     *
     * The index-image pass above (`enhanceFloor`) can only merge a small region
     * into a neighbour, and it deliberately spares strokes. What it cannot
     * touch is the shape a surviving region still traces to: a ragged edge
     * sheds dozens of small islands, and every one costs a sub-path, a scrap of
     * perimeter and a kink a viewer reads as "posterized photo". The real
     * product's 16-colour output for the gold-standard artwork has NO sub-path
     * with a bounding box under ~200px²; ours had 106 of them.
     *
     * It is `softMinArea`, not `minArea`, and the difference is a fang. A pure
     * size test at this scale cannot tell a shed lobe from a drawn feature —
     * the gold standard's teeth are ~140px² of bounding box, right in the
     * middle of the debris — and deleting one now leaves a hole through which
     * the silhouette layer, which is the INK, shows: a mouth with no teeth in
     * it. So the floor asks about the shape too (src/engine/trace.ts
     * `isSimpleShape`), and Minimum Area keeps the document promise on its own.
     */
    softMinArea: enhanceFloor * SHAPE_FLOOR_OF_REGION_FLOOR,
  };
  /**
   * ...and the ink layer keeps only the floor the user asked for.
   *
   * The shape floor is a bounding-box test, and a bounding box is the worst
   * possible measure of a stroke: the box round the gap between two teeth, or
   * round a comma-shaped eyelid, is mostly not the shape. Simplifying a
   * background region away is a simplification; doing it to the linework is a
   * hole. Minimum Area (B5) still applies — that promise is about the document,
   * full stop.
   */
  /**
   * Ink is a property of the *artwork*, not of the colour the user painted a
   * slot with, so the exemption is decided on the segmentation's own colours
   * (`computed`) and then carried onto whichever output entry those slots
   * ended up in. Reading it off `palette` instead would mean recolouring the
   * outline swatch to magenta re-traced the outline — a repaint that moves the
   * drawing is the bug this whole section exists to prevent.
   */
  const inkSlotFlags = darkInkSlots(computed);
  let inkLayers: Uint8Array | undefined;
  if (inkSlotFlags) {
    inkLayers = new Uint8Array(palette.length);
    for (let i = 0; i < slots.length; i++) if (inkSlotFlags[i]) inkLayers[slotToEntry[i]] = 1;
  }
  const inkTraceOptions: TraceOptions = { ...traceOptions, softMinArea: 0 };

  const disabled = new Set(opts.disabledColors);
  const enabled: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (finalCoverage[i] > 0 && !disabled.has(i)) enabled.push(i);
  }

  /**
   * Emission order (REFERENCE B3 "sort order").
   *
   * Free in both overlap modes. With trimmed layers the picture is a partition,
   * so nothing can hide anything. With full overlap each layer is built as the
   * union of itself and everything painted AFTER it, which makes the composite
   * independent of the permutation too: a pixel of colour `order[k]` belongs to
   * every layer at position <= k, the last of those painted is position k, and
   * it is painted `order[k]`. Forcing coverage rank here only made B3's control
   * silently inert whenever Overlap was Full.
   */
  const order = sortedOrder(palette, finalCoverage, opts.sortOrder).filter((i) =>
    enabled.includes(i),
  );

  // The heaviest layer becomes a backdrop rect rather than an outline: the
  // layers partition the canvas, so painting it full-bleed is lossless, much
  // cheaper, and gives every seam something correct to blend into. It is off
  // when the colour is disabled (that is what makes the background genuinely
  // transparent, REFERENCE B3) and in the stroked style, where every colour has
  // to appear as an outline (B6).
  let dominant = -1;
  let bestCoverage = -1;
  for (let i = 0; i < palette.length; i++) {
    if (finalCoverage[i] > bestCoverage) {
      bestCoverage = finalCoverage[i];
      dominant = i;
    }
  }
  // Only the *dominant* colour may become the backdrop. Promoting the runner-up
  // when the dominant one is switched off would hand the user a differently
  // coloured full-bleed rectangle instead of the transparency they asked for.
  //
  // And a source with an alpha channel gets no backdrop at all: the layers no
  // longer partition the canvas (the see-through part belongs to nobody), so a
  // full-bleed rect is not the free optimisation it is on opaque artwork — it
  // is an invented background painted over the transparency the file asked for.
  const backgroundIndex =
    opts.resultStyle === 'filled' && !opaque && dominant >= 0 && !disabled.has(dominant)
      ? dominant
      : -1;

  /**
   * ...and the same optimisation for artwork that has an alpha channel: ONE
   * layer is traced as the whole SILHOUETTE, not as its own pixels.
   *
   * On opaque artwork the heaviest layer is a full-bleed rect, and the reason
   * that is free is that the layers partition the canvas: whatever is painted
   * over it wins. Exactly the same argument holds inside the drawn silhouette
   * of a sticker — the only thing a rect would get wrong there is the part of
   * the canvas the file asked to be see-through, and the silhouette is that
   * shape minus that part.
   *
   * What it buys is not bytes, it is shape. Trimmed to its own pixels the
   * bottom layer is perforated by every layer above it, so its outline detours
   * round all of them and sheds an island wherever a neighbour cuts it in two.
   * As a silhouette it is one smooth shape, which is what the real product's
   * own bottom layer is, and it also removes the hairline seams that show
   * through wherever two trimmed layers meet.
   *
   * WHICH layer gets it is the INK, when the drawing has ink — not the
   * dominant colour, which is what this used to promote. Two reasons, and the
   * second is the one that matters:
   *
   *   - The linework is by far the most expensive layer to trace and the one
   *     that gains most from not being traced: a network of thin strokes is a
   *     compound path of dozens of long, near-zero-area contours (35 sub-paths
   *     carrying half the document's perimeter on the gold standard), while the
   *     same layer as a silhouette is a single smooth outline. Every pixel that
   *     is not ink is repainted by its own layer on top, so the picture is
   *     unchanged — swapping the two at otherwise identical settings took the
   *     gold-standard document from 32 KB to 24 KB and its mean layer
   *     compactness from 3.28 to 3.04.
   *   - What shows through a seam becomes the OUTLINE colour instead of the
   *     background one. Two trimmed layers that meet along a shared edge leave a
   *     sub-pixel crack when they are rasterized; on line art the correct thing
   *     to see in that crack is the line, not the paper. This is the same reason
   *     the real product's darkest layer sits under everything.
   *
   * Falls back to the dominant colour when the artwork has no ink at all (a
   * gradient sticker, a photo), which is the case this started as.
   *
   * It has to be painted first, so it is moved to the front of the emission
   * order regardless of what B3's sort order says about the rest.
   */
  let silBase = dominant;
  if (inkLayers) {
    let heaviestInk = -1;
    for (let i = 0; i < palette.length; i++) {
      if (!inkLayers[i] || finalCoverage[i] <= 0 || disabled.has(i)) continue;
      if (heaviestInk < 0 || finalCoverage[i] > finalCoverage[heaviestInk]) heaviestInk = i;
    }
    if (heaviestInk >= 0) silBase = heaviestInk;
  }
  const silhouetteLayer =
    opts.resultStyle === 'filled' && opaque && silBase >= 0 && !disabled.has(silBase)
      ? silBase
      : -1;
  if (silhouetteLayer >= 0) {
    const at = order.indexOf(silhouetteLayer);
    if (at > 0) {
      order.splice(at, 1);
      order.unshift(silhouetteLayer);
    }
  }

  const layers: TracedLayer[] = [];
  const mask = new Uint8Array(width * height);
  const trap = new Uint8Array(width * height);
  for (let position = 0; position < order.length; position++) {
    const i = order[position];
    if (i !== backgroundIndex) {
      if (i === silhouetteLayer) {
        // The drawn silhouette: every pixel the source is not see-through at.
        for (let p = 0; p < mask.length; p++) mask[p] = indices[p] === TRANSPARENT_INDEX ? 0 : 1;
      } else if (opts.overlap === 'full') {
        // Full overlap: the layer reaches under everything painted after it, so
        // neighbouring layers cannot leave a seam between them.
        const above = new Uint8Array(palette.length);
        for (let q = position; q < order.length; q++) above[order[q]] = 1;
        for (let p = 0; p < mask.length; p++) {
          const v = indices[p];
          mask[p] = v === TRANSPARENT_INDEX ? 0 : above[v];
        }
      } else {
        maskForIndex(indices, i, mask);
        trapUnderLater(mask, indices, order, position, palette.length, width, height, trap);
      }
      const layerOptions = inkLayers?.[i] ? inkTraceOptions : traceOptions;
      let traced = traceMask(mask, width, height, i, layerOptions);
      /**
       * A colour the palette promises has to appear in the drawing.
       *
       * The Enhance shape floor is a *simplification* — it removes the scraps a
       * ragged boundary sheds — and simplifying a colour out of existence
       * entirely is a different act: the palette editor would still list the
       * swatch, the output-colour groups panel would still draw its circle, and
       * nothing on the canvas would be that colour. So when the floor empties a
       * layer, that layer is retraced at Minimum Area instead and keeps
       * whatever it has.
       *
       * Minimum Area itself (REFERENCE B5) gets no such exemption: it is a
       * promise about the *document* — "nothing smaller than N px² is in it" —
       * and a promise with an escape hatch is not one.
       */
      if (traced.regionCount === 0 && (layerOptions.softMinArea ?? 0) > minArea) {
        traced = traceMask(mask, width, height, i, { ...layerOptions, softMinArea: 0 });
      }
      layers.push(traced);
    }
    report(onProgress, 'trace', 0.45 + 0.4 * ((position + 1) / Math.max(1, order.length)));
    if (position % 4 === 3) await tick();
  }
  await tick();

  // 5. Serialize ------------------------------------------------------------
  report(onProgress, 'serialize', 0.9);
  const rendered = renderSvg(layers, palette, {
    width,
    height,
    precision: PATH_PRECISION,
    backgroundIndex,
    resultStyle: opts.resultStyle,
    strokeWidth: STROKE_WIDTH,
  });
  report(onProgress, 'done', 1);

  return {
    svg: rendered.svg,
    palette,
    pathCount: rendered.pathCount,
    width,
    height,
    durationMs: Math.max(0, now() - started),
    sourceColors,
    slots,
  };
}

/**
 * Extend a layer one pixel UNDER everything painted after it — the trap that
 * stops a shared boundary showing a crack.
 *
 * Two filled shapes that abut are not two halves of one picture to a
 * rasterizer: each is composited on its own, so a pixel the boundary passes
 * through is `0.6·A over background` and then `0.4·B over that`, and 24 % of the
 * background survives *between* two regions that touch. Against a black outline
 * over light paper the leak reads as a white hairline drawn down the side of
 * every stroke — the single most visible thing a tracer can get wrong, and one
 * that no averaging metric sees: 918 such pixels on a megapixel drawing move
 * mean colour error by a tenth of a unit.
 *
 * The fix is the printer's one: spread the lower plate under the upper. Because
 * the extension only ever covers pixels a LATER layer will paint over, the
 * composite is unchanged everywhere except in the crack, where the blend is now
 * between the two colours that meet rather than with whatever is underneath.
 *
 * One pixel, and it must be one: the trap is invisible only while it stays
 * inside the seam. `overlap: 'full'` is the same idea taken to its limit — each
 * layer is the union of itself and everything after it — and it costs what
 * DEFAULT_SETTINGS says it costs (the gold standard's document grows 25 KB ->
 * 44 KB, and circle detection stops seeing discs, because every layer inherits
 * the outline of every shape above it). A one-pixel skirt on the layer's own
 * outline changes its shape by nothing measurable and removes ~85 % of the
 * slivers.
 */
function trapUnderLater(
  mask: Uint8Array,
  indices: Uint8Array,
  order: number[],
  position: number,
  paletteSize: number,
  width: number,
  height: number,
  scratch: Uint8Array,
): void {
  if (position + 1 >= order.length) return;
  const later = new Uint8Array(paletteSize);
  for (let q = position + 1; q < order.length; q++) later[order[q]] = 1;
  scratch.set(mask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (scratch[p]) continue;
      const v = indices[p];
      // Only under a layer that will cover it again. A pixel nobody paints
      // later — the background, another layer already emitted — must keep the
      // colour it has, or the trap becomes a bleed.
      if (v >= paletteSize || !later[v]) continue;
      const up = y > 0 && scratch[p - width];
      const down = y + 1 < height && scratch[p + width];
      const left = x > 0 && scratch[p - 1];
      const right = x + 1 < width && scratch[p + 1];
      if (!(up || down || left || right)) continue;
      mask[p] = 1;
    }
  }
}

/**
 * Paint the engine's colour slots with the caller's table (REFERENCE B3).
 *
 * Positional: slot i is the swatch at rank i in the palette editor, so it is
 * painted `override[i]`. A *shorter* override is a remove — the slots it does
 * not reach are painted with the nearest colour that survived, which is what
 * makes the removed colour disappear from the document without re-quantizing
 * the image. A *longer* one names colours no slot answers to; those entries
 * simply have no pixels, so they are dropped rather than inventing a layer.
 */
function repaintSlots(computed: RgbColor[], override: RgbColor[]): RgbColor[] {
  const out: RgbColor[] = [];
  for (let i = 0; i < computed.length; i++) {
    if (i < override.length) {
      out.push({ ...override[i] });
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < override.length; j++) {
      const d =
        Math.abs(computed[i].r - override[j].r) +
        Math.abs(computed[i].g - override[j].g) +
        Math.abs(computed[i].b - override[j].b);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    out.push({ ...override[best] });
  }
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Compute the palette that `vectorize` would use, without tracing. Used to
 * populate the palette editor quickly (REFERENCE B3).
 */
export async function computePalette(image: RasterImage, colorCount: number): Promise<RgbColor[]> {
  await tick();
  // Same alpha contract as `vectorize`, or the editor would offer the user a
  // swatch (usually black) that the drawing does not contain.
  return computePaletteSync(image, Math.round(clamp(colorCount, 2, 64)), opacityMask(image));
}

/**
 * "Enhance image with AI (experimental)" preprocessing: denoise + colour
 * simplification (REFERENCE B4). Pure image -> image; `vectorize` calls this
 * itself when `settings.enhance` is true. Exposed separately so the UI can show
 * the enhanced source in the preview and so instruments can measure its effect.
 */
export async function enhanceImage(image: RasterImage): Promise<RasterImage> {
  await tick();
  if (image.width <= 0 || image.height <= 0) return cloneRaster(image);
  return enhanceSync(image);
}

/**
 * Convert a vectorization result to EPS (REFERENCE D2).
 * Carries `%!PS-Adobe-3.0 EPSF-3.0` and `%%BoundingBox: 0 0 w h`.
 */
export function toEps(result: VectorizeResult): string {
  assertResult(result, 'toEps');
  return resultToEps(result);
}

/**
 * Convert a vectorization result to DXF (REFERENCE D3).
 * ASCII R12 DXF with HEADER `$EXTMIN`/`$EXTMAX` matching the artwork extents
 * and an ENTITIES section of POLYLINE geometry.
 */
export function toDxf(result: VectorizeResult, options?: DxfOptions): string {
  assertResult(result, 'toDxf');
  return resultToDxf(result, options);
}

/**
 * Convert a vectorization result to PDF (REFERENCE D5).
 * A one-page vector PDF whose MediaBox is the source pixel size.
 */
export function toPdf(result: VectorizeResult): string {
  assertResult(result, 'toPdf');
  return resultToPdf(result);
}

function assertResult(result: VectorizeResult, fn: string): void {
  if (!result || typeof result.svg !== 'string') {
    throw new TypeError(`${fn}(): expected a VectorizeResult with an svg string`);
  }
}

/** Convenience dispatcher used by the export buttons. */
export function serialize(result: VectorizeResult, format: VectorExportFormat): string {
  switch (format) {
    case 'svg':
      return result.svg;
    case 'eps':
      return toEps(result);
    case 'dxf':
      return toDxf(result);
    case 'pdf':
      return toPdf(result);
    default: {
      const never: never = format;
      throw new Error(`Unknown export format: ${String(never)}`);
    }
  }
}

/** True when the path/mime looks like something the app can ingest (REFERENCE A2). */
export function isSupportedInput(nameOrMime: string): boolean {
  const lower = nameOrMime.toLowerCase();
  if (SUPPORTED_INPUT_MIME_TYPES.includes(lower)) return true;
  return SUPPORTED_INPUT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export { EngineNotImplementedError };
