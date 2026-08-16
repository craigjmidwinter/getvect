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

/**
 * Palette size used by the colour-simplification pass.
 *
 * Note what this implies when the user's own budget is also 16: the cleanup
 * hands the quantizer a histogram with exactly 16 distinct colours, so
 * `computePaletteSync` takes its "the image has no more colours than the
 * budget, so reproduce them exactly" branch and the delivered palette IS this
 * pass's palette. That is the right answer — re-clustering colours the image
 * literally contains can only move them — but it is why Enhance is what decides
 * the colour table at high budgets, and why raising this number does not buy
 * more delivered colours: measured on the gold standard, 32 here left the
 * quantizer more colours to choose from and cost mean layer compactness
 * 3.67 -> 6.38 (the seams it was flattening came back), while the near-
 * duplicate fold still collapsed the result to the same 8 layers.
 */
const SIMPLIFY_COLORS = 16;
/** Majority-filter repetitions. */
const MAJORITY_PASSES = 2;
/**
 * Median repetitions.
 *
 * Two, because one 3x3 median cannot reach a 2x2 clump of grain — it is four of
 * nine samples, a tie rather than an outlier — and Enhance is the control whose
 * whole promise is that the noise goes away. Measured on
 * `fixtures/logo-noisy-512.png`, the second pass moves another 0.1 % of the
 * pixels and takes the enhanced trace from 5684 to 5444 bytes, which is what
 * keeps the bundle's contract ("ticking Enhance never hands back a bigger
 * document") true now that the un-enhanced pipeline denoises well on its own.
 */
const MEDIAN_PASSES = 2;
/**
 * How far a run of a colour may reach and still count as a NARROW part of its
 * region (`narrowHere`), in pixels each way from the pixel being judged. See the
 * note there for why this is 1 and not the vote's own radius.
 */
const NARROW_REACH = 1;
/** The axes a run is measured along: horizontal, vertical, both diagonals. */
const NARROW_AXES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

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
      // A hairline is an impulse to a median filter — three of nine samples
      // against six of paper — so an unguarded median erases exactly the line
      // art REFERENCE's use cases are made of. A line is continuous, though, so
      // a pixel with two opposite neighbours of its own colour is left alone
      // (same rule as `continuesRun`, which protects the index image).
      if (continuesColorRun(data, width, height, x, y)) {
        out[o] = data[o];
        out[o + 1] = data[o + 1];
        out[o + 2] = data[o + 2];
        out[o + 3] = 255;
        continue;
      }
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

/**
 * `continuesRun`, for colours rather than palette indices.
 *
 * "Its own colour" becomes "within `tolerance` L1 units of its own colour",
 * which is what makes it usable on an antialiased or slightly noisy source: the
 * middle of a stroke and the stroke either side of it are close, a salt-and-
 * pepper impulse and its neighbours are not.
 */
function continuesColorRun(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance = 48,
): boolean {
  const o = (y * width + x) * 4;
  const near = (dx: number, dy: number): boolean => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
    const i = (ny * width + nx) * 4;
    return (
      Math.abs(data[i] - data[o]) +
        Math.abs(data[i + 1] - data[o + 1]) +
        Math.abs(data[i + 2] - data[o + 2]) <=
      tolerance
    );
  };
  return (
    (near(-1, 0) && near(1, 0)) ||
    (near(0, -1) && near(0, 1)) ||
    (near(-1, -1) && near(1, 1)) ||
    (near(1, -1) && near(-1, 1))
  );
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

/**
 * Replace each index with the most common index in its 3×3 neighbourhood.
 *
 * `transparentIndex` (when set) is inert in both directions: a see-through pixel
 * keeps its value, and see-through neighbours cast no vote. Letting them vote
 * would erode the silhouette — a one-pixel-wide antenna sticking out into the
 * transparent field is a local minority and would be filtered away.
 */
export function majorityFilter(
  indices: Uint8Array,
  width: number,
  height: number,
  paletteSize: number,
  transparentIndex = -1,
): Uint8Array {
  const out = new Uint8Array(indices.length);
  const tally = new Int32Array(paletteSize);
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y + 1 < height ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const self = indices[y * width + x];
      if (self === transparentIndex || self >= paletteSize) {
        out[y * width + x] = self;
        continue;
      }
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x + 1 < width ? x + 1 : width - 1;
      tally.fill(0);
      for (let yy = y0; yy <= y2; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x2; xx++) {
          const v = indices[row + xx];
          if (v < paletteSize && v !== transparentIndex) tally[v]++;
        }
      }
      let best = self;
      let bestN = tally[self];
      for (let c = 0; c < paletteSize; c++) {
        if (tally[c] > bestN) {
          bestN = tally[c];
          best = c;
        }
      }
      // ...unless the centre is the middle of a run of its own colour.
      if (best !== self && continuesRun(indices, width, height, x, y, self)) best = self;
      out[y * width + x] = best;
    }
  }
  return out;
}

/**
 * One byte per pixel, 1 where the pixel's 4-connected same-index region holds
 * fewer than `minArea` pixels. Iterative flood fill — no recursion, so a
 * region the size of the image cannot blow the stack.
 */
function smallRegionMask(
  indices: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): Uint8Array {
  const n = width * height;
  const small = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const region = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue;
    const color = indices[start];
    let top = 0;
    let size = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      region[size++] = p;
      const x = p % width;
      if (x > 0 && !seen[p - 1] && indices[p - 1] === color) {
        seen[p - 1] = 1;
        stack[top++] = p - 1;
      }
      if (x + 1 < width && !seen[p + 1] && indices[p + 1] === color) {
        seen[p + 1] = 1;
        stack[top++] = p + 1;
      }
      if (p >= width && !seen[p - width] && indices[p - width] === color) {
        seen[p - width] = 1;
        stack[top++] = p - width;
      }
      if (p + width < n && !seen[p + width] && indices[p + width] === color) {
        seen[p + width] = 1;
        stack[top++] = p + width;
      }
    }
    if (size < minArea) for (let k = 0; k < size; k++) small[region[k]] = 1;
  }
  return small;
}

/**
 * Straighten the seams *between* colour regions (REFERENCE B4, the half of
 * Smart anti-aliasing a 3×3 window cannot reach).
 *
 * `majorityFilter` votes over 3×3, which is enough to delete a lone stray pixel
 * and nothing more: a sawtooth whose teeth are two pixels deep is a local
 * majority in every 3×3 window it appears in, so it survives, gets traced, and
 * comes back as the spiked seam that makes a 16-colour output read as a
 * posterized photograph rather than as clipart. Measured on the gold standard,
 * our mid-tone layers scored 5.65 and 5.36 on perimeter/(2·√(π·area)) against
 * the reference product's 4.35 and 2.87 for the equivalent cream and blue.
 *
 * So the seam gets a wider vote: a pixel that sits *on* a boundary (some
 * 4-neighbour disagrees with it) is flipped to whatever index owns more than
 * `share` of its (2·`radius`+1)² neighbourhood. Interior pixels are never
 * looked at, so a region can only be reshaped at its edge, and the super-
 * majority is what keeps the filter from redrawing the boundary itself: a
 * straight edge splits its window ~50/50 and nothing moves, while a tooth or a
 * notch is a small minority of a 5×5 and is filled in.
 *
 * Line art is exempt by the same rule that protects it from the 3×3 pass: a
 * pixel with two opposite neighbours of its own colour is in the middle of a
 * run, and a run is a stroke. Without that, this filter is a very effective
 * eraser of exactly the outlines the picture is made of.
 *
 * That exemption is spent on the `protect`ed indices — the ink — and nowhere
 * else, because the boundary between two shaded regions is *also* made of runs:
 * a sawtooth tooth is a run along the seam, so protecting every colour by run
 * continuation protects the defect and the filter does nothing (measured: mean
 * layer compactness 3.73 -> 3.72 on the gold standard). Guarding only the
 * strokes is the difference between an edge cleanup and a no-op.
 *
 * And a *small* region is never regularized at all, whatever colour it is.
 * The whole premise above is that a boundary pixel's window is mostly the two
 * regions the boundary separates, which stops being true once a region is
 * smaller than the window: every pixel of a 50px² disc is a boundary pixel and
 * a minority in its own 7×7, so the filter erodes it a ring per pass and a
 * small circle disappears — the case REFERENCE B5's circle detection is
 * measured on at radii down to 4. `minRegionArea` is that limit, expressed in
 * window areas so it moves with `radius`.

 */
export function regularizeBoundaries(
  indices: Uint8Array,
  width: number,
  height: number,
  paletteSize: number,
  transparentIndex = -1,
  protect?: Uint8Array,
  share = 0.55,
  radius = 3,
  /** Region area, in window areas, below which a region is left alone. */
  minRegionWindows = 4,
): Uint8Array {
  const out = Uint8Array.from(indices);
  if (width < 3 || height < 3 || paletteSize < 2) return out;
  const small = smallRegionMask(
    indices,
    width,
    height,
    (2 * radius + 1) * (2 * radius + 1) * minRegionWindows,
  );
  const tally = new Int32Array(paletteSize);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const self = indices[p];
      if (self === transparentIndex || self >= paletteSize) continue;
      // Only seams move. An interior pixel has nothing to be regularized against
      // and touching it would be a blur, not an edge cleanup.
      const onBoundary =
        (x > 0 && indices[p - 1] !== self) ||
        (x + 1 < width && indices[p + 1] !== self) ||
        (y > 0 && indices[p - width] !== self) ||
        (y + 1 < height && indices[p + width] !== self);
      if (!onBoundary) continue;
      // A whole shape, not a seam (see `minRegionWindows`).
      if (small[p]) continue;
      // ...and a whole *part* of a shape, by the same argument (`narrowHere`).
      if (narrowHere(indices, width, height, x, y, self, NARROW_REACH)) continue;
      // A stroke is thin by definition, so the wide vote that straightens a
      // shading boundary reads the middle of a stroke as a minority and eats
      // it — and unlike a seam, where both sides are nearly the right colour,
      // every pixel it takes is a hole in the drawing. So the ink keeps the
      // run-continuation exemption. Only the middle of a run, though: an ink
      // pixel that is NOT in a run is a lobe on a ragged outline and is exactly
      // what this filter should be tidying (blanket-exempting the ink measured
      // worse — 0.981x -> 0.972x of the reference product's paw strict ink recall,
      // because the same vote also *adds* ink where a stroke had a notch).
      if (protect?.[self] && continuesRun(indices, width, height, x, y, self)) continue;
      const y0 = Math.max(0, y - radius);
      const y2 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      tally.fill(0);
      let counted = 0;
      for (let yy = y0; yy <= y2; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x2; xx++) {
          const v = indices[row + xx];
          if (v >= paletteSize || v === transparentIndex) continue;
          tally[v]++;
          counted++;
        }
      }
      if (counted === 0) continue;
      let best = self;
      let bestN = tally[self];
      for (let c = 0; c < paletteSize; c++) {
        if (tally[c] > bestN) {
          bestN = tally[c];
          best = c;
        }
      }
      if (best !== self && bestN > counted * share) out[p] = best;
    }
  }
  return out;
}

/**
 * Longest sliver, in pixels, that is still residue rather than a drawn feature.
 *
 * The defect is one pixel THICK, so the length is what separates it from line
 * art: a stroke the artist drew keeps going. Measured on the mascot, whose
 * white finger under the chin stroke is 5px and whose shortest genuine 1px
 * horizontal detail is longer than this; the corpus sweep in the same lap is
 * what set the ceiling, not the one fixture that motivated it.
 */
const SLIVER_MAX_RUN = 8;
/**
 * Area below which a region is a whole SHAPE rather than something with a
 * boundary to trim, in pixels.
 *
 * The same number `regularizeBoundaries` uses for the same argument: its window
 * area (7x7) times `minRegionWindows` (4). A region smaller than that cannot be
 * judged by a filter whose evidence is a neighbourhood that swallows it.
 */
const SLIVER_MIN_REGION = 7 * 7 * 4;

/**
 * Trim the one-pixel slivers that BOTH cleanup passes are obliged to keep.
 *
 * The staircase instrument's worst site on the mascot is a hard rectangular
 * notch where the white bib meets the chin stroke, and walking it back through
 * the stages put it in the index image before `majorityFilter` ever ran. It is
 * not a quantizer bug: those source pixels really are (255,252,239) and the
 * neighbouring ones really are orange. It is a one-pixel-tall finger of the
 * anti-aliasing residue left where a stroke tip fades out, and the artwork is
 * full of them.
 *
 * What makes it reach the tracer intact is that every guard upstream is right
 * to protect it and none of them can see what it is:
 *   - `majorityFilter` exempts it through `continuesRun` — every interior pixel
 *     of the finger has its own colour to the left and to the right, which is
 *     the exact signature of a one-pixel stroke, the thing that guard exists
 *     for.
 *   - `regularizeBoundaries` exempts it through `narrowHere` — the finger is
 *     bounded above and below within the reach, which is the exact signature of
 *     a corridor or a spike tip, the thing THAT guard exists for.
 * So it survives both, and the fitter reproduces it faithfully, because it is
 * faithfully there.
 *
 * The one thing a sliver is that a stroke, a corridor and a spike tip are not:
 * SANDWICHED. Its two flanks are different colours from each other — it is a
 * seam artifact lying between two regions, not a feature with the same thing on
 * both sides. A spike tip has background above and below; a corridor has the
 * same ink on both sides; only a residue sliver separates two different
 * neighbours. That, plus a length ceiling, is the whole test.
 *
 * Ink is exempt regardless. Line art is the point of the picture (`RAMP_INK_LUMA`
 * makes the same argument upstream), and a short dark sliver between two colours
 * is far more likely to be a drawn detail than residue.
 */
export function trimSlivers(
  indices: Uint8Array,
  width: number,
  height: number,
  paletteSize: number,
  transparentIndex = -1,
  protect?: Uint8Array,
  maxRun = SLIVER_MAX_RUN,
): Uint8Array {
  let src = Uint8Array.from(indices);
  if (width < 3 || height < 3 || paletteSize < 2) return src;

  /**
   * One orientation. Steps along the run; the flanks are the two pixels
   * perpendicular to it. Called twice, so a one-pixel-WIDE vertical sliver is
   * caught by the same argument as a one-pixel-TALL horizontal one — and the
   * second pass reads the FIRST pass's output, not the original. Running both
   * against the original let the vertical pass re-decide a pixel the horizontal
   * pass had already moved, which is how the first cut of this filter *added*
   * two slivers to the spikes fixture's band seam while removing the notch it
   * was aimed at.
   */
  const sweep = (horizontal: boolean): void => {
    const out = Uint8Array.from(src);
    // Recomputed per sweep: the first sweep changes which regions are small.
    const small = smallRegionMask(src, width, height, SLIVER_MIN_REGION);
    const at = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= width || y >= height ? -1 : src[y * width + x];
    const major = horizontal ? width : height;
    const minor = horizontal ? height : width;
    const get = (a: number, b: number): number => (horizontal ? at(a, b) : at(b, a));
    const put = (a: number, b: number, v: number): void => {
      out[(horizontal ? b * width + a : a * width + b)] = v;
    };
    for (let b = 0; b < minor; b++) {
      let a = 0;
      while (a < major) {
        const self = get(a, b);
        if (self === transparentIndex || self < 0 || self >= paletteSize) {
          a++;
          continue;
        }
        // A sliver is one pixel thick: both flanks differ from it.
        const up = get(a, b - 1);
        const down = get(a, b + 1);
        if (up === self || down === self || up < 0 || down < 0) {
          a++;
          continue;
        }
        // Walk the maximal run that stays one pixel thick and one colour.
        let end = a;
        while (
          end + 1 < major &&
          get(end + 1, b) === self &&
          get(end + 1, b - 1) !== self &&
          get(end + 1, b + 1) !== self
        ) {
          end++;
        }
        const run = end - a + 1;
        if (run > maxRun || protect?.[self]) {
          a = end + 1;
          continue;
        }
        /**
         * A sliver DEAD-ENDS. A shading band that thins to one pixel for a
         * stretch and then thickens again is the same shape either side of the
         * thin part, and chopping it into `maxRun` pieces and handing each to a
         * flank is how the first cut of this filter put the spikes fixture's
         * band seam over its sliver gate (0.020% -> 0.024%) and the local
         * artwork's band fit over its own. So at least one end has to run out
         * of the colour entirely; an isthmus with more of itself at both ends
         * is a region, not residue.
         */
        if (get(a - 1, b) === self && get(end + 1, b) === self) {
          a = end + 1;
          continue;
        }
        // Sandwiched: one colour above, another below, and not the same one.
        let above = get(a, b - 1);
        let below = get(a, b + 1);
        let sandwiched = above !== below;
        for (let k = a; k <= end && sandwiched; k++) {
          if (get(k, b - 1) !== above || get(k, b + 1) !== below) sandwiched = false;
        }
        if (!sandwiched || above === transparentIndex || below === transparentIndex) {
          a = end + 1;
          continue;
        }
        /**
         * ...and only where the sliver is the EDGE of a region, not the whole of
         * a small one.
         *
         * This is the guard the first version was missing, and leaving it out is
         * what made the filter unsafe. `regularizeBoundaries` already makes this
         * argument for its own vote — "a whole shape, not a seam" — and it
         * applies here with more force, because this filter judges runs a single
         * pixel thick. A ten-pixel feature built out of one- and two-pixel runs
         * of several colours is a picture in which almost EVERY run is
         * sandwiched, so the filter stops trimming residue off a boundary and
         * starts rewriting the feature.
         *
         * Measured, on 16-colour artwork with Enhance: five scattered one-pixel
         * edits inside a 10x10px eye highlight changed which palette slot it
         * belonged to and cost it its sharp point (97.1 deg -> 73.6 deg), and a
         * 5x3px grey detail nearby came back as four fragments plus a needle
         * contour that scored 178 deg. The mascot's white finger, by contrast,
         * is the edge of a bib thousands of pixels in area — which is exactly the
         * difference this test reads.
         */
        if (small[(horizontal ? b * width + a : a * width + b)]) {
          a = end + 1;
          continue;
        }
        // Hand it to whichever flank has more of the neighbourhood: the sliver
        // is residue between two regions, so it belongs to the one that is
        // actually there.
        let nAbove = 0;
        let nBelow = 0;
        for (let k = a - 1; k <= end + 1; k++) {
          for (let d = -2; d <= 2; d++) {
            const v = get(k, b + d);
            if (v === above) nAbove++;
            else if (v === below) nBelow++;
          }
        }
        /**
         * ...but never INTO the ink.
         *
         * The first cut of this filter handed each sliver to whichever flank
         * had more of the neighbourhood, and at a sharp corner that flank is
         * the outline: the local artwork's face lost 23° of its bluntest corner
         * (97.1° -> 73.7°) and gained ink with it (coverage 1.96x -> 2.00x of
         * source), which is the exact failure this whole lap is supposed to
         * avoid. Ink is protected as a sliver's own colour for the same reason
         * it must be protected as a sliver's destination — growing a stroke is
         * as much a lie about the drawing as eating one.
         */
        let win = nAbove >= nBelow ? above : below;
        if (protect?.[win]) win = win === above ? below : above;
        if (protect?.[win]) {
          a = end + 1;
          continue;
        }
        for (let k = a; k <= end; k++) put(k, b, win);
        a = end + 1;
      }
    }
    src = out;
  };

  sweep(true);
  sweep(false);
  return src;
}

/**
 * Is this pixel inside a part of its region NARROWER than the vote window?
 *
 * `minRegionWindows` says a whole shape smaller than the window cannot be judged
 * by it — every pixel of a 50px² disc is a boundary pixel and a minority in its
 * own 7×7, so the vote erodes a ring per pass and the disc disappears. The same
 * is true of a *part* of a bigger shape, and that is the case an area test
 * cannot see: the mascot's nose is a 1000px² region, well clear of any floor,
 * whose right nostril is a corridor of pink a few pixels wide between two arms
 * of the outline. Inside that corridor the window is mostly ink, the vote
 * carries, the corridor fills in, and the notch the artist drew comes back as a
 * solid black wedge — which every ink metric in the harness reads as a triumph,
 * because all of the source's ink is still there and then some.
 *
 * A narrow part is one where the run of the pixel's own colour is bounded on
 * BOTH sides within `reach` along some axis. That is what separates it from the
 * defect this filter exists to remove: a sawtooth tooth is also a couple of
 * pixels across, but it is *attached* — walk perpendicular to the seam and one
 * direction runs on into the region's interior, so it is never bounded both ways
 * and it still gets tidied. Only a corridor, a lobe or a spike tip is.
 *
 * `reach` is ONE, and the number is measured rather than reasoned. The scale
 * that fails is the vote's own — a feature the 7×7 window swallows is a feature
 * the window cannot judge — so the reach that matches the argument is the
 * radius, and it does recover more: at 2 the spikes fixture's bluntest corner
 * goes 65° -> 112°, which is the parked target exactly, and the mascot's nose
 * crop spends 1.20x the source's ink instead of 1.29x. It also spares ragged
 * lobes this filter exists to trim, and the bill lands on the gold standard at
 * its default settings: `strokeWidthCvRatio` 1.88x -> 2.21x against a 2.20 bar
 * and `strokeWidthOverExemplar` 1.13x -> 1.25x against a 1.25 bar. A ratchet
 * loosened to claim a win is not a ratchet, so the reach stays where the two do
 * not collide and the distance is left on the instruments: the spikes fixture
 * ASPIRES to 112°, and every variant tried in between (guarding only the ink,
 * only the non-ink, only the passes after the first, only regions below a
 * fraction of the canvas, requiring the corridor to be enclosed by one colour or
 * to run a minimum length) moved the fox and the corner together.
 */
function narrowHere(
  indices: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  self: number,
  reach: number,
): boolean {
  for (const [dx, dy] of NARROW_AXES) {
    let bounded = true;
    for (const sign of [1, -1]) {
      let k = 1;
      for (; k <= reach; k++) {
        const nx = x + dx * k * sign;
        const ny = y + dy * k * sign;
        // The edge of the canvas bounds a run as surely as another colour does.
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) break;
        if (indices[ny * width + nx] !== self) break;
      }
      if (k > reach) {
        bounded = false;
        break;
      }
    }
    if (bounded) return true;
  }
  return false;
}

/**
 * Is (x, y) in the middle of a run of its own colour?
 *
 * A majority filter is a minority-remover, and a one-pixel-wide black line is a
 * minority in every window it passes through: three of nine pixels, against six
 * of paper. Left to vote, two passes of it erase exactly the strokes REFERENCE's
 * headline use cases are made of — the gold-standard artwork lost 7 % of its ink
 * that way, in dashes scattered along every outline.
 *
 * A line, though, is *continuous*: the pixel before it and the pixel after it
 * are the same colour. So a centre with two opposite neighbours of its own
 * colour is spared — that is the whole rule. It costs four comparisons, it needs
 * no length or thickness constant, and it leaves the filter's actual job intact:
 * an isolated speck has no opposite pair, and neither does the lobe on a ragged
 * boundary, while a pixel in a flat edge (which should not move either) does.
 */
function continuesRun(
  indices: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  self: number,
): boolean {
  const at = (dx: number, dy: number): number => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return -1;
    return indices[ny * width + nx];
  };
  return (
    (at(-1, 0) === self && at(1, 0) === self) ||
    (at(0, -1) === self && at(0, 1) === self) ||
    (at(-1, -1) === self && at(1, 1) === self) ||
    (at(1, -1) === self && at(-1, 1) === self)
  );
}

/**
 * Denoise + colour simplification. Pure image → image, so the UI can show the
 * enhanced source in the preview and the instruments can measure its effect.
 */
export function enhanceSync(image: RasterImage): RasterImage {
  if (image.width < 3 || image.height < 3) return cloneRaster(image);

  let denoised = image;
  for (let i = 0; i < MEDIAN_PASSES; i++) denoised = medianFilter3(denoised);
  const palette = computePaletteSync(denoised, SIMPLIFY_COLORS, null, false);
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
  const palette = computePaletteSync(denoised, SIMPLIFY_COLORS, null, false);
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

/** L1 colour distance within which two pixels count as "the same region". */
const SUPPORT_TOLERANCE = 30;
/**
 * Per-pixel step below which a run of colour reads as shading, not as an edge.
 *
 * The same window as `SUPPORT_TOLERANCE`, and measured rather than assumed: at
 * 12 the gold-standard artwork's paw pads still lost their brown (the pad's
 * shading steps further than that per pixel where it turns), at 30 the brown
 * survives and the palette regains a warm slot. A soft edge between two flat
 * regions steps tens of units per pixel even when it is three pixels wide, so
 * it stays snappable either way.
 */
const RAMP_STEP_TOLERANCE = 30;
/**
 * Luma below which a ramp's dark end counts as ink, and the shading guard steps
 * aside.
 *
 * Line art is the point of the picture, and a soft outline is the one wide ramp
 * that MUST still be snapped: left alone, its skirt quantizes to whatever
 * mid-tone is nearest and the stroke comes back thin, notched or dashed.
 * Measured on the gold standard, exempting ink ramps put the 16-colour output's
 * layer compactness back to 3.73 (from 4.10) and its region strict-ink recall
 * back to 0.941x of the reference product's (from 0.927x) while keeping the paw
 * pads' brown.
 */
const RAMP_INK_LUMA = 60;
/**
 * How far onto the paper side of an *ink* ramp the snap still resolves to ink.
 *
 * The nearest end is the right answer for a ramp between two ordinary colours:
 * it is symmetric, and a boundary that lands half a pixel either way is a
 * boundary either way. It is the wrong answer for a stroke. A drawn outline is
 * ink at full strength plus a skirt of partial coverage on BOTH sides, so
 * splitting each skirt down the middle hands back a line thinner than the one
 * the artist drew — and once it is thinner than a pixel it renders as a grey
 * smear and, wherever the skirt was asymmetric, as a break. Measured on the
 * gold standard, the reference product's paw crop carries 2496 ink pixels where the
 * source has 1210 and ours had 1755: it resolves the whole skirt to ink, and
 * that is why its outlines read as solid where ours read as dashed.
 *
 * 3 means "the centre goes to ink unless it is more than three times as far
 * from the ink as from the paper". A luma-anchored rule ("a centre darker than
 * 60 is ink") reads better on paper and measures worse — by the time this pass
 * runs, Enhance's median has already lifted the skirt above 60, so the anchor
 * has nothing left to catch and the gold standard's paw crop drops from 0.941
 * to 0.908 of the reference product's strict ink recall. The ratio does not care how
 * dark the ends are, which is exactly why it survives the pass in front of it.
 */
const INK_RAMP_BIAS = 3;
/** How many pixels of its own colour a 3×3 window needs to be a real region. */
const SUPPORT_MIN = 3;
/**
 * How far past a light pixel we look for a SECOND stroke before dropping the ink
 * bias, in pixels.
 *
 * `INK_RAMP_BIAS` resolves the whole skirt of an outline to ink, which is right
 * for a stroke with paper on the other side of it and catastrophic for two
 * strokes drawn close together: each one eats about a pixel of the light gap
 * from its own side, and the artwork stops having a gap. On the reported case —
 * a character's claws, four white triangles whose outlines are separated by two
 * to three pixels of lighter pixels — one pass of this welded two of them and
 * the majority filter then removed what was left of the seam, so four claws
 * arrived as a lumpy black chain with rounded holes in it. It grew the ink field
 * of that drawing by 7561 pixels, 13 %.
 *
 * So the bias is a claim about what is on the *other* side of the light pixel,
 * and the claim is checkable: walk away from the ink and see whether more ink
 * turns up within a few pixels. If it does, this is not a skirt with paper
 * behind it, it is the corridor between two strokes, and the ramp resolves the
 * symmetric way — nearest end wins — so each side keeps its own half and the
 * gap survives.
 *
 * 2, and the number was measured rather than reasoned. It is the shortest reach
 * that protects the case in the contract — the *first* light pixel of a two-pixel
 * gap sees the far stroke's skirt two steps away — and reach is not free: at 3
 * the guard also spares the skirt between strokes that are merely near each
 * other, those mid-tones survive quantization as their own histogram mode, and
 * the gold standard's `sourceColors` went 6 -> 7 with the extra one immediately
 * folded back out as a near-duplicate (`paletteShortfall` 1 -> 2). Protecting
 * the gap is the job; leaving quantization debris behind is not.
 */
const INK_GAP_GUARD = 2;

/**
 * Walking away from the dark end of a ramp, is there another stroke close by?
 *
 * True means the centre pixel sits in a narrow light corridor between two dark
 * strokes rather than on the outside skirt of one (see `INK_GAP_GUARD`).
 */
function inkWithin(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  sx: number,
  sy: number,
  reach: number,
): boolean {
  for (let k = 1; k <= reach; k++) {
    const nx = x + sx * k;
    const ny = y + sy * k;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
    const i = (ny * width + nx) * 4;
    if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < RAMP_INK_LUMA) return true;
  }
  return false;
}

/**
 * How many of a pixel's eight neighbours share its colour.
 *
 * This is what separates an *edge* from a *speck*. The ramp snapper below reads
 * the darkest and lightest pixel of a 3×3 window as the two sides of an
 * antialiased boundary — but on a speckled scan the darkest pixel of a window
 * is usually a single impulse, and snapping the neighbourhood onto it turns
 * grain into geometry. Measured on `fixtures/logo-noisy-512.png`, Smart
 * anti-aliasing without this test tore the flat paper into two near-identical
 * layers and cost 9.3/255 mean colour error and 812 extra sub-paths against the
 * clean artwork; a side of a real boundary always has company in the window.
 */
function supportMap(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const support = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y2 = y + 1 < height ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x2 = x + 1 < width ? x + 1 : width - 1;
      const o = (y * width + x) * 4;
      let n = 0;
      for (let yy = y0; yy <= y2; yy++) {
        for (let xx = x0; xx <= x2; xx++) {
          const i = (yy * width + xx) * 4;
          if (
            Math.abs(data[i] - data[o]) +
              Math.abs(data[i + 1] - data[o + 1]) +
              Math.abs(data[i + 2] - data[o + 2]) <=
            SUPPORT_TOLERANCE
          ) {
            n++;
          }
        }
      }
      support[y * width + x] = n > 255 ? 255 : n;
    }
  }
  return support;
}

/**
 * Does the centre's own colour continue one pixel each way along (sx, sy)?
 *
 * The tolerance is the same "same region" window the support map uses: a
 * gradient steps a unit or two per pixel and stays inside it, an antialiasing
 * ramp jumps most of the way to a flat colour and does not.
 */
function sameColorBothWays(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  sx: number,
  sy: number,
): boolean {
  const o = (y * width + x) * 4;
  const near = (dx: number, dy: number): boolean => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return false;
    const i = (ny * width + nx) * 4;
    return (
      Math.abs(data[i] - data[o]) +
        Math.abs(data[i + 1] - data[o + 1]) +
        Math.abs(data[i + 2] - data[o + 2]) <=
      RAMP_STEP_TOLERANCE
    );
  };
  return near(sx, sy) && near(-sx, -sy);
}

function deAntialiasPass(image: RasterImage): RasterImage {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return image;
  const support = supportMap(data, width, height);
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
      let ax = 0;
      let ay = 0;
      let bx = 0;
      let by = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let yy = y0; yy <= y2; yy++) {
        for (let xx = x0; xx <= x2; xx++) {
          // Only pixels that belong to a region may define one of its ends: a
          // lone impulse is noise, and snapping a neighbourhood onto it is how
          // grain becomes geometry.
          if (support[yy * width + xx] < SUPPORT_MIN) continue;
          const i = (yy * width + xx) * 4;
          const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (l < lo) {
            lo = l;
            ai = i;
            ax = xx;
            ay = yy;
          }
          if (l > hi) {
            hi = l;
            bi = i;
            bx = xx;
            by = yy;
          }
        }
      }
      if (ai < 0 || bi < 0 || ai === bi) continue;
      // A ramp is THIN. Shading is not.
      //
      // Everything below reads a 3×3 window as "two flat regions with a
      // transition pixel between them", and an antialiased edge is exactly
      // that: one pixel wide, so stepping across it lands on flat colour
      // immediately. A painted gradient satisfies the same in-between test just
      // as well — its interior is always between its own neighbours — and
      // snapping it repeatedly pushes the shading out to its extremes. On the
      // gold-standard artwork that cost the whole brown family: the pads' and
      // belly's mid-tones were pressed onto cream and blue, the histogram lost
      // their mass, and at eight colours the quantizer spent three slots on
      // creams and none on brown, so the paw pads came back teal.
      //
      // So the centre only moves when the ramp really is one pixel wide:
      // stepping one pixel each way ALONG the gradient (the direction from the
      // dark end of the window to the light end) has to leave the centre's own
      // colour behind. This is `continuesRun`'s rule — a pixel in the middle of
      // a run of its own colour is artwork, not an edge — restricted to the one
      // direction that distinguishes a ramp from a region, since along the edge
      // itself an antialiased pixel does have company. Ramps that run into ink
      // are exempt (`RAMP_INK_LUMA`): a soft outline is a wide ramp that still
      // has to be snapped, or the stroke comes back thin.
      const sx = bx > ax ? 1 : bx < ax ? -1 : 0;
      const sy = by > ay ? 1 : by < ay ? -1 : 0;
      if (
        lo >= RAMP_INK_LUMA &&
        (sx !== 0 || sy !== 0) &&
        sameColorBothWays(data, width, height, x, y, sx, sy)
      )
        continue;
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
      // A ramp into ink resolves toward the ink (see `INK_RAMP_BIAS`): the
      // skirt of a stroke belongs to the stroke, not half to the paper — unless
      // there is no paper behind it, only the next stroke (`INK_GAP_GUARD`), in
      // which case the two strokes would each eat their half of the gap between
      // them and meet in the middle.
      const inkRamp = lo < RAMP_INK_LUMA;
      const inkBias = inkRamp && !inkWithin(data, width, height, x, y, sx, sy, INK_GAP_GUARD);
      const src = (inkBias ? da <= db * INK_RAMP_BIAS : da <= db) ? ai : bi;
      out[o] = data[src];
      out[o + 1] = data[src + 1];
      out[o + 2] = data[src + 2];
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * Give the see-through part of the image a colour it can be filtered against.
 *
 * A canvas hands back `(0,0,0,0)` for every transparent pixel, so as far as any
 * 3×3 neighbourhood filter is concerned a sticker sits on a field of pure
 * black — the median pass darkens its outline, `deAntialias` reads the sprite
 * edge as a ramp into black and snaps it there, and the artwork grows a bruise
 * one to two pixels deep all the way round. Nothing downstream *draws* these
 * pixels (they carry `TRANSPARENT_INDEX` from `mapToPalette` on), but they are
 * still neighbours, so they have to be plausible.
 *
 * So the drawn colours are dilated outwards a few pixels, and whatever is still
 * uncovered is filled with the average drawn colour: locally the field
 * continues the edge it touches, globally it is flat, and in neither case can
 * it introduce contrast that was not in the picture.
 */
export function bleedTransparent(
  image: RasterImage,
  opaque: Uint8Array,
  passes = 3,
): RasterImage {
  const { width, height } = image;
  const n = width * height;
  const data = new Uint8ClampedArray(image.data);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let drawn = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (!opaque[p]) continue;
    sumR += data[i];
    sumG += data[i + 1];
    sumB += data[i + 2];
    drawn++;
  }
  if (drawn === 0) return { width, height, data };
  const meanR = Math.round(sumR / drawn);
  const meanG = Math.round(sumG / drawn);
  const meanB = Math.round(sumB / drawn);

  const filled = Uint8Array.from(opaque);
  for (let pass = 0; pass < passes; pass++) {
    const grown = Uint8Array.from(filled);
    let any = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (filled[p]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let k = 0;
        const y0 = y > 0 ? y - 1 : 0;
        const y2 = y + 1 < height ? y + 1 : height - 1;
        const x0 = x > 0 ? x - 1 : 0;
        const x2 = x + 1 < width ? x + 1 : width - 1;
        for (let yy = y0; yy <= y2; yy++) {
          for (let xx = x0; xx <= x2; xx++) {
            const q = yy * width + xx;
            if (!filled[q]) continue;
            const i = q * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            k++;
          }
        }
        if (k === 0) continue;
        const i = p * 4;
        data[i] = Math.round(r / k);
        data[i + 1] = Math.round(g / k);
        data[i + 2] = Math.round(b / k);
        data[i + 3] = 255;
        grown[p] = 1;
        any = true;
      }
    }
    filled.set(grown);
    if (!any) break;
  }

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (filled[p]) continue;
    data[i] = meanR;
    data[i + 1] = meanG;
    data[i + 2] = meanB;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

export function cloneRaster(image: RasterImage): RasterImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}
