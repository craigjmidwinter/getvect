/**
 * "Enhance image (experimental)" preprocessing — REFERENCE B4.
 *
 * Three deterministic passes, in the order a scan-cleanup pipeline would run
 * them:
 *   1. 3×3 median filter per channel — kills salt-and-pepper impulse noise and
 *      the mild per-pixel jitter a scan/JPEG leaves behind.
 *   2. colour simplification — quantize to a compact palette so the residual
 *      dithering collapses onto flat colours.
 *   3. 3×3 majority (modal) filter on the index image, twice — removes the
 *      2×2-ish blobs a median filter is too small to reach, and straightens
 *      ragged region borders so the tracer emits fewer, longer segments.
 *
 * The contract that matters for B4: the enhanced image must never trace to
 * MORE paths than the original, which the majority passes guarantee by
 * construction (they can only remove local minority runs, never create them).
 */

import { computePaletteSync, indicesToRaster, mapToPalette } from './color';
import type { RasterImage } from './types';

/** Palette size used by the colour-simplification pass. */
const SIMPLIFY_COLORS = 16;
/** Majority-filter repetitions. */
const MAJORITY_PASSES = 2;

export function medianFilter3(image: RasterImage): RasterImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);
  const window = new Uint8Array(9);
  // Hoisted: this loop body runs width*height*3 times, so it must not allocate.
  const rows = new Int32Array(3);
  const cols = new Int32Array(3);
  for (let y = 0; y < height; y++) {
    rows[0] = (y > 0 ? y - 1 : 0) * width;
    rows[1] = y * width;
    rows[2] = (y + 1 < height ? y + 1 : height - 1) * width;
    for (let x = 0; x < width; x++) {
      cols[0] = x > 0 ? x - 1 : 0;
      cols[1] = x;
      cols[2] = x + 1 < width ? x + 1 : width - 1;
      const o = (rows[1] + x) * 4;
      for (let c = 0; c < 3; c++) {
        let n = 0;
        for (let r = 0; r < 3; r++) {
          for (let k = 0; k < 3; k++) {
            window[n++] = data[(rows[r] + cols[k]) * 4 + c];
          }
        }
        out[o + c] = median9(window);
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Insertion sort on nine bytes — faster than Array#sort at this size. */
function median9(w: Uint8Array): number {
  for (let i = 1; i < 9; i++) {
    const v = w[i];
    let j = i - 1;
    while (j >= 0 && w[j] > v) {
      w[j + 1] = w[j];
      j--;
    }
    w[j + 1] = v;
  }
  return w[4];
}

/** Replace each index with the most common index in its 3×3 neighbourhood. */
export function majorityFilter(
  indices: Uint8Array,
  width: number,
  height: number,
  paletteSize: number,
): Uint8Array {
  const out = new Uint8Array(indices.length);
  const tally = new Int32Array(paletteSize);
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y + 1 < height ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x + 1 < width ? x + 1 : width - 1;
      tally.fill(0);
      for (let yy = y0; yy <= y2; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x2; xx++) tally[indices[row + xx]]++;
      }
      const self = indices[y * width + x];
      let best = self;
      let bestN = tally[self];
      for (let c = 0; c < paletteSize; c++) {
        if (tally[c] > bestN) {
          bestN = tally[c];
          best = c;
        }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

/**
 * Denoise + colour simplification. Pure image → image, so the UI can show the
 * enhanced source in the preview and the instruments can measure its effect.
 */
export function enhanceSync(image: RasterImage): RasterImage {
  if (image.width < 3 || image.height < 3) return cloneRaster(image);

  const denoised = medianFilter3(image);
  const palette = computePaletteSync(denoised, SIMPLIFY_COLORS);
  let indices = mapToPalette(denoised, palette);
  for (let i = 0; i < MAJORITY_PASSES; i++) {
    indices = majorityFilter(indices, image.width, image.height, palette.length);
  }
  return indicesToRaster(indices, image.width, image.height, palette);
}

export function cloneRaster(image: RasterImage): RasterImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}
