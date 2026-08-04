/**
 * REFERENCE ENGINE — a deliberately naive tracer used only to prove the
 * measurement chain works. **This is not the product.** It exists so that
 * `npm run instruments:selftest` produces real numbers (and therefore shows the
 * decode -> vectorize -> rasterize -> diff pipeline is wired correctly) while
 * src/engine is still a stub.
 *
 * Strategy: pick the `colorCount` most frequent colours, map every pixel to the
 * nearest of them, then emit one <path> per colour made of merged horizontal
 * runs. Geometry is pixel-exact, so a flat-colour fixture scores ~0 error —
 * which is what makes it a good sanity check for the instruments. It is
 * hopeless on economy (huge SVGs), which is exactly the tradeoff a real tracer
 * has to beat.
 */

export const DEFAULT_SETTINGS = {
  colorCount: 8,
  detail: 60,
  smoothing: 50,
  despeckle: 20,
  enhance: false,
  palette: null,
};

function quantizeKey(r, g, b, bits) {
  const shift = 8 - bits;
  return ((r >> shift) << (bits * 2)) | ((g >> shift) << bits) | (b >> shift);
}

export function computePalette(image, colorCount) {
  const bits = 5;
  const counts = new Map();
  const sums = new Map();
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const k = quantizeKey(data[i], data[i + 1], data[i + 2], bits);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    const s = sums.get(k) ?? [0, 0, 0];
    s[0] += data[i];
    s[1] += data[i + 1];
    s[2] += data[i + 2];
    sums.set(k, s);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, colorCount)
    .map(([k, n]) => {
      const s = sums.get(k);
      return { r: Math.round(s[0] / n), g: Math.round(s[1] / n), b: Math.round(s[2] / n) };
    });
}

function nearestIndex(palette, r, g, b) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d = (p.r - r) ** 2 + (p.g - g) ** 2 + (p.b - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const hex = (c) =>
  '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');

export async function vectorize(image, settings = DEFAULT_SETTINGS, onProgress) {
  const t0 = Date.now();
  const { width, height, data } = image;
  onProgress?.({ phase: 'quantize', progress: 0.1 });

  const palette = settings.palette?.length
    ? settings.palette
    : computePalette(image, settings.colorCount);

  const indices = new Uint8Array(width * height);
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    indices[p] = nearestIndex(palette, data[i], data[i + 1], data[i + 2]);
  }
  onProgress?.({ phase: 'trace', progress: 0.5 });

  const runs = palette.map(() => []);
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const idx = indices[y * width + x];
      let end = x + 1;
      while (end < width && indices[y * width + end] === idx) end++;
      runs[idx].push(`M${x} ${y}h${end - x}v1h${-(end - x)}z`);
      x = end;
    }
  }
  onProgress?.({ phase: 'serialize', progress: 0.9 });

  const paths = runs
    .map((d, i) => (d.length ? `<path fill="${hex(palette[i])}" d="${d.join('')}"/>` : ''))
    .filter(Boolean);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">` +
    paths.join('') +
    `</svg>`;

  onProgress?.({ phase: 'done', progress: 1 });
  return {
    svg,
    palette,
    pathCount: paths.length,
    width,
    height,
    durationMs: Date.now() - t0,
  };
}
