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
  // B4 — off by default: they are corrections, and a correction nobody asked
  // for is a surprise. The Enhance toggle is the one-click bundle.
  noiseReduction: 'off',
  antiAliasing: 'off',
  // B5 — the reference product's own defaults: middle roundness, 5px² specks
  // dropped. Overlap `high` keeps each layer trimmed to its own region, which
  // is the economical half of the pair.
  roundness: 1,
  minArea: 5,
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
 * How much of the Enhance region floor carries over to the *document* floor.
 *
 * The two floors measure different things: the index-image pass counts a
 * region's pixels, the trace-time pass measures a fitted shape's bounding box,
 * and a box overstates everything that is not a rectangle (a diagonal sliver's
 * box can be ten times its area). Half is the setting at which the document
 * floor removes the same class of shape — the 3-10px lobes a ragged edge sheds,
 * which are attached to their parent region and so invisible to any despeckle —
 * without reaching the diagonal strokes that a like-for-like number would eat.
 */
const SHAPE_FLOOR_OF_REGION_FLOOR = 0.5;

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
   * colour-simplification pass it turns on the two cleanups that make a busy
   * source legible: smart anti-aliasing, and a minimum shape area proportional
   * to the canvas — one ten-thousandth of it, ~87px² on the 1046x833 reference
   * artwork, ~26px² on a 512px logo. A checkbox that only nudges the output is
   * not the control the reference product has.
   */
  const smartAa = opts.antiAliasing === 'smart' || (opts.enhance && opts.antiAliasing === 'off');
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
  // centres. Clustering always comes from the image (with k = the override's
  // length); slot i of the result is then painted with override[i].
  //
  // This is what makes all three palette-editor operations (REFERENCE B3) fall
  // out of the single `settings.palette` knob:
  //   change — slot i keeps its pixels and is repainted. Re-clustering on the
  //            new colour instead would strand it: recolour the dominant paper
  //            tone to magenta and nearest-colour matching hands every paper
  //            pixel to some other entry, so the colour the user just picked
  //            never appears in the output.
  //   remove — k drops by one, the orphaned region is absorbed by whichever
  //            cluster now covers it, and the removed colour cannot appear.
  //   merge  — two slots are given the *same* colour. k is unchanged, so the
  //            clustering (and therefore every contour) is exactly what it was
  //            before the merge; the two slots then collapse into one layer
  //            painted with the target colour, and the palette shrinks by one.
  //            That is what distinguishes merge from remove: merging keeps the
  //            surviving colour's geometry identical and hands it the merged
  //            region, where removing re-quantizes the whole image.
  //
  // Slots are paired with clusters by coverage rank, which is the order the
  // palette editor displays them in, so slot i is the swatch the user clicked.
  report(onProgress, 'quantize', 0.15);
  const override = normalizePalette(opts.palette);
  const targetColors = override ? override.length : presetColorCount(opts);
  const clusters = computePaletteSync(source, Math.max(1, targetColors), opaque);
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
      maxThickness: smartAa ? 3 : 2,
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
  const enhanceFloor = opts.enhance && opts.despeckle > 0 ? (width * height) / 10000 : 0;
  if (enhanceFloor > 1) {
    despeckleIndices(indices, width, height, {
      minArea: enhanceFloor,
      palette: clusters,
      keepElongated: true,
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
      transparentIndex: TRANSPARENT_INDEX,
    });
  }
  report(onProgress, 'simplify', 0.4);
  await tick();

  let palette: RgbColor[];
  if (override) {
    // Keep the caller's order — the editor's swatch indices must survive a
    // re-vectorize — while collapsing slots that name the same colour into a
    // single layer. Slot i keeps its pixels; it just may share an output entry
    // with an earlier slot (that shared entry is a merge).
    palette = [];
    const entryOf = new Map<number, number>();
    const slotToEntry = new Int32Array(Math.max(clusters.length, override.length));
    for (let i = 0; i < override.length; i++) {
      const key = packRgb(override[i].r, override[i].g, override[i].b);
      let entry = entryOf.get(key);
      if (entry === undefined) {
        entry = palette.length;
        entryOf.set(key, entry);
        palette.push({ ...override[i] });
      }
      slotToEntry[i] = entry;
    }
    // Quantization never drops below two clusters, so a one-colour override can
    // come back with a cluster index no slot answers to. Fold the surplus onto
    // the last slot rather than leaving those pixels unpainted.
    for (let i = override.length; i < slotToEntry.length; i++) {
      slotToEntry[i] = slotToEntry[override.length - 1];
    }
    remapIndices(indices, slotToEntry);
  } else {
    // Re-rank by what actually survived quantization + despeckle, and drop
    // entries no pixel ended up using.
    const coverage = coverageOf(indices, clusters.length);
    const kept = clusters
      .map((color, i) => ({ color, i, n: coverage[i] }))
      .filter((e) => e.n > 0)
      .sort((a, b) => b.n - a.n || a.i - b.i);
    palette = kept.map((e) => ({ ...e.color }));
    const indexMap = new Uint8Array(clusters.length);
    kept.forEach((e, rank) => {
      indexMap[e.i] = rank;
    });
    remapIndices(indices, indexMap);
  }
  if (palette.length === 0) palette = [{ r: 0, g: 0, b: 0 }];

  // Two different collapses, both switched off by default and both skipped when
  // the user has hand-picked the palette (their table is authoritative):
  //   - Smart anti-aliasing folds away halo layers, which ARE near-duplicates
  //     of the colour they hug, so it merges by colour distance. 5.5 % of the
  //     RGB range is chosen so that no two surviving layers can be within the
  //     24-unit distance the halo metric looks for.
  //   - The output-groups merge threshold folds away colours that barely appear
  //     (REFERENCE B3), which is a coverage question.
  if (!override) {
    if (smartAa) palette = mergeSimilarColors(indices, palette, 5.5).palette;
    const groupThreshold = Math.max(opts.mergeThreshold, opts.enhance ? 1 : 0);
    if (groupThreshold > 0) palette = mergeSmallGroups(indices, palette, groupThreshold);
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
    straightTolerance: straightToleranceFor(opts.roundness),
    circleDetection: opts.circleDetection,
    /**
     * Enhance is a simplification bundle, so its canvas-proportional floor has
     * to reach the *document*, not just the index image.
     *
     * The index-image pass above (`enhanceFloor`) can only merge a small region
     * into a neighbour, and it deliberately spares strokes. What it cannot
     * touch is the shape a surviving region still traces to: a ragged edge
     * sheds dozens of 3-10px lobes that are attached to their parent region, so
     * no despeckle sees them, and every one costs a sub-path. The real
     * product's 16-colour output for the gold-standard artwork has NO sub-path
     * with a bounding box under ~200px²; ours had 106 of them. Reusing the same
     * floor here (a box-area test, so a long hairline with a 2px waist still
     * clears it) is what closes that gap.
     */
    minArea: Math.max(minArea, enhanceFloor * SHAPE_FLOOR_OF_REGION_FLOOR),
  };

  const disabled = new Set(opts.disabledColors);
  const enabled: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (finalCoverage[i] > 0 && !disabled.has(i)) enabled.push(i);
  }

  // Emission order (REFERENCE B3 "sort order"). Full overlap stacks layers
  // under each other, so there the order IS the geometry and coverage rank is
  // the only correct one; with trimmed (`high`) layers the picture is a
  // partition and the order is free.
  const order =
    opts.overlap === 'full'
      ? sortedOrder(palette, finalCoverage, 'coverage').filter((i) => enabled.includes(i))
      : sortedOrder(palette, finalCoverage, opts.sortOrder).filter((i) => enabled.includes(i));

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

  const layers: TracedLayer[] = [];
  const mask = new Uint8Array(width * height);
  for (let position = 0; position < order.length; position++) {
    const i = order[position];
    if (i !== backgroundIndex) {
      if (opts.overlap === 'full') {
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
      }
      layers.push(traceMask(mask, width, height, i, traceOptions));
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
  };
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
