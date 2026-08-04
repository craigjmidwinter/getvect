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

function assertSameSize(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}
