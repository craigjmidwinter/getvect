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
  computePaletteSync,
  coverageOf,
  despeckleIndices,
  mapToPalette,
  normalizePalette,
  packRgb,
} from './color';
import { resultToDxf, type DxfOptions } from './dxf';
import { resultToEps } from './eps';
import { cloneRaster, enhanceSync } from './preprocess';
import { renderSvg } from './svg';
import { paddedIndexArray, traceLayer, type TracedLayer } from './trace';
import {
  EngineNotImplementedError,
  type ProgressCallback,
  type RasterImage,
  type RgbColor,
  type VectorizePhase,
  type VectorizeResult,
  type VectorizeSettings,
} from './types';

export * from './types';
export { hexOf, parseHex } from './color';

/** Input formats the app accepts (REFERENCE A1/A2). */
export const SUPPORTED_INPUT_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.bmp'];
export const SUPPORTED_INPUT_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/bmp',
  'image/x-ms-bmp',
];

/** Export formats (REFERENCE D1-D3). */
export type ExportFormat = 'svg' | 'eps' | 'dxf';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['svg', 'eps', 'dxf'];

/**
 * Defaults used for the automatic vectorization that runs on image load
 * (REFERENCE B1). The instruments harness measures with exactly these unless
 * a fixture overrides them.
 */
export const DEFAULT_SETTINGS: VectorizeSettings = {
  colorCount: 8,
  detail: 60,
  smoothing: 50,
  despeckle: 20,
  enhance: false,
  palette: null,
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
 * Detail → straight-line error threshold, in pixels. High detail tracks every
 * pixel step; low detail lets a segment stray several pixels from the contour
 * before it is split, which is what "simplified geometry" means in practice.
 */
export function ltresFor(detail: number): number {
  const d = norm(detail);
  return round4(0.02 + (1 - d) ** 2.5 * 12);
}

/**
 * Smoothing → quadratic error threshold. At 0 the fitter can essentially never
 * accept a curve, so the output is a polyline; at 100 it fits long sweeps.
 */
export function qtresFor(smoothing: number): number {
  const s = norm(smoothing);
  if (s === 0) return 0.01;
  return round4(0.05 + s ** 1.6 * 4);
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

/** Despeckle → imagetracerjs `pathomit` (edge-node count floor). */
export function pathOmitFor(despeckle: number): number {
  return Math.round(norm(despeckle) * 12);
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Path-data precision. One decimal is *exact* here, not a compromise: the
 * tracer places every node on a pixel corner or on the midpoint between two of
 * them, so every coordinate it can produce is a multiple of 0.5. A second
 * decimal would only add bytes.
 */
const PATH_PRECISION = 1;

/**
 * Multiplier on the tracer's stroke compensation (see `STROKE_BANDS` in
 * trace.ts). 1 = apply it as designed.
 */
const STROKE_SCALE = 1;

export function resolveSettings(settings?: Partial<VectorizeSettings> | null): VectorizeSettings {
  const s = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  return {
    colorCount: Math.round(clamp(s.colorCount, 2, 64)),
    detail: clamp(s.detail, 0, 100),
    smoothing: clamp(s.smoothing, 0, 100),
    despeckle: clamp(s.despeckle, 0, 100),
    enhance: Boolean(s.enhance),
    palette: s.palette ?? null,
  };
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
  report(onProgress, 'preprocess', 0.02);
  const source = opts.enhance ? enhanceSync(image) : image;
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
  const targetColors = override ? override.length : opts.colorCount;
  const clusters = computePaletteSync(source, Math.max(2, targetColors));
  let indices = mapToPalette(source, clusters);
  report(onProgress, 'quantize', 0.32);
  await tick();

  // 3. Despeckle ------------------------------------------------------------
  // Contrast is judged against the cluster colours — the colours actually in
  // the source — not against whatever the user recoloured them to.
  const minArea = minAreaFor(opts.despeckle, width, height);
  if (minArea > 1) {
    despeckleIndices(indices, width, height, {
      minArea,
      palette: clusters,
      maxContrast: maxContrastFor(opts.despeckle),
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
    for (let p = 0; p < indices.length; p++) indices[p] = slotToEntry[indices[p]];
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
    for (let p = 0; p < indices.length; p++) indices[p] = indexMap[indices[p]];
  }
  if (palette.length === 0) palette = [{ r: 0, g: 0, b: 0 }];

  const finalCoverage = coverageOf(indices, palette.length);

  // 4. Trace ----------------------------------------------------------------
  report(onProgress, 'trace', 0.45);
  const padded = paddedIndexArray(indices, width, height);
  const traceOptions = {
    ltres: ltresFor(opts.detail),
    qtres: qtresFor(opts.smoothing),
    pathomit: pathOmitFor(opts.despeckle),
    rightangleenhance: true,
  };

  // The heaviest layer becomes a backdrop rect rather than an outline.
  let backgroundIndex = -1;
  if (palette.length > 1) {
    let best = -1;
    for (let i = 0; i < palette.length; i++) {
      if (finalCoverage[i] > best) {
        best = finalCoverage[i];
        backgroundIndex = i;
      }
    }
  }

  const layers: TracedLayer[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (i !== backgroundIndex && finalCoverage[i] > 0) {
      layers.push(traceLayer(padded, i, traceOptions));
    }
    report(onProgress, 'trace', 0.45 + 0.4 * ((i + 1) / palette.length));
    if (i % 4 === 3) await tick();
  }
  await tick();

  // 5. Serialize ------------------------------------------------------------
  report(onProgress, 'serialize', 0.9);
  const rendered = renderSvg(layers, palette, {
    width,
    height,
    precision: PATH_PRECISION,
    backgroundIndex,
    strokeScale: STROKE_SCALE,
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
  return computePaletteSync(image, Math.round(clamp(colorCount, 2, 64)));
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

function assertResult(result: VectorizeResult, fn: string): void {
  if (!result || typeof result.svg !== 'string') {
    throw new TypeError(`${fn}(): expected a VectorizeResult with an svg string`);
  }
}

/** Convenience dispatcher used by the export IPC handler. */
export function serialize(result: VectorizeResult, format: ExportFormat): string {
  switch (format) {
    case 'svg':
      return result.svg;
    case 'eps':
      return toEps(result);
    case 'dxf':
      return toDxf(result);
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
