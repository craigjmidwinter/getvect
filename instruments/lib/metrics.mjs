/**
 * Fidelity metrics — the "light meter".
 *
 * All functions take the engine's RasterImage shape ({width,height,data:RGBA})
 * and are pure so they can be unit-checked and diffed across runs.
 */

/**
 * Mean absolute per-pixel colour error in 0..255 units, averaged over R,G,B and
 * over all pixels. This is the number REFERENCE's "under ~8/255" refers to.
 */
export function meanColorError(a, b) {
  assertSameSize(a, b);
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    sum +=
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (n * 3);
}

/** Root-mean-square colour error (0..255), reported alongside MAE for context. */
export function rmsColorError(a, b) {
  assertSameSize(a, b);
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c];
      sum += d * d;
    }
  }
  return Math.sqrt(sum / (n * 3));
}

/** Peak signal-to-noise ratio in dB (Infinity when identical). */
export function psnr(a, b) {
  const rms = rmsColorError(a, b);
  if (rms === 0) return Infinity;
  return 20 * Math.log10(255 / rms);
}

/** Rec. 601 luma plane, Float64Array of width*height. */
export function toLuma(img) {
  const out = new Float64Array(img.width * img.height);
  for (let p = 0, i = 0; i < img.data.length; i += 4, p++) {
    out[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return out;
}

/**
 * Mean structural similarity on the luma plane.
 *
 * Windowed SSIM (Wang et al. 2004) with an 8x8 uniform window and stride 4,
 * C1=(0.01*255)^2, C2=(0.03*255)^2. Uniform windows rather than the Gaussian
 * variant: fewer knobs, same ranking behaviour, and trivially reproducible.
 * Returns 1.0 for identical images.
 */
export function ssim(a, b, { windowSize = 8, stride = 4 } = {}) {
  assertSameSize(a, b);
  const { width, height } = a;
  const la = toLuma(a);
  const lb = toLuma(b);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const w = Math.min(windowSize, width, height);
  let total = 0;
  let count = 0;

  for (let y = 0; y + w <= height; y += stride) {
    for (let x = 0; x + w <= width; x += stride) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let j = 0; j < w; j++) {
        const row = (y + j) * width + x;
        for (let i = 0; i < w; i++) {
          const va = la[row + i];
          const vb = lb[row + i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const n = w * w;
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const covAB = sumAB / n - muA * muB;
      const num = (2 * muA * muB + C1) * (2 * covAB + C2);
      const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
      total += num / den;
      count++;
    }
  }
  return count === 0 ? 1 : total / count;
}

/** Fraction of pixels whose max per-channel delta exceeds `tolerance`. */
export function pixelMismatchRatio(a, b, tolerance = 12) {
  assertSameSize(a, b);
  let bad = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > tolerance) bad++;
  }
  return bad / (a.width * a.height);
}

/** Count of `<path` elements in an SVG string (REFERENCE "Economy"). */
export function countPaths(svg) {
  return (svg.match(/<path\b/g) ?? []).length;
}

/** Every drawable element, not just paths — catches tracers that emit <rect>/<polygon>. */
export function countShapes(svg) {
  return (svg.match(/<(path|rect|circle|ellipse|polygon|polyline|line)\b/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Sub-path geometry
//
// `pathCount` is NOT a shape count: a tracer is free to emit one compound
// `<path>` per colour layer, in which case every speck is a sub-path (`M`/`m`)
// inside a single element and the "<= 200 paths" bar is met by definition
// rather than by economy. These helpers count what the eye actually sees.
// ---------------------------------------------------------------------------

/** Every `d="..."` attribute in the document, in order. */
export function pathDataAttributes(svg) {
  return [...svg.matchAll(/\sd="([^"]*)"/g)].map((m) => m[1]);
}

const ARG_COUNT = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Parse one path-data string into sub-path bounding boxes.
 *
 * Returns `[{ x0, y0, x1, y1, width, height, commands }]`, one entry per
 * `M`/`m`. Handles absolute and relative forms, implicit lineto repeats after a
 * moveto, and arcs (the endpoint only — good enough for an extent estimate).
 */
export function subPathBoxes(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const boxes = [];
  let box = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  let i = 0;

  const extend = (x, y) => {
    if (!box) return;
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  };

  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const token = tokens[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(token)) {
      cmd = token;
      i++;
    } else if (cmd == null) {
      i++; // stray number before any command
      continue;
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }

    const lower = cmd.toLowerCase();
    const relative = cmd === lower;
    const need = ARG_COUNT[lower];
    if (need > 0 && i + need > tokens.length) break;

    if (lower === 'z') {
      cx = sx;
      cy = sy;
      if (box) box.commands++;
      continue;
    }

    if (lower === 'm') {
      const x = num();
      const y = num();
      cx = relative ? cx + x : x;
      cy = relative ? cy + y : y;
      sx = cx;
      sy = cy;
      box = { x0: cx, y0: cy, x1: cx, y1: cy, commands: 0 };
      boxes.push(box);
      continue;
    }

    if (box) box.commands++;

    if (lower === 'h') {
      const x = num();
      cx = relative ? cx + x : x;
    } else if (lower === 'v') {
      const y = num();
      cy = relative ? cy + y : y;
    } else if (lower === 'a') {
      num(); num(); num(); num(); num();
      const x = num();
      const y = num();
      cx = relative ? cx + x : x;
      cy = relative ? cy + y : y;
    } else {
      // l/c/s/q/t — every pair is a point; only the last pair is the endpoint,
      // but control points are inside the ink's influence so they count too.
      for (let k = 0; k < need; k += 2) {
        const x = num();
        const y = num();
        const ax = relative ? cx + x : x;
        const ay = relative ? cy + y : y;
        extend(ax, ay);
        if (k + 2 === need) {
          cx = ax;
          cy = ay;
        }
      }
      extend(cx, cy);
      continue;
    }
    extend(cx, cy);
  }

  return boxes.map((b) => ({ ...b, width: b.x1 - b.x0, height: b.y1 - b.y0 }));
}

/** Total sub-paths (`M`/`m` starts) across every `<path d>` in the document. */
export function countSubPaths(svg) {
  let total = 0;
  for (const d of pathDataAttributes(svg)) total += (d.match(/[Mm]/g) ?? []).length;
  return total;
}

/**
 * Fraction of sub-paths whose bounding box fits inside `maxExtent` pixels in
 * both axes — i.e. single-pixel specks that survived despeckle / Minimum Area.
 */
export function tinySubPathRatio(svg, maxExtent = 1.5) {
  let total = 0;
  let tiny = 0;
  for (const d of pathDataAttributes(svg)) {
    for (const b of subPathBoxes(d)) {
      total++;
      if (b.width <= maxExtent && b.height <= maxExtent) tiny++;
    }
  }
  return total === 0 ? 0 : tiny / total;
}

/**
 * Share of drawing commands that are curves rather than straight segments:
 * `[CcSsQqTtAa] / ([CcSsQqTtAa] + [LlHhVv])`.
 *
 * REFERENCE demands "smooth curve-fitted outlines (no pixel staircase)". A
 * tracer that emits runs of `h1v1` is a staircase however small the file is,
 * and this number is how you see that without opening the PNG. The real
 * product's exemplar scores ~0.64; a pure polyline tracer scores 0.
 */
export function curveCommandRatio(svg) {
  let curves = 0;
  let lines = 0;
  for (const d of pathDataAttributes(svg)) {
    curves += (d.match(/[CcSsQqTtAa]/g) ?? []).length;
    lines += (d.match(/[LlHhVv]/g) ?? []).length;
  }
  const total = curves + lines;
  return total === 0 ? 0 : curves / total;
}

/** Count of cubic Bézier commands (`C`/`c`/`S`/`s`) — the exemplar's segment type. */
export function countCubics(svg) {
  let n = 0;
  for (const d of pathDataAttributes(svg)) n += (d.match(/[CcSs]/g) ?? []).length;
  return n;
}

// ---------------------------------------------------------------------------
// Colour-layer structure
// ---------------------------------------------------------------------------

/** Parse `#rrggbb`, `#rgb` or `rgb(r,g,b)` into {r,g,b}; null if unparseable. */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'none') return null;
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [a, b, c] = m[1].split('');
    return { r: parseInt(a + a, 16), g: parseInt(b + b, 16), b: parseInt(c + c, 16) };
  }
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  return null;
}

/**
 * The `<g fill="...">` colour layers, in document order. Accepts both the hex
 * form and the `rgb(r,g,b)` form REFERENCE D1 documents, so the metric does not
 * change meaning when the writer switches notation.
 */
export function layerFills(svg) {
  return [...svg.matchAll(/<g[^>]*\bfill="([^"]+)"/g)]
    .map((m) => parseColor(m[1]))
    .filter(Boolean);
}

/** Squared RGB distance. */
export function colorDistance2(a, b) {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/**
 * Pairs of colour layers closer together than `threshold` (Euclidean RGB).
 *
 * This is the anti-aliasing halo signature: transition pixels between two flat
 * regions quantize into their own near-duplicate slots, become full layers and
 * get painted over the artwork as thin coloured outlines (REFERENCE B4
 * "Anti-aliasing Off/Smart/Mid" is the control that suppresses them).
 */
export function nearDuplicateFillPairs(svg, threshold = 24) {
  const fills = layerFills(svg);
  const limit = threshold * threshold;
  let pairs = 0;
  for (let i = 0; i < fills.length; i++) {
    for (let j = i + 1; j < fills.length; j++) {
      if (colorDistance2(fills[i], fills[j]) <= limit) pairs++;
    }
  }
  return pairs;
}

/**
 * Largest per-colour area drift between the source and the re-rasterized trace.
 *
 * Every pixel of both images is snapped to its nearest entry in `palette`; the
 * result is the maximum absolute difference in coverage fraction over all
 * entries. Thin dark features eroding by a half-pixel inset shows up here as a
 * few percent on the outline colour while MAE/SSIM stay comfortably inside
 * their bars.
 */
export function perColorCoverageDelta(a, b, palette) {
  assertSameSize(a, b);
  if (!palette?.length) return 0;
  const share = (img) => {
    const counts = new Float64Array(palette.length);
    for (let i = 0; i < img.data.length; i += 4) {
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p];
        const d =
          (img.data[i] - c.r) ** 2 + (img.data[i + 1] - c.g) ** 2 + (img.data[i + 2] - c.b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      counts[best]++;
    }
    const n = img.width * img.height;
    return Array.from(counts, (c) => c / n);
  };
  const sa = share(a);
  const sb = share(b);
  let max = 0;
  for (let i = 0; i < palette.length; i++) max = Math.max(max, Math.abs(sa[i] - sb[i]));
  return max;
}

/** Everything structural we can read straight out of an SVG string. */
export function svgStructure(svg) {
  return {
    pathCount: countPaths(svg),
    shapeCount: countShapes(svg),
    subPathCount: countSubPaths(svg),
    tinySubPathRatio: tinySubPathRatio(svg),
    curveCommandRatio: curveCommandRatio(svg),
    cubicCount: countCubics(svg),
    layerCount: layerFills(svg).length,
    nearDuplicateFillPairs: nearDuplicateFillPairs(svg),
    bytes: Buffer.byteLength(svg, 'utf8'),
  };
}

function assertSameSize(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}
