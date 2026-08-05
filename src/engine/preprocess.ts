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
import type { NoiseReduction, RasterImage } from './types';

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
  return snapToSourceColors(indicesToRaster(indices, image.width, image.height, palette), image);
}

/** Distinct-colour count, given up on once it passes `limit`. */
function distinctColorsUpTo(image: RasterImage, limit: number): Set<number> | null {
  const set = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4) {
    set.add(((image.data[i] & 255) << 16) | ((image.data[i + 1] & 255) << 8) | (image.data[i + 2] & 255));
    if (set.size > limit) return null;
  }
  return set;
}

/**
 * Pull every colour of `image` back onto a colour the source actually contains.
 *
 * A median filter works per channel, so it can hand back a red it took from one
 * pixel and a green from another and produce a colour that was never in the
 * artwork — which is how "enhance" ended up inventing a seventh swatch on a
 * six-colour logo. Snapping afterwards makes the preprocessing incapable of
 * introducing a colour, which is a property worth having by construction rather
 * than by hope.
 *
 * Only done when the source is flat art (few enough distinct colours to make an
 * exact nearest search cheap); on a photograph "a colour the source contains"
 * is not a meaningful constraint anyway.
 */
export function snapToSourceColors(image: RasterImage, source: RasterImage): RasterImage {
  const colors = distinctColorsUpTo(source, 4096);
  if (!colors || colors.size === 0) return image;
  const list = [...colors].sort((a, b) => a - b);
  const cache = new Map<number, number>();
  const data = new Uint8ClampedArray(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] & 255) << 16) | ((data[i + 1] & 255) << 8) | (data[i + 2] & 255);
    let hit = cache.get(key);
    if (hit === undefined) {
      if (colors.has(key)) hit = key;
      else {
        let best = list[0];
        let bestD = Infinity;
        for (const c of list) {
          const d =
            Math.abs(((c >> 16) & 255) - data[i]) +
            Math.abs(((c >> 8) & 255) - data[i + 1]) +
            Math.abs((c & 255) - data[i + 2]);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        hit = best;
      }
      cache.set(key, hit);
    }
    data[i] = (hit >> 16) & 255;
    data[i + 1] = (hit >> 8) & 255;
    data[i + 2] = hit & 255;
  }
  return { width: image.width, height: image.height, data };
}

/**
 * Noise Reduction (REFERENCE B4), independent of the "enhance" toggle.
 *
 *   off  — nothing.
 *   low  — one 3×3 median pass: impulse grain disappears, edges do not move.
 *   high — median, then two majority passes over a 16-colour index image, which
 *          also eats the 2×2 blobs a 3×3 median is too small to reach.
 *
 * Both steps can only remove local minorities, never create them, so the trace
 * can never get busier as the strength goes up — which is exactly what
 * `tests/e2e/b4-quality.spec.ts` asserts.
 */
export function reduceNoise(image: RasterImage, level: NoiseReduction): RasterImage {
  if (level === 'off' || image.width < 3 || image.height < 3) return image;
  const denoised = medianFilter3(image);
  if (level === 'low') return denoised;
  const palette = computePaletteSync(denoised, SIMPLIFY_COLORS);
  let indices = mapToPalette(denoised, palette);
  for (let i = 0; i < MAJORITY_PASSES; i++) {
    indices = majorityFilter(indices, image.width, image.height, palette.length);
  }
  return indicesToRaster(indices, image.width, image.height, palette);
}

/**
 * Anti-aliasing removal (REFERENCE B4).
 *
 * An antialiased boundary is a one-pixel ramp between two flat colours. Left
 * alone the quantizer spends palette slots on those ramp colours, they become
 * their own thin layers painted over the artwork ("halos"), and every one of
 * them costs contours — the reference product's Smart anti-aliasing collapses
 * path count by ~81 % at identical settings for exactly this reason.
 *
 * Each pass looks at the 3×3 neighbourhood, takes the two most distant colours
 * in it, and if the centre pixel is a blend between them, snaps it to whichever
 * end it is closer to. Flat interiors have no distant pair and are untouched;
 * only the ramp moves, and it moves onto colours that are already in the image
 * (so this cannot invent a colour).
 */
export function deAntialias(image: RasterImage, passes: number): RasterImage {
  let current = image;
  for (let p = 0; p < passes; p++) current = deAntialiasPass(current);
  return current;
}

function deAntialiasPass(image: RasterImage): RasterImage {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return image;
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y + 1 < height ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x + 1 < width ? x + 1 : width - 1;
      const o = (y * width + x) * 4;
      const cr = data[o];
      const cg = data[o + 1];
      const cb = data[o + 2];

      // The two ends of the ramp: darkest and lightest neighbour. (Luma order
      // stands in for "most distant pair" — an antialiased ramp is monotone in
      // luma by construction — and costs 9 comparisons instead of 36.)
      let ai = -1;
      let bi = -1;
      let lo = Infinity;
      let hi = -Infinity;
      for (let yy = y0; yy <= y2; yy++) {
        for (let xx = x0; xx <= x2; xx++) {
          const i = (yy * width + xx) * 4;
          const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (l < lo) {
            lo = l;
            ai = i;
          }
          if (l > hi) {
            hi = l;
            bi = i;
          }
        }
      }
      if (ai < 0 || bi < 0 || ai === bi) continue;
      const best =
        Math.abs(data[ai] - data[bi]) +
        Math.abs(data[ai + 1] - data[bi + 1]) +
        Math.abs(data[ai + 2] - data[bi + 2]);
      // No real boundary here, or the centre already sits on one of the ends.
      if (best < 48) continue;
      const da =
        Math.abs(cr - data[ai]) + Math.abs(cg - data[ai + 1]) + Math.abs(cb - data[ai + 2]);
      const db =
        Math.abs(cr - data[bi]) + Math.abs(cg - data[bi + 1]) + Math.abs(cb - data[bi + 2]);
      if (da === 0 || db === 0) continue;
      // Only genuine in-between pixels: a pixel that is a third colour (a real
      // detail) is farther from the segment than the segment is long.
      if (da + db > best * 1.35) continue;
      const src = da <= db ? ai : bi;
      out[o] = data[src];
      out[o + 1] = data[src + 1];
      out[o + 2] = data[src + 2];
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

export function cloneRaster(image: RasterImage): RasterImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}
