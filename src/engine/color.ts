/**
 * Colour analysis: histogram → palette (median cut + Lloyd refinement) →
 * indexed image → area-thresholded despeckle.
 *
 * Everything here is deterministic: no `Math.random`, no time, no iteration
 * over unordered structures without an explicit sort. Same input ⇒ same output.
 */

import type { RasterImage, RgbColor } from './types';

/** Packed 0xRRGGBB. */
export type PackedRgb = number;

export const packRgb = (r: number, g: number, b: number): PackedRgb =>
  ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

export const unpackRgb = (v: PackedRgb): RgbColor => ({
  r: (v >> 16) & 255,
  g: (v >> 8) & 255,
  b: v & 255,
});

export function hexOf(c: RgbColor): string {
  const h = (v: number) => clamp255(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * `rgb(r, g, b)` — the notation REFERENCE D1 documents and the exemplars in
 * fixtures/reference use, so a diff against real product output is about
 * geometry rather than syntax.
 */
export function rgbOf(c: RgbColor): string {
  return `rgb(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)})`;
}

/** Rec. 601 luma, 0..255. */
export const lumaOf = (c: RgbColor): number => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/** Hue angle in degrees, 0..360; 0 for greys. */
export function hueOf(c: RgbColor): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === c.r) h = ((c.g - c.b) / d) % 6;
  else if (max === c.g) h = (c.b - c.r) / d + 2;
  else h = (c.r - c.g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function parseHex(hex: string): RgbColor | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return unpackRgb(v);
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Distinct colours of an image with their pixel counts, sorted by packed value. */
export interface Histogram {
  colors: Uint32Array;
  counts: Uint32Array;
  distinct: number;
  total: number;
}

export function buildHistogram(image: RasterImage): Histogram {
  const { data } = image;
  const pixels = image.width * image.height;
  const map = new Map<number, number>();
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const key = packRgb(data[i], data[i + 1], data[i + 2]);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  const distinct = map.size;
  const colors = new Uint32Array(distinct);
  const counts = new Uint32Array(distinct);
  let n = 0;
  for (const key of map.keys()) colors[n++] = key;
  // Sorting makes every downstream decision independent of insertion order.
  colors.sort();
  for (let k = 0; k < distinct; k++) counts[k] = map.get(colors[k]) as number;
  return { colors, counts, distinct, total: pixels };
}

/** L1 (rectilinear) RGB distance — the metric imagetracerjs uses internally. */
const dist = (
  r: number,
  g: number,
  b: number,
  c: { r: number; g: number; b: number },
): number => Math.abs(c.r - r) + Math.abs(c.g - g) + Math.abs(c.b - b);

interface Box {
  lo: number;
  hi: number; // exclusive
  count: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function boxOf(order: Int32Array, colors: Uint32Array, counts: Uint32Array, lo: number, hi: number): Box {
  let count = 0;
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (let i = lo; i < hi; i++) {
    const c = colors[order[i]];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
    count += counts[order[i]];
  }
  return { lo, hi, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

const splittable = (b: Box) =>
  b.hi - b.lo > 1 && (b.rMax > b.rMin || b.gMax > b.gMin || b.bMax > b.bMin);

/**
 * Median cut over the exact colour histogram. Boxes holding a single distinct
 * colour are never split, so an image with fewer distinct colours than
 * `colorCount` yields those colours *exactly* — which is what makes the flat
 * fixtures reproduce pixel-perfectly.
 */
function medianCut(hist: Histogram, colorCount: number): Int32Array[] {
  const { colors, counts, distinct } = hist;
  const order = new Int32Array(distinct);
  for (let i = 0; i < distinct; i++) order[i] = i;

  let boxes: Box[] = [boxOf(order, colors, counts, 0, distinct)];

  while (boxes.length < colorCount) {
    // Split the heaviest splittable box; ties broken by position for determinism.
    let target = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!splittable(b)) continue;
      const volume = (b.rMax - b.rMin + 1) * (b.gMax - b.gMin + 1) * (b.bMax - b.bMin + 1);
      const score = b.count * Math.cbrt(volume);
      if (score > best) {
        best = score;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const rSpan = box.rMax - box.rMin;
    const gSpan = box.gMax - box.gMin;
    const bSpan = box.bMax - box.bMin;
    // Weight spans perceptually so we cut where the eye cares most.
    const rw = rSpan * 0.5;
    const gw = gSpan * 0.6;
    const bw = bSpan * 0.4;
    const shift = rw >= gw && rw >= bw ? 16 : gw >= bw ? 8 : 0;

    const slice = Array.from(order.subarray(box.lo, box.hi));
    slice.sort((a, b) => {
      const ka = (colors[a] >> shift) & 255;
      const kb = (colors[b] >> shift) & 255;
      return ka - kb || colors[a] - colors[b];
    });
    for (let i = 0; i < slice.length; i++) order[box.lo + i] = slice[i];

    const half = box.count / 2;
    let acc = 0;
    let cut = box.lo + 1;
    for (let i = box.lo; i < box.hi - 1; i++) {
      acc += counts[order[i]];
      cut = i + 1;
      if (acc >= half) break;
    }
    if (cut <= box.lo) cut = box.lo + 1;
    if (cut >= box.hi) cut = box.hi - 1;

    boxes.splice(
      target,
      1,
      boxOf(order, colors, counts, box.lo, cut),
      boxOf(order, colors, counts, cut, box.hi),
    );
  }

  boxes = boxes.filter((b) => b.hi > b.lo);
  return boxes.map((b) => order.slice(b.lo, b.hi));
}

function centroid(members: Int32Array, hist: Histogram): RgbColor {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < members.length; i++) {
    const idx = members[i];
    const c = hist.colors[idx];
    const w = hist.counts[idx];
    r += ((c >> 16) & 255) * w;
    g += ((c >> 8) & 255) * w;
    b += (c & 255) * w;
    n += w;
  }
  if (n === 0) return { r: 0, g: 0, b: 0 };
  return { r: clamp255(r / n), g: clamp255(g / n), b: clamp255(b / n) };
}

/**
 * Compute a palette of at most `colorCount` colours, ordered by descending
 * pixel coverage. Deterministic; identical input ⇒ identical output.
 */
export function computePaletteSync(image: RasterImage, colorCount: number): RgbColor[] {
  const k = Math.max(1, Math.min(64, Math.round(colorCount)));
  const hist = buildHistogram(image);
  if (hist.distinct === 0) return [{ r: 0, g: 0, b: 0 }];

  const clusters = medianCut(hist, k);
  let palette = clusters.map((m) => centroid(m, hist));

  // Lloyd refinement only matters when we are actually approximating.
  if (hist.distinct > palette.length) {
    palette = refine(hist, palette, 6);
  }
  palette = reserveDarkest(hist, palette);

  return orderByCoverage(hist, palette);
}

/**
 * Keep the ink.
 *
 * Median cut plus Lloyd refinement is a *coverage* optimizer: it spends its
 * slots where the pixels are. On line art that is exactly wrong at a small
 * colour budget — the black outline is a few percent of the pixels but it is
 * the whole drawing, and averaging it into the nearest dark mid-tone turns a
 * character's outline into a dark teal smear (the failure REFERENCE's
 * gold-standard A/B exposes at 6 colours).
 *
 * So when the source really does contain a dark ink and no palette entry
 * landed on it, the entry that currently owns those dark pixels is moved onto
 * their centroid. The count is unchanged; only where one slot sits changes.
 */
function reserveDarkest(hist: Histogram, palette: RgbColor[]): RgbColor[] {
  const INK_LUMA = 60;
  if (palette.length < 2) return palette;
  if (palette.some((c) => lumaOf(c) < INK_LUMA)) return palette;

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const cr = (c >> 16) & 255;
    const cg = (c >> 8) & 255;
    const cb = c & 255;
    if (lumaOf({ r: cr, g: cg, b: cb }) >= INK_LUMA * 0.75) continue;
    const w = hist.counts[i];
    r += cr * w;
    g += cg * w;
    b += cb * w;
    n += w;
  }
  // A handful of stray dark pixels is not an outline; 0.5 % of the canvas is.
  if (n === 0 || n / hist.total < 0.005) return palette;
  const ink = { r: clamp255(r / n), g: clamp255(g / n), b: clamp255(b / n) };

  let owner = 0;
  let bestD = Infinity;
  for (let j = 0; j < palette.length; j++) {
    const d = dist(ink.r, ink.g, ink.b, palette[j]);
    if (d < bestD) {
      bestD = d;
      owner = j;
    }
  }
  const out = palette.map((c) => ({ ...c }));
  out[owner] = ink;
  return out;
}

function refine(hist: Histogram, palette: RgbColor[], iterations: number): RgbColor[] {
  const k = palette.length;
  let current = palette.map((c) => ({ ...c }));
  for (let it = 0; it < iterations; it++) {
    const sumR = new Float64Array(k);
    const sumG = new Float64Array(k);
    const sumB = new Float64Array(k);
    const sumN = new Float64Array(k);
    for (let i = 0; i < hist.distinct; i++) {
      const c = hist.colors[i];
      const r = (c >> 16) & 255;
      const g = (c >> 8) & 255;
      const b = c & 255;
      let bestIdx = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = dist(r, g, b, current[j]);
        if (d < bestD) {
          bestD = d;
          bestIdx = j;
        }
      }
      const w = hist.counts[i];
      sumR[bestIdx] += r * w;
      sumG[bestIdx] += g * w;
      sumB[bestIdx] += b * w;
      sumN[bestIdx] += w;
    }
    let moved = false;
    const next = current.map((c, j) => {
      if (sumN[j] === 0) return c;
      const n = {
        r: clamp255(sumR[j] / sumN[j]),
        g: clamp255(sumG[j] / sumN[j]),
        b: clamp255(sumB[j] / sumN[j]),
      };
      if (n.r !== c.r || n.g !== c.g || n.b !== c.b) moved = true;
      return n;
    });
    current = next;
    if (!moved) break;
  }
  return current;
}

function orderByCoverage(hist: Histogram, palette: RgbColor[]): RgbColor[] {
  const k = palette.length;
  const coverage = new Float64Array(k);
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const d = dist(r, g, b, palette[j]);
      if (d < bestD) {
        bestD = d;
        bestIdx = j;
      }
    }
    coverage[bestIdx] += hist.counts[i];
  }
  const idx = palette.map((_, j) => j);
  idx.sort((a, b) => coverage[b] - coverage[a] || packRgb(palette[a].r, palette[a].g, palette[a].b) - packRgb(palette[b].r, palette[b].g, palette[b].b));
  const out: RgbColor[] = [];
  const seen = new Set<number>();
  for (const j of idx) {
    if (coverage[j] <= 0) continue;
    const key = packRgb(palette[j].r, palette[j].g, palette[j].b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(palette[j]);
  }
  if (out.length === 0) out.push(palette[0] ?? { r: 0, g: 0, b: 0 });
  return out;
}

/** Nearest-palette-entry index per pixel. Cached per distinct source colour. */
export function mapToPalette(image: RasterImage, palette: RgbColor[]): Uint8Array {
  const pixels = image.width * image.height;
  const out = new Uint8Array(pixels);
  const { data } = image;
  const cache = new Map<number, number>();
  const k = palette.length;
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = packRgb(r, g, b);
    let hit = cache.get(key);
    if (hit === undefined) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = dist(r, g, b, palette[j]);
        if (d < bestD) {
          bestD = d;
          bestIdx = j;
        }
      }
      hit = bestIdx;
      cache.set(key, hit);
    }
    out[p] = hit;
  }
  return out;
}

/** Pixel coverage per palette entry. */
export function coverageOf(indices: Uint8Array, paletteSize: number): Uint32Array {
  const counts = new Uint32Array(paletteSize);
  for (let i = 0; i < indices.length; i++) counts[indices[i]]++;
  return counts;
}

export interface DespeckleOptions {
  /** Regions with fewer pixels than this are candidates for removal. */
  minArea: number;
  /**
   * Palette the indices refer to. Required for `maxContrast`.
   */
  palette?: RgbColor[];
  /**
   * Maximum L1 colour distance (0..765) between a speck and the neighbour it
   * would be merged into. A tiny region that is *wildly* different from its
   * surroundings is a feature of the artwork (or genuine impulse noise the user
   * may want to keep visible); a tiny region that is barely different is a
   * quantization artefact of sensor/compression grain. Only the latter is
   * merged. `Infinity` merges regardless of contrast.
   */
  maxContrast?: number;
  /**
   * Exempt *strokes* from the area test.
   *
   * A speck and a hairline can have the same pixel count, and an area-only
   * filter cannot tell them apart: at the enhance floor (~87px² on the 1046px
   * reference artwork) a 2px-wide, 30px-long eyelid is 60px² and disappears,
   * which is what turned Snorlax's mouth and eyes into dashes. Elongation
   * separates them without a magic length: `maxDim² / area` is 1 for a disc,
   * ~1 for any compact blob, and grows with the aspect ratio of a stroke, so a
   * region longer than ~`elongation`× its own thickness is treated as line art
   * and kept.
   *
   * Off by default: REFERENCE B5's Minimum Area is a literal promise about the
   * document ("nothing under N px²"), so only the cleanup filters that claim to
   * remove *noise* turn it on.
   */
  keepElongated?: boolean;
  /** `maxDim² / area` at or above which a small region counts as a stroke. */
  elongation?: number;
  /**
   * Merge only *fringe* regions — the ones whose colour lies between the two
   * colours they separate (REFERENCE B4 anti-aliasing, at region scale).
   *
   * The pixel-level pass in preprocess.ts only sees a 3×3 window, so a fringe
   * two or three pixels wide is a local majority and survives it, and it can be
   * far too large for any speck threshold: the 40×3 grey band along the
   * reference artwork's mouth is 120px². What identifies it is not its size but
   * that it is thin AND in-between, which is exactly what this mode tests.
   */
  onlyFringe?: boolean;
  /**
   * Average thickness (area / longest side), in pixels, at or below which a
   * region counts as a thin band. Only used with `onlyFringe`.
   */
  maxThickness?: number;
}

/**
 * Drop connected regions smaller than `minArea`, merging each into the
 * neighbouring colour it shares the most border with (REFERENCE B2 despeckle).
 * Operates in place on the index image. 4-connectivity.
 *
 * Returns the number of regions merged away.
 */
export function despeckleIndices(
  indices: Uint8Array,
  width: number,
  height: number,
  options: DespeckleOptions,
): number {
  const minArea = options.minArea;
  const palette = options.palette;
  const maxContrast = options.maxContrast ?? Infinity;
  const keepElongated = options.keepElongated === true;
  const elongation = options.elongation ?? 6;
  const onlyFringe = options.onlyFringe === true;
  const maxThickness = options.maxThickness ?? 3;
  if (minArea <= 1 && !onlyFringe) return 0;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const areas: number[] = [];
  /** Longest bounding-box side per label; only needed for `keepElongated`. */
  const maxDims: number[] = [];
  let labelCount = 0;

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1) continue;
    const color = indices[start];
    const label = labelCount++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let area = 0;
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;
    while (head < tail) {
      const p = queue[head++];
      area++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) {
        const q = p - 1;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
      if (x + 1 < width) {
        const q = p + 1;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
      if (y > 0) {
        const q = p - width;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
      if (y + 1 < height) {
        const q = p + width;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
    }
    areas.push(area);
    maxDims.push(Math.max(x1 - x0, y1 - y0) + 1);
  }

  // Bucket pixels by label (counting sort) so each speck can be rewritten.
  const offsets = new Int32Array(labelCount + 1);
  for (let l = 0; l < labelCount; l++) offsets[l + 1] = offsets[l] + areas[l];
  const cursor = offsets.slice(0, labelCount);
  const members = new Int32Array(n);
  for (let p = 0; p < n; p++) members[cursor[labels[p]]++] = p;

  const small: number[] = [];
  for (let l = 0; l < labelCount; l++) {
    if (onlyFringe) {
      // Thin bands only — a fringe is by definition a couple of pixels wide.
      if (areas[l] / maxDims[l] <= maxThickness) small.push(l);
    } else if (areas[l] < minArea) {
      small.push(l);
    }
  }
  // Smallest first: specks inside specks collapse outward.
  small.sort((a, b) => areas[a] - areas[b] || a - b);

  const tally = new Int32Array(256);
  /** Global pixel count per index — the rarity tiebreak below needs it. */
  const coverage = new Int32Array(256);
  if (onlyFringe) for (let p = 0; p < n; p++) coverage[indices[p]]++;
  let merged = 0;

  for (const label of small) {
    const from = offsets[label];
    const to = offsets[label + 1];
    tally.fill(0);
    let touched = false;
    for (let m = from; m < to; m++) {
      const p = members[m];
      const x = p % width;
      const y = (p / width) | 0;
      if (x > 0 && labels[p - 1] !== label) {
        tally[indices[p - 1]]++;
        touched = true;
      }
      if (x + 1 < width && labels[p + 1] !== label) {
        tally[indices[p + 1]]++;
        touched = true;
      }
      if (y > 0 && labels[p - width] !== label) {
        tally[indices[p - width]]++;
        touched = true;
      }
      if (y + 1 < height && labels[p + width] !== label) {
        tally[indices[p + width]]++;
        touched = true;
      }
    }
    if (!touched) continue;
    let bestColor = -1;
    let bestScore = 0;
    for (let c = 0; c < 256; c++) {
      if (tally[c] > bestScore) {
        bestScore = tally[c];
        bestColor = c;
      }
    }
    const own = indices[members[from]];
    if (bestColor < 0) continue;
    const ownColor = palette ? palette[own] : undefined;

    /** Runner-up neighbour by border length — the other side of a fringe. */
    let secondColor = -1;
    let secondScore = 0;
    for (let c = 0; c < 256; c++) {
      if (c === bestColor) continue;
      if (tally[c] > secondScore) {
        secondScore = tally[c];
        secondColor = c;
      }
    }

    /**
     * Is this region an antialiasing fringe?
     *
     * A fringe is the one-pixel ramp between two flat colours, so its colour
     * lies *between* the two regions it separates. A piece of line art is an
     * extreme instead — the black of a stroke is not between the cream either
     * side of it. Same test `deAntialias` uses per pixel (src/engine/
     * preprocess.ts), applied to a whole region.
     */
    let fringe = false;
    if (ownColor && palette && secondColor >= 0) {
      const a = palette[bestColor];
      const b = palette[secondColor];
      if (a && b) {
        const span = dist(a.r, a.g, a.b, b);
        const da = dist(ownColor.r, ownColor.g, ownColor.b, a);
        const db = dist(ownColor.r, ownColor.g, ownColor.b, b);
        fringe = span >= 48 && da > 0 && db > 0 && da + db <= span * 1.35;
      }
    }

    /**
     * Strokes survive a *noise* filter; fringes do not.
     *
     * A speck and a hairline can have the same pixel count, so an area-only
     * test deletes line art: at the enhance floor (~87px² on the 1046px
     * reference artwork) a 2px-wide, 30px-long eyelid is 60px² and vanishes.
     * `maxDim² / area` is ~1 for any compact blob and grows with aspect ratio,
     * so it separates the two without a magic length — but only for regions
     * that are not fringes, or the exemption would preserve exactly the halo
     * bands anti-aliasing exists to remove (they are long and thin too).
     */
    if (keepElongated && !fringe && (maxDims[label] * maxDims[label]) / areas[label] >= elongation) {
      continue;
    }
    // Fringe-only mode judges nothing but that: thin was checked when the
    // candidate list was built, in-between is checked here.
    if (onlyFringe && !fringe) continue;

    /**
     * Border length says which region a speck *sits in*; it does not say which
     * one it *is*. A mid-grey chunk of an antialiased line touches the cream
     * paper along its whole length and the black stroke only at its ends, so
     * "most border" repaints it cream and punches a hole in the stroke — that
     * is what turned the reference artwork's mouth and eyelids into dashes.
     *
     * The error a merge introduces is `area × colour distance`, and the area is
     * fixed, so among the neighbours it genuinely borders (a quarter of the
     * winner's border length or more — a corner touch is not a neighbourhood)
     * the right target is the closest colour.
     */
    if (ownColor && palette) {
      const floor = bestScore * 0.25;
      let nearest = bestColor;
      let nearestDist = Infinity;
      for (let c = 0; c < 256; c++) {
        if (tally[c] < floor || c === own) continue;
        const cand = palette[c];
        if (!cand) continue;
        const d = dist(ownColor.r, ownColor.g, ownColor.b, cand);
        /**
         * A 50 %-coverage fringe pixel is equidistant from both sides by
         * construction, and then the choice decides whether a hairline survives
         * or is erased. Ties (within 15 %) go to the rarer colour: paper has
         * plenty of pixels to spare, a one-pixel stroke has none, and losing
         * the stroke destroys information the picture cannot get back.
         */
        const better =
          d < nearestDist ||
          (onlyFringe &&
            nearestDist < Infinity &&
            d <= nearestDist * 1.15 &&
            coverage[c] < coverage[nearest]);
        if (better) {
          nearestDist = Math.min(nearestDist, d);
          nearest = c;
        }
      }
      bestColor = nearest;
    }
    if (bestColor === own) continue;
    if (maxContrast !== Infinity && palette) {
      const a = palette[own];
      const b = palette[bestColor];
      if (a && b && dist(a.r, a.g, a.b, b) > maxContrast) continue;
    }
    for (let m = from; m < to; m++) indices[members[m]] = bestColor;
    merged++;
  }

  return merged;
}

/** Rebuild an RGBA raster from an index image + palette. */
export function indicesToRaster(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: RgbColor[],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
    const c = palette[indices[p]] ?? palette[0];
    data[i] = c.r;
    data[i + 1] = c.g;
    data[i + 2] = c.b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/**
 * Clamp a caller-supplied palette override and drop malformed entries,
 * **keeping duplicates**.
 *
 * Duplicates are meaningful: two slots naming the same colour is how the
 * palette editor expresses "merge slot A into slot B" (see `vectorize`). The
 * length of the returned array is therefore the number of colour *slots* the
 * quantizer should cluster into, which is not necessarily the number of
 * distinct colours that end up in the SVG.
 */
export function normalizePalette(palette: RgbColor[] | null | undefined): RgbColor[] | null {
  if (!palette || palette.length === 0) return null;
  const out: RgbColor[] = [];
  for (const c of palette) {
    if (!c || typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') continue;
    if (!Number.isFinite(c.r) || !Number.isFinite(c.g) || !Number.isFinite(c.b)) continue;
    out.push({ r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b) });
    if (out.length >= 64) break;
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Preset colour transforms (REFERENCE B2)
// ---------------------------------------------------------------------------

/** Rec. 601 grayscale — the Sketch preset's colour space. */
export function toGrayscale(image: RasterImage): RasterImage {
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const y = clamp255(
      0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2],
    );
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

/** Luminance threshold to pure black/white — the Drawing preset (REFERENCE B2). */
export function toBlackAndWhite(image: RasterImage, threshold: number): RasterImage {
  const t = Math.max(0, Math.min(255, threshold));
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const y = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
    const v = y >= t ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

// ---------------------------------------------------------------------------
// Output colour groups (REFERENCE B3)
// ---------------------------------------------------------------------------

/**
 * Collapse palette entries that sit within `thresholdPercent` of each other.
 *
 * Distance is L1 over RGB as a percentage of the maximum (765), so 5 % — the
 * reference product's default step — merges colours under ~38 units apart:
 * the near-duplicates a soft edge or a gradient leaves behind, not the artwork.
 *
 * Returns the surviving palette plus the index remap, and rewrites `indices`.
 */
export function mergeSimilarColors(
  indices: Uint8Array,
  palette: RgbColor[],
  thresholdPercent: number,
): { palette: RgbColor[]; map: Uint8Array } {
  const map = new Uint8Array(Math.max(1, palette.length));
  const limit = (Math.max(0, thresholdPercent) / 100) * 765;
  if (limit <= 0 || palette.length < 2) {
    for (let i = 0; i < palette.length; i++) map[i] = i;
    return { palette: palette.map((c) => ({ ...c })), map };
  }
  const kept: RgbColor[] = [];
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    let target = -1;
    for (let j = 0; j < kept.length; j++) {
      if (dist(c.r, c.g, c.b, kept[j]) <= limit) {
        target = j;
        break;
      }
    }
    if (target < 0) {
      target = kept.length;
      kept.push({ ...c });
    }
    map[i] = target;
  }
  for (let p = 0; p < indices.length; p++) indices[p] = map[indices[p]];
  return { palette: kept, map };
}

/**
 * Merge colour groups that cover less than `thresholdPercent` of the image into
 * the nearest surviving colour — the reference product's output-colour-groups
 * "merge threshold" (its default step is 5 %).
 *
 * Coverage, not colour distance, is the useful reading of that control: the
 * groups panel draws each output colour as a circle sized by its area, and the
 * threshold sits next to it. What a user wants from it is "stop giving a whole
 * layer to a colour that barely appears" — a slice of quantization debris that
 * costs a layer, a legend entry and a print run. Colour-distance merging is a
 * different job and lives in `mergeSimilarColors`.
 *
 * Rewrites `indices` and returns the surviving palette.
 */
export function mergeSmallGroups(
  indices: Uint8Array,
  palette: RgbColor[],
  thresholdPercent: number,
): RgbColor[] {
  if (thresholdPercent <= 0 || palette.length < 2) return palette.map((c) => ({ ...c }));
  const coverage = coverageOf(indices, palette.length);
  const limit = (thresholdPercent / 100) * indices.length;
  const survives = palette.map((_, i) => coverage[i] >= limit);
  // Never merge everything away: the largest group always survives.
  if (!survives.some(Boolean)) {
    let biggest = 0;
    for (let i = 1; i < palette.length; i++) if (coverage[i] > coverage[biggest]) biggest = i;
    survives[biggest] = true;
  }

  const kept: RgbColor[] = [];
  const keptIndex: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (survives[i]) {
      keptIndex.push(i);
      kept.push({ ...palette[i] });
    }
  }
  if (kept.length === palette.length) return kept;

  const map = new Uint8Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    if (survives[i]) {
      map[i] = keptIndex.indexOf(i);
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < kept.length; k++) {
      const d = dist(palette[i].r, palette[i].g, palette[i].b, kept[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    map[i] = best;
  }
  for (let p = 0; p < indices.length; p++) indices[p] = map[indices[p]];
  return kept;
}

/** Emission order of the colour layers (REFERENCE B3 "sort order"). */
export function sortedOrder(
  palette: RgbColor[],
  coverage: ArrayLike<number>,
  order: 'coverage' | 'brightness' | 'hue',
): number[] {
  const idx = palette.map((_, i) => i);
  if (order === 'brightness') {
    idx.sort((a, b) => lumaOf(palette[a]) - lumaOf(palette[b]) || a - b);
  } else if (order === 'hue') {
    idx.sort((a, b) => hueOf(palette[a]) - hueOf(palette[b]) || a - b);
  } else {
    idx.sort((a, b) => (coverage[b] ?? 0) - (coverage[a] ?? 0) || a - b);
  }
  return idx;
}

/** `normalizePalette` plus duplicate removal — the distinct colours of an override. */
export function sanitizePalette(palette: RgbColor[] | null | undefined): RgbColor[] | null {
  const normalized = normalizePalette(palette);
  if (!normalized) return null;
  const out: RgbColor[] = [];
  const seen = new Set<number>();
  for (const n of normalized) {
    const key = packRgb(n.r, n.g, n.b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.length ? out : null;
}
