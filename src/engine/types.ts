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
/**
 * Model preset (REFERENCE B2). The reference product's first control: it decides
 * what *kind* of picture the tracer is looking at before any slider is read.
 */
export type ModelPreset = 'clipart' | 'photo' | 'sketch' | 'drawing';

/** Clipart's Detail Level enum, most detail first (REFERENCE B2). */
export type DetailLevel =
  | 'maximum'
  | 'ultra'
  | 'very-high'
  | 'high'
  | 'medium'
  | 'low'
  | 'minimum';

/** Noise reduction strength (REFERENCE B4). */
export type NoiseReduction = 'off' | 'low' | 'high';

/** Anti-aliasing handling (REFERENCE B4). `smart` is the halo-suppressing one. */
export type AntiAliasing = 'off' | 'smart' | 'mid';

/** How far a colour layer reaches under the layers above it (REFERENCE B5). */
export type Overlap = 'full' | 'high';

/** Filled layers vs stroked layers (REFERENCE B6). */
export type ResultStyle = 'filled' | 'stroked';

/** Output colour-layer ordering (REFERENCE B3, "sort order"). */
export type SortOrder = 'coverage' | 'brightness' | 'hue';

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

  // --- B2: model presets ----------------------------------------------------

  /** Model preset. Default `clipart` — flat artwork is the primary target. */
  preset?: ModelPreset;
  /**
   * Clipart's Detail Level. Multiplies the `detail` slider (see `detailFor` in
   * index.ts) so both controls stay live: `high` is the neutral step.
   */
  detailLevel?: DetailLevel;
  /** Drawing preset only: luminance split, 0..255. Default 128. */
  bwThreshold?: number;

  // --- B4: quality enhancement ---------------------------------------------

  /** Denoise strength applied before quantization. Default `off`. */
  noiseReduction?: NoiseReduction;
  /**
   * How antialiased edges are handled. `smart` folds transition pixels into the
   * flat colours they sit between, so a soft boundary does not spawn its own
   * near-duplicate colour layer; `mid` keeps a single blended step.
   */
  antiAliasing?: AntiAliasing;

  // --- B5: advanced vectorization ------------------------------------------

  /** Curve-fitting level: 0 = corners kept sharp, 1 = default, 2 = roundest. */
  roundness?: 0 | 1 | 2;
  /**
   * Minimum surviving shape area in px² — the reference product's 0 / 5 / 90.
   * Applied unconditionally (unlike the `despeckle` slider, which also weighs
   * contrast), so "no shape smaller than this survives" is literally true.
   */
  minArea?: number;
  /** Whether lower layers are painted under the layers above them. */
  overlap?: Overlap;
  /** Replace near-circular contours with exact circle geometry. */
  circleDetection?: boolean;

  // --- B6: result style -----------------------------------------------------

  /** Filled layers (default) or stroked outlines. */
  resultStyle?: ResultStyle;

  // --- B3: output colour groups --------------------------------------------

  /**
   * Palette indices whose layer is dropped from the output. Disabling the
   * dominant colour is how the sticker/decal workflow gets a transparent
   * background: no backdrop rect is emitted at all.
   */
  disabledColors?: number[];
  /**
   * Percentage (0..100) below which two output colours are considered the same
   * and merged into one layer. 0 disables merging; the reference product's
   * default step is 5 %.
   */
  mergeThreshold?: number;
  /** Order the colour layers are emitted in. */
  sortOrder?: SortOrder;
}

/** Every field of `VectorizeSettings` resolved to a concrete value. */
export type ResolvedSettings = Required<Omit<VectorizeSettings, 'palette'>> & {
  palette: RgbColor[] | null;
};

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
  /**
   * How many distinct colours the *image* supplied at the requested budget —
   * the palette as it stood after quantization and despeckling, before any of
   * the merges that are our own doing (Smart anti-aliasing's near-duplicate
   * fold, Enhance's small-group fold, the output merge threshold).
   *
   * Without this the UI cannot tell the two reasons a palette is short apart,
   * and the colour-count hint blamed the image for both: "10 colours in the
   * result — the image has no more to give" on artwork that hands over a full
   * 16 the moment the cleanup is switched off (docs/TESTIDS.md
   * `color-count-hint`).
   */
  sourceColors: number;
  /**
   * The colour table as the engine's own segmentation sees it: one entry per
   * surviving colour *slot*, in the coverage rank the palette editor displays,
   * including duplicates where two slots have been merged onto one colour.
   *
   * `palette` is this list with duplicates collapsed — what the SVG paints and
   * what the editor shows. `slots` is what an edit must be expressed against,
   * because it is the array `settings.palette` is positionally matched to
   * (slot i is painted `settings.palette[i]`). Handing back a *deduped* palette
   * after a merge would hand back k-1 colours for k slots, and every slot after
   * the merged one would be repainted with its neighbour's colour.
   */
  slots: RgbColor[];
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
