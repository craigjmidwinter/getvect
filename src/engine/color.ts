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
  const k = Math.max(2, Math.min(64, Math.round(colorCount)));
  const hist = buildHistogram(image);
  if (hist.distinct === 0) return [{ r: 0, g: 0, b: 0 }];

  const clusters = medianCut(hist, k);
  let palette = clusters.map((m) => centroid(m, hist));

  // Lloyd refinement only matters when we are actually approximating.
  if (hist.distinct > palette.length) {
    palette = refine(hist, palette, 6);
  }

  return orderByCoverage(hist, palette);
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
  if (minArea <= 1) return 0;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const areas: number[] = [];
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
    while (head < tail) {
      const p = queue[head++];
      area++;
      const x = p % width;
      const y = (p / width) | 0;
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
  }

  // Bucket pixels by label (counting sort) so each speck can be rewritten.
  const offsets = new Int32Array(labelCount + 1);
  for (let l = 0; l < labelCount; l++) offsets[l + 1] = offsets[l] + areas[l];
  const cursor = offsets.slice(0, labelCount);
  const members = new Int32Array(n);
  for (let p = 0; p < n; p++) members[cursor[labels[p]]++] = p;

  const small: number[] = [];
  for (let l = 0; l < labelCount; l++) if (areas[l] < minArea) small.push(l);
  // Smallest first: specks inside specks collapse outward.
  small.sort((a, b) => areas[a] - areas[b] || a - b);

  const tally = new Int32Array(256);
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
    if (bestColor < 0 || bestColor === own) continue;
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
