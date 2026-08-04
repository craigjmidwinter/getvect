/**
 * GetVect engine types — the contract between the UI, the instruments harness
 * and whatever tracer implementation the builders drop in.
 *
 * Everything here is plain data (no Electron, no DOM, no fs) so that the engine
 * can be imported and exercised headlessly from Node by `npm run instruments`.
 */

/** 8-bit sRGB colour. Alpha is handled separately (the tracer is opaque-only). */
export interface RgbColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

/**
 * Decoded raster input. `data` is tightly packed RGBA, row-major, top-left
 * origin, length === width * height * 4. This is exactly what
 * `CanvasRenderingContext2D.getImageData()` produces in the renderer and what
 * `sharp(file).ensureAlpha().raw().toBuffer()` produces in Node — decoding is
 * deliberately NOT the engine's job.
 */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * User-tunable vectorization settings. Every field is a plain number/boolean so
 * settings can be serialized into IPC messages, test fixtures and metrics JSON.
 *
 * Ranges are inclusive and are what the UI sliders MUST emit (see
 * docs/TESTIDS.md for the matching DOM contract).
 */
export interface VectorizeSettings {
  /** Number of colours in the quantized palette. Range 2..64. Slider `color-count`. */
  colorCount: number;
  /**
   * How closely traced paths follow pixel edges. Range 0..100.
   * 0 = heavily simplified geometry, 100 = follow every pixel step.
   * Slider `detail`.
   */
  detail: number;
  /**
   * Curve-fitting aggressiveness. Range 0..100.
   * 0 = polyline only (no curves), 100 = maximum curve fitting.
   * Slider `smoothing`.
   */
  smoothing: number;
  /**
   * Speck removal. Range 0..100. Regions whose pixel area is below the
   * threshold implied by this value are merged into their surrounding region.
   * 0 = keep everything. Slider `despeckle`.
   */
  despeckle: number;
  /**
   * "Enhance image with AI (experimental)" toggle — denoise + colour
   * simplification preprocessing applied before quantization (REFERENCE B4).
   */
  enhance: boolean;
  /**
   * Optional explicit palette. When present the engine MUST use exactly these
   * colours instead of computing its own (this is how the palette editor's
   * change / merge / remove operations are expressed — REFERENCE B3).
   * When null/undefined the engine computes a palette of `colorCount` colours.
   */
  palette?: RgbColor[] | null;
}

/** Coarse progress phases, emitted in this order. */
export type VectorizePhase =
  | 'preprocess'
  | 'quantize'
  | 'trace'
  | 'simplify'
  | 'serialize'
  | 'done';

export interface VectorizeProgress {
  phase: VectorizePhase;
  /** 0..1 overall completion. Monotonically non-decreasing. */
  progress: number;
}

export type ProgressCallback = (p: VectorizeProgress) => void;

export interface VectorizeResult {
  /** Complete, standalone SVG document. This exact string is what gets exported (REFERENCE C3/D1). */
  svg: string;
  /** The palette actually used, ordered by descending pixel coverage. Drives the palette editor UI. */
  palette: RgbColor[];
  /** Number of `<path>` elements in `svg` (REFERENCE "Economy": <= 200 for flat-colour fixtures). */
  pathCount: number;
  /** Source dimensions; the SVG viewBox MUST be `0 0 width height`. */
  width: number;
  height: number;
  /** Wall-clock milliseconds spent inside `vectorize()`. */
  durationMs: number;
}

/** Thrown by the stub engine until a real implementation lands. */
export class EngineNotImplementedError extends Error {
  constructor(fn: string) {
    super(
      `GetVect engine: ${fn}() is not implemented yet. ` +
        `Implement it in src/engine/ — see docs/HARNESS.md "Engine interface contract".`,
    );
    this.name = 'EngineNotImplementedError';
  }
}
