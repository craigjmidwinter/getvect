/**
 * GetVect vectorization engine — PUBLIC INTERFACE (stub).
 *
 * This module is intentionally pure: no Electron, no DOM, no filesystem, no
 * network. It is imported by
 *   - the renderer (via a worker / IPC call) to produce previews and exports, and
 *   - `instruments/run-instruments.mjs` (via `dist/engine/index.js`) to measure
 *     fidelity headlessly.
 *
 * Builders: replace the throwing bodies below. Do NOT change the signatures —
 * the e2e suite and the instruments harness are written against them. If a
 * signature genuinely has to change, update docs/HARNESS.md and
 * instruments/run-instruments.mjs in the same commit.
 */

import {
  EngineNotImplementedError,
  type ProgressCallback,
  type RasterImage,
  type RgbColor,
  type VectorizeResult,
  type VectorizeSettings,
} from './types';

export * from './types';

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

/**
 * Convert a decoded raster image into an SVG.
 *
 * MUST be deterministic: the same (image, settings) pair must produce a
 * byte-identical `svg`, otherwise the fidelity instruments cannot detect
 * regressions.
 *
 * MUST NOT block the UI thread for long: call `onProgress` at least once per
 * phase and yield between phases (the renderer runs this in a worker).
 *
 * @param image    decoded RGBA raster (see RasterImage)
 * @param settings user settings; callers should spread over DEFAULT_SETTINGS
 * @param onProgress optional progress sink (REFERENCE B1 progress indicator)
 * @returns SVG string plus palette/pathCount/timing metadata
 */
export async function vectorize(
  image: RasterImage,
  settings: VectorizeSettings = DEFAULT_SETTINGS,
  onProgress?: ProgressCallback,
): Promise<VectorizeResult> {
  void image;
  void settings;
  void onProgress;
  throw new EngineNotImplementedError('vectorize');
}

/**
 * Compute the palette that `vectorize` would use, without tracing. Used to
 * populate the palette editor quickly (REFERENCE B3).
 */
export async function computePalette(image: RasterImage, colorCount: number): Promise<RgbColor[]> {
  void image;
  void colorCount;
  throw new EngineNotImplementedError('computePalette');
}

/**
 * "Enhance image with AI (experimental)" preprocessing: denoise + colour
 * simplification (REFERENCE B4). Pure image -> image; `vectorize` calls this
 * itself when `settings.enhance` is true. Exposed separately so the UI can show
 * the enhanced source in the preview and so instruments can measure its effect.
 */
export async function enhanceImage(image: RasterImage): Promise<RasterImage> {
  void image;
  throw new EngineNotImplementedError('enhanceImage');
}

/**
 * Convert a vectorization result to EPS (REFERENCE D2).
 * Output must carry `%!PS-Adobe-3.0 EPSF-3.0` and a `%%BoundingBox: 0 0 w h`.
 */
export function toEps(result: VectorizeResult): string {
  void result;
  throw new EngineNotImplementedError('toEps');
}

/**
 * Convert a vectorization result to DXF (REFERENCE D3).
 * Output must be an ASCII DXF with HEADER $EXTMIN/$EXTMAX matching the artwork
 * extents and an ENTITIES section containing the traced geometry.
 */
export function toDxf(result: VectorizeResult): string {
  void result;
  throw new EngineNotImplementedError('toDxf');
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
