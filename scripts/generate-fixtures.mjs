#!/usr/bin/env node
/**
 * Deterministic fixture generator — `npm run fixtures`.
 *
 * Every pixel is produced by pure math with a seeded PRNG, so re-running this
 * script reproduces byte-identical PNG/BMP output. (The JPEG goes through
 * libjpeg via sharp, so it is reproducible for a given sharp version; it is
 * committed to the repo for that reason.)
 *
 * Shapes are drawn WITHOUT antialiasing on purpose: the flat fixtures then
 * contain exactly N distinct colours, which makes palette/quantization
 * assertions in the instruments exact rather than approximate.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'fixtures');

// --- tiny deterministic PRNG (mulberry32) ---------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- micro rasterizer (RGBA, no antialiasing) ------------------------------
const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

const PALETTE = {
  paper: hex('#f2efe6'),
  navy: hex('#1b3a5c'),
  orange: hex('#e4572e'),
  green: hex('#2e9e5b'),
  yellow: hex('#f2c14e'),
  ink: hex('#2b2b2b'),
};

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c.r;
    this.data[i + 1] = c.g;
    this.data[i + 2] = c.b;
    this.data[i + 3] = 255;
  }
  get(x, y) {
    const i = (y * this.width + x) * 4;
    return { r: this.data[i], g: this.data[i + 1], b: this.data[i + 2] };
  }
  fill(c) {
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) this.set(x, y, c);
  }
  rect(x0, y0, w, h, c) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
  disc(cx, cy, r, c) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
    }
  }
  ring(cx, cy, rOuter, rInner, c) {
    const ro2 = rOuter * rOuter;
    const ri2 = rInner * rInner;
    for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
      for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro2 && d2 >= ri2) this.set(x, y, c);
      }
    }
  }
  triangle(p0, p1, p2, c) {
    const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]));
    const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]));
    const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]));
    const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]));
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
        const w1 = ((p2[0] - p1[0]) * (py - p1[1]) - (px - p1[0]) * (p2[1] - p1[1])) / area;
        const w2 = ((p0[0] - p2[0]) * (py - p2[1]) - (px - p2[0]) * (p0[1] - p2[1])) / area;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) this.set(x, y, c);
      }
    }
  }
  toBuffer() {
    return Buffer.from(this.data);
  }
}

/** The logo-like mark, scaled to any square size. Exactly 6 distinct colours. */
function drawLogo(size) {
  const c = new Canvas(size, size);
  const u = size / 512; // design units
  c.fill(PALETTE.paper);
  c.disc(256 * u, 232 * u, 150 * u, PALETTE.navy);
  c.triangle([256 * u, 120 * u], [372 * u, 320 * u], [140 * u, 320 * u], PALETTE.orange);
  c.rect(Math.round(96 * u), Math.round(360 * u), Math.round(320 * u), Math.round(46 * u), PALETTE.green);
  c.rect(Math.round(96 * u), Math.round(424 * u), Math.round(196 * u), Math.round(28 * u), PALETTE.yellow);
  c.rect(Math.round(308 * u), Math.round(424 * u), Math.round(108 * u), Math.round(28 * u), PALETTE.ink);
  c.ring(256 * u, 232 * u, 190 * u, 172 * u, PALETTE.ink);
  return c;
}

/**
 * A sticker/decal: flat shapes on a FULLY TRANSPARENT background.
 *
 * REFERENCE's headline use cases (stickers, decals, t-shirt art) ship with an
 * alpha channel, and alpha is the one thing every other fixture is missing.
 * `Canvas` starts life as all zeroes — alpha 0 — and `set()` writes alpha 255,
 * so simply not calling `fill()` leaves a genuinely transparent background.
 */
function drawSticker(size) {
  const c = new Canvas(size, size);
  const u = size / 256;
  c.disc(128 * u, 118 * u, 84 * u, PALETTE.navy);
  c.disc(128 * u, 118 * u, 52 * u, PALETTE.orange);
  c.rect(Math.round(56 * u), Math.round(192 * u), Math.round(144 * u), Math.round(30 * u), PALETTE.navy);
  c.triangle([128 * u, 24 * u], [176 * u, 96 * u], [80 * u, 96 * u], PALETTE.yellow);
  return c;
}

/** Speckle noise: isolated impulse pixels + mild per-pixel jitter. Seeded. */
function speckle(src, seed) {
  const rnd = mulberry32(seed);
  const c = new Canvas(src.width, src.height);
  c.data.set(src.data);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const p = c.get(x, y);
      let r = p.r;
      let g = p.g;
      let b = p.b;
      // mild jitter everywhere (simulates scan/compression noise)
      if (rnd() < 0.35) {
        const j = (rnd() - 0.5) * 26;
        r = clamp(r + j);
        g = clamp(g + j);
        b = clamp(b + j);
      }
      // impulse specks (salt & pepper + colour dropouts)
      const s = rnd();
      if (s < 0.012) {
        r = g = b = 255;
      } else if (s < 0.024) {
        r = g = b = 0;
      } else if (s < 0.030) {
        r = clamp(rnd() * 255);
        g = clamp(rnd() * 255);
        b = clamp(rnd() * 255);
      }
      c.set(x, y, { r, g, b });
    }
  }
  // a handful of 2x2 blobs so despeckle has area-thresholded work to do
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rnd() * (c.width - 2));
    const y = Math.floor(rnd() * (c.height - 2));
    const col = { r: clamp(rnd() * 255), g: clamp(rnd() * 255), b: clamp(rnd() * 255) };
    c.rect(x, y, 2, 2, col);
  }
  return c;
}

/**
 * Box-downsample a canvas by an integer factor — the only ANTIALIASING in this
 * file, and it is deliberate.
 *
 * Every other fixture here is drawn with hard edges so palette assertions can be
 * exact. `spikes-and-bands` needs the opposite: the two defects it exists to
 * measure (ink fusion and invented seams) are both *created* by the
 * anti-aliasing ramp, so a fixture without a ramp cannot reproduce either. Doing
 * it as a supersample keeps the determinism — pure integer averaging of pixels
 * this script drew itself, no library resampler in the loop.
 */
function downsample(src, factor) {
  const w = Math.floor(src.width / factor);
  const h = Math.floor(src.height / factor);
  const out = new Canvas(w, h);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          const p = ((y * factor + j) * src.width + (x * factor + i)) * 4;
          r += src.data[p];
          g += src.data[p + 1];
          b += src.data[p + 2];
        }
      }
      // Round-half-up on an integer sum: deterministic on every platform.
      out.set(x, y, {
        r: Math.floor((r + n / 2) / n),
        g: Math.floor((g + n / 2) / n),
        b: Math.floor((b + n / 2) / n),
      });
    }
  }
  return out;
}

/** Inset a triangle by `t` pixels on every edge (exact: scale about the incentre). */
function insetTriangle(a, b, c, t) {
  const la = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const lb = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const lc = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const sum = la + lb + lc;
  const ix = (la * a[0] + lb * b[0] + lc * c[0]) / sum;
  const iy = (la * a[1] + lb * b[1] + lc * c[1]) / sum;
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  const r = area / (sum / 2);
  if (r <= t) return null;
  const k = (r - t) / r;
  const pull = (p) => [ix + (p[0] - ix) * k, iy + (p[1] - iy) * k];
  return [pull(a), pull(b), pull(c)];
}

/**
 * The `arcs` fixture — long smooth boundaries whose true shape is an equation.
 *
 * Everything else here is measured against itself or against the reference
 * product's trace of the same picture, and neither can answer "was that arc
 * supposed to be smooth?". This one can, because the generator drew it from
 * `x² + y² = r²`: `instruments/lib/metrics.mjs boundarySmoothness` takes the
 * fitted boundary points near each declared radius and reports how far they
 * stray from a circle, in pixels.
 *
 * Why it needed a fixture of its own. A curve fitter given a ±½px pixel
 * staircase and an error budget of ~0.9px will spend the budget: it emits one
 * cubic across 116° of arc, three quarters of a pixel off the circle in the
 * middle of the segment and back on it at both ends, and every economy and
 * fidelity number in this harness calls that a success — the file is small, the
 * commands are curves, the colour is right, the ink is intact, and
 * `layerWobble` scores it *better* than the truth because a boundary that
 * undulates gently turns less per unit length than one that curves. At 8× zoom
 * it is the first thing anyone notices.
 *
 * Four radii from 16px to 100px plus an annulus, so the number is reported
 * across the range where the failure scales (it is proportional to the radius)
 * and on a concave boundary as well as convex ones. Antialiased by the same 3×
 * supersample the spikes fixture uses: a hard-edged circle is not what a tracer
 * meets, and the ramp is what a subpixel boundary estimator would have to read.
 */
function drawArcs(width, height) {
  const S = 3;
  const big = new Canvas(width * S, height * S);
  big.fill(PALETTE.paper);
  const arcs = [
    { name: 'disc-100', cx: 112, cy: 128, r: 100, color: PALETTE.navy },
    { name: 'disc-60', cx: 288, cy: 128, r: 60, color: PALETTE.orange },
    { name: 'disc-32', cx: 392, cy: 86, r: 32, color: PALETTE.green },
    { name: 'disc-16', cx: 392, cy: 182, r: 16, color: PALETTE.yellow },
  ];
  for (const a of arcs) big.disc(a.cx * S, a.cy * S, a.r * S, a.color);
  // An annulus: its inner boundary is the only CONCAVE long arc in the set, and
  // a hole is fitted through a different path (reversed winding, traced as a
  // hole child) than the outer contours above.
  const ring = { name: 'ring-outer', cx: 492, cy: 128, r: 48 };
  const hole = { name: 'ring-inner', cx: 492, cy: 128, r: 28 };
  big.ring(ring.cx * S, ring.cy * S, ring.r * S, hole.r * S, PALETTE.ink);
  const canvas = downsample(big, S);
  canvas.arcs = [...arcs.map(({ color, ...a }) => a), ring, hole];
  return canvas;
}

/**
 * The `spikes-and-bands` fixture — two visual defects, license-free.
 *
 * Everything else in `fixtures/` is flat clipart with hard edges, and neither of
 * the defects this reproduces can happen there:
 *
 *   1. **Small sharp features.** A row of outlined triangles whose sizes fall to
 *      a ~15px spike with a 2px outline, separated by a 4px light gap. Two
 *      things have to survive: the *count* (two dark strokes 4px apart must not
 *      weld into one lumpy chain, which is what the ink-biased ramp snap did to
 *      a character's claws) and the *shape* (a 142° turn at each apex must still
 *      be a corner once its arms are only a few pixels long — the corner
 *      detector measures direction over a fixed vertex window, which is a large
 *      fraction of a small contour).
 *   2. **Invented seams.** Two flat colour bands meeting along one slanted edge,
 *      with the ink outlines above them. Wherever two traced layers abut, a
 *      sub-pixel crack lets whatever is painted *under* them show through as a
 *      light sliver the source does not have.
 *
 * Antialiased on purpose (see `downsample`): both defects are created by the
 * ramp, so a hard-edged version of this picture reproduces neither.
 */
function drawSpikesAndBands(width, height) {
  const S = 3;
  const big = new Canvas(width * S, height * S);
  const paper = hex('#f6f4ee');
  const ink = hex('#141414');
  const core = hex('#fcfbf9');
  const bandA = hex('#4a8ba6');
  const bandB = hex('#27677e');
  big.fill(paper);

  // Two abutting flat bands with one slanted shared boundary, plus the straight
  // horizontal one where they meet the paper. Three layer adjacencies in total.
  const bandTop = 168 * S;
  for (let y = bandTop; y < height * S; y++) {
    const split = Math.round(150 * S + (y - bandTop) * 1.1);
    for (let x = 0; x < width * S; x++) big.set(x, y, x < split ? bandA : bandB);
  }
  // ...and an ink bar laid across both of them. This is where the seam defect
  // is worst and where it was reported: a mid-tone fill abutting an outline over
  // a LIGHT backdrop, so the crack between the two layers shows the paper and
  // the outline comes back with a white hairline down its side. Two bands
  // meeting each other leak the same crack, but the two are close enough in
  // colour that the leak is barely a ridge; against ink it is unmissable.
  const bar = [
    [40 * S, 244 * S],
    [344 * S, 196 * S],
  ];
  const half = 5 * S;
  const bdx = bar[1][0] - bar[0][0];
  const bdy = bar[1][1] - bar[0][1];
  const blen = Math.hypot(bdx, bdy);
  const nx = (-bdy / blen) * half;
  const ny = (bdx / blen) * half;
  const q = [
    [bar[0][0] + nx, bar[0][1] + ny],
    [bar[1][0] + nx, bar[1][1] + ny],
    [bar[1][0] - nx, bar[1][1] - ny],
    [bar[0][0] - nx, bar[0][1] - ny],
  ];
  big.triangle(q[0], q[1], q[2], ink);
  big.triangle(q[0], q[2], q[3], ink);

  // The spike row: outlined triangles, largest to smallest, 4px apart.
  const heights = [64, 54, 45, 37, 30, 24, 19, 15];
  const gap = 4;
  const widthsOf = (h) => 0.68 * h;
  const total =
    heights.reduce((sum, h) => sum + widthsOf(h), 0) + gap * (heights.length - 1);
  let x = (width - total) / 2;
  const baseline = 150;
  const spikes = [];
  for (const h of heights) {
    const w = widthsOf(h);
    const apex = [(x + w / 2) * S, (baseline - h) * S];
    const left = [x * S, baseline * S];
    const right = [(x + w) * S, baseline * S];
    const t = Math.min(6, Math.max(2, Math.round(h * 0.1)));
    big.triangle(apex, left, right, ink);
    const inner = insetTriangle(apex, left, right, t * S);
    if (inner) big.triangle(inner[0], inner[1], inner[2], core);
    spikes.push({ x: Math.round(x), width: Math.round(w), height: h, outline: t });
    x += w + gap;
  }

  const canvas = downsample(big, S);
  canvas.spikes = spikes;
  // Margin, because `enclosedLightComponents` drops anything touching the crop
  // border — that rule is what stops the paper counting as a feature, and with a
  // tight box it silently drops a spike whose base sits on the edge instead.
  canvas.spikeRow = {
    x: Math.floor((width - total) / 2) - 8,
    y: baseline - heights[0] - 8,
    width: Math.ceil(total) + 16,
    height: heights[0] + 16,
  };
  canvas.bandSeam = { x: 96, y: 168, width: 192, height: height - 168 };
  return canvas;
}

/** Photo-ish continuous-tone gradient (deliberately hard for a tracer). */
function drawGradient(width, height) {
  const c = new Canvas(width, height);
  const cx = width * 0.62;
  const cy = height * 0.38;
  const maxD = Math.hypot(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const r = 40 + 200 * u * (1 - d) + 30 * Math.sin(v * Math.PI * 2);
      const g = 30 + 180 * (1 - v) + 40 * Math.cos(u * Math.PI * 3) - 60 * d;
      const b = 90 + 150 * v + 70 * (1 - u) - 40 * d;
      c.set(x, y, {
        r: Math.max(0, Math.min(255, r | 0)),
        g: Math.max(0, Math.min(255, g | 0)),
        b: Math.max(0, Math.min(255, b | 0)),
      });
    }
  }
  return c;
}

// --- encoders --------------------------------------------------------------

async function writePng(canvas, file) {
  await sharp(canvas.toBuffer(), {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  })
    .png({ compressionLevel: 9, palette: false })
    .toFile(file);
}

async function writeJpeg(canvas, file, quality = 88) {
  await sharp(canvas.toBuffer(), {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  })
    .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: false })
    .toFile(file);
}

/** 24-bit uncompressed BMP writer (sharp cannot encode BMP). */
async function writeBmp(canvas, file) {
  const { width, height } = canvas;
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const pixelBytes = (rowBytes + padding) * height;
  const fileSize = 54 + pixelBytes;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // DIB header size (BITMAPINFOHEADER)
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive => bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);
  let o = 54;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const p = canvas.get(x, y);
      buf[o++] = p.b;
      buf[o++] = p.g;
      buf[o++] = p.r;
    }
    o += padding;
  }
  await fs.writeFile(file, buf);
}

/** Minimal but valid 4x4 GIF89a — an accepted-image-format decoy (REFERENCE A2). */
async function writeGif(file) {
  const bytes = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x04, 0x00, 0x04, 0x00, 0x80, 0x00, 0x00, // 4x4, GCT of 2 colours
    0xe4, 0x57, 0x2e, 0xf2, 0xef, 0xe6, // palette
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x04, 0x00, 0x00, // image descriptor
    0x02, 0x05, 0x84, 0x51, 0xa8, 0xcb, 0x05, 0x00, // LZW data
    0x3b, // trailer
  ];
  await fs.writeFile(file, Buffer.from(bytes));
}

// --- manifest --------------------------------------------------------------

const MANIFEST_DOC =
  'Generated by scripts/generate-fixtures.mjs (npm run fixtures). Do not hand-edit.';

/**
 * Three crops the mascot's rows share, because every defect they measure was
 * reported on the live demo and both rows have to answer for them.
 *
 * THE NOSE is a *small-feature* crop, and it is the first one in this harness
 * that asks whether we drew TOO MUCH ink. The source draws a thin curved
 * outline with a notch cut into its right nostril; the trace filled the notch
 * in and returned a solid black wedge, which every ink number here reads as a
 * triumph — recall 1.0, strict recall 1.0, one component, and `strokeWidth`
 * cannot see it because a filled-in blob has stopped being a stroke.
 * `inkCoverageRatio` is the number that can (instruments/lib/metrics.mjs).
 *
 * THE FOREHEAD STRIPES are the tabby M: three darker-orange stripes on body
 * orange, thin same-colour features with no outline of their own, and the
 * middle one arrives thinned along its lower half. `color` turns the crop into
 * a coverage question — of the stripe-orange the source paints here, how much
 * came back — which is the same instrument the eyes box uses for the olive.
 */
const FRANKIE_NOSE = {
  name: 'nose',
  x: 336,
  y: 396,
  width: 64,
  height: 38,
  /**
   * Judged on its own bars, not folded into the fixture's worst-region
   * aggregates (instruments/run-instruments.mjs `aggregate`). A fifth of this
   * crop is outline — the REFERENCE PRODUCT scores mean colour error 14.7 on it —
   * so aggregating it would not tighten `maxRegionMeanColorError`, it would
   * force that bar from 8 up to 18 and loosen the face and the chest with it.
   * Everything the aggregate would have asked is asked here instead.
   */
  aggregate: false,
  /**
   * THE BAR IS THE REFERENCE PRODUCT'S, AND WE DO NOT MEET IT. Its own trace spends
   * 1.09x the source's ink on this crop — a vector trace of an antialiased
   * outline is entitled to a little — and we spend 1.29x at the defaults.
   *
   * Left as an aspiration rather than written into `thresholds` because the
   * distance is now understood and is not where it was assumed to be. Measured
   * stage by stage on this crop, ink coverage runs 1.00x (source) -> 1.24x after
   * the anti-aliasing ramp snap -> 1.26x after the 3x3 majority -> 1.34x after
   * the seam regularizer -> 1.29x once fitted: four fifths of the excess is made
   * by `preprocess.ts deAntialias`, whose INK_RAMP_BIAS resolves a stroke's
   * whole skirt to ink and so grows every outline by about a pixel a side. On a
   * 64x38 crop that is already a fifth ink, a pixel a side IS the defect.
   * Turning that bias down is not free and was measured too (bias 3 -> 2 takes
   * the crop to 1.25x and costs ink everywhere it is load-bearing: the shaded
   * fixture's claws 0.976 -> 0.948 strict recall, the spikes fixture's seam
   * slivers over their bar).
   */
  aspirations: { maxInkCoverageRatio: 1.1 },
  thresholds: {
    // Ratchets on today's numbers, so opting out of the aggregate leaves
    // nothing unmeasured. The ink-spend ceiling is per row (the two rows differ
    // by Enhance, which is worth 0.15x here).
    minInkCoverageRatio: 0.9,
    /**
     * 17 until the mascot's muzzle was recoloured to white fur and the pink
     * chroma-key residue scrubbed out of the source. That is an ART change and
     * it moved this crop on its own: the same engine build measures 15.69 on the
     * pre-scrub artwork and 19.76 on the post-scrub one, because the salmon nose
     * now sits against WHITE rather than against pink-tinged fur, so the ~1 px a
     * side that `deAntialias`'s INK_RAMP_BIAS adds to its outline
     * (`aspirations` above) is now a full-contrast pixel instead of a half-
     * contrast one. Re-baselined at 21 with both numbers recorded rather than
     * loosened quietly.
     */
    maxMeanColorError: 21,
    minInkRecall: 0.93,
    minStrictInkRecall: 0.89,
  },
};

const FRANKIE_FOREHEAD = {
  name: 'forehead-stripes',
  x: 350,
  y: 190,
  width: 70,
  height: 100,
  color: 'rgb(209,95,21)',
};

/**
 * THE CHEEK STRIPES — the same instrument as the forehead's, pointed at the
 * hardest version of the same feature.
 *
 * Three stripes descend the character's left cheek in the same stripe-orange
 * the forehead's M is drawn in, and they are worse off in every way that
 * matters to a curve fitter: thinner (4-10 px against the forehead's 8-14),
 * TAPERED to a point at both ends rather than blunt, and curved along their
 * length, so the low-pass that fits them is averaging across the taper instead
 * of along a stroke. The forehead crop reported a 3-4 % loss and that was read
 * as a rounding error; the same pipeline takes 30 % here and the middle stripe
 * disappears outright, which is what a person sees on the demo.
 *
 * Same `color` question, same shape of bar (a ratchet on today plus the real
 * product's number as the aspiration), so the two crops move together and the
 * cheap fix that helps one at the other's expense cannot hide.
 */
const FRANKIE_CHEEK = {
  name: 'cheek-stripes',
  x: 150,
  y: 280,
  width: 110,
  height: 200,
  color: 'rgb(209,95,21)',
  /**
   * Judged on its own bars, like the nose and for a different reason: two fifths
   * of this crop is the outside of the character, so what it measures loudest is
   * a black outline against white paper, and `foreignColorRatio` there is
   * reading the RASTERIZER rather than the trace. The 81 pixels it reports are
   * greys — rgb(206,206,206) and neighbours, 33-37 units off the nearest colour
   * the source crop contains — laid down by resvg antialiasing our outline
   * against the white ground when the SVG is rendered back to pixels for
   * measurement. The reference product's trace of the same crop scores 1.27 % on the
   * same question, 3.4x ours. Folding that into `maxRegionForeignColorRatio`
   * would have forced the row's bar from 0.05 % to 0.4 % and taken the face, the
   * chest and the eyes — where 0.05 % is a real guard — up with it.
   */
  aggregate: false,
  thresholds: {
    // Ratchets on today, so opting out of the aggregate leaves nothing unasked.
    maxForeignColorRatio: 0.005,
    maxMeanColorError: 8,
    minInkRecall: 0.97,
    minStrictInkRecall: 0.94,
  },
};

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const logo512 = drawLogo(512);
  const logo1024 = drawLogo(1024);
  const noisy512 = speckle(logo512, 0x5eed1234);
  const gradient = drawGradient(512, 384);
  const bmpShapes = drawLogo(256);
  const sticker = drawSticker(256);
  const spikes = drawSpikesAndBands(384, 256);
  const arcs = drawArcs(560, 256);

  await writePng(spikes, join(outDir, 'spikes-bands-384.png'));
  await writePng(arcs, join(outDir, 'arcs-560x256.png'));
  await writePng(sticker, join(outDir, 'sticker-alpha-256.png'));
  await writePng(logo512, join(outDir, 'logo-flat-512.png'));
  await writePng(noisy512, join(outDir, 'logo-noisy-512.png'));
  await writePng(logo1024, join(outDir, 'logo-flat-1024.png'));
  await writeJpeg(gradient, join(outDir, 'photo-gradient-512x384.jpg'));
  await writeBmp(bmpShapes, join(outDir, 'shapes-256.bmp'));
  await writeGif(join(outDir, 'unsupported-animation.gif'));
  await fs.writeFile(
    join(outDir, 'unsupported-notes.txt'),
    'This is not an image. Dropping it into GetVect must produce a clear rejection message (REFERENCE A2).\n',
  );

  const distinct = (canvas) => {
    const seen = new Set();
    for (let i = 0; i < canvas.data.length; i += 4) {
      seen.add((canvas.data[i] << 16) | (canvas.data[i + 1] << 8) | canvas.data[i + 2]);
    }
    return seen.size;
  };

  /** Distinct colours among OPAQUE pixels only (the transparent fixture). */
  const distinctOpaque = (canvas) => {
    const seen = new Set();
    for (let i = 0; i < canvas.data.length; i += 4) {
      if (canvas.data[i + 3] < 128) continue;
      seen.add((canvas.data[i] << 16) | (canvas.data[i + 1] << 8) | canvas.data[i + 2]);
    }
    return seen.size;
  };

  const manifest = {
    _doc: MANIFEST_DOC,
    fixtures: [
      {
        id: 'logo-flat-512',
        provenance: 'synthetic',
        file: 'logo-flat-512.png',
        kind: 'flat',
        format: 'png',
        width: 512,
        height: 512,
        supported: true,
        distinctColors: distinct(logo512),
        // REFERENCE "Quality bar" thresholds that apply to this fixture.
        // maxSubPaths/maxTinySubPathRatio close the compound-path loophole in
        // maxPaths; minCurveCommandRatio is REFERENCE's "smooth curve-fitted
        // outlines (no pixel staircase)" made countable (exemplar scores 0.64).
        thresholds: {
          meanColorError: 8,
          ssim: 0.9,
          // Line art is a fraction of the pixels, so MAE/SSIM cannot see it
          // vanish — inkRecall can (instruments/lib/metrics.mjs).
          minInkRecall: 0.98,
          maxPaths: 200,
          maxSubPaths: 200,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 0,
          maxPerColorCoverageDelta: 0.01,
          maxBytes: 100 * 1024,
          maxMs: 10000,
        },
        note: 'Primary flat-colour target: 6 colours, hard edges, no antialiasing.',
      },
      {
        id: 'logo-noisy-512',
        provenance: 'synthetic',
        file: 'logo-noisy-512.png',
        kind: 'noisy',
        format: 'png',
        width: 512,
        height: 512,
        supported: true,
        distinctColors: distinct(noisy512),
        // Fidelity is measured against the CLEAN artwork: despeckling is a
        // feature, and SSIM's variance term scores the clean mark 0.35 against
        // its own speckled copy, so scoring against the noise would reward
        // reproducing every speck (docs/HARNESS.md `compareTo`).
        compareTo: 'logo-flat-512.png',
        thresholds: {
          meanColorError: 8,
          ssim: 0.9,
          minInkRecall: 0.97,
          maxPaths: 1200,
          // The default despeckle must not leave every source speckle as its
          // own 1x1 vector shape (the reference product's Minimum Area 5px², B5).
          maxSubPaths: 1200,
          maxTinySubPathRatio: 0.1,
          minCurveCommandRatio: 0.4,
          maxNearDuplicateFills: 2,
          maxBytes: 400 * 1024,
          maxMs: 10000,
        },
        note:
          'Same mark + seeded speckle. Exercises despeckle, Minimum Area (B5) and the enhance ' +
          'toggle (B4). Fidelity is measured against the CLEAN original (compareTo) because ' +
          'that is what despeckling is supposed to recover: the speckled source scores SSIM ' +
          '0.35 against the clean artwork, so scoring against it would reward reproducing ' +
          'every speck.',
      },
      {
        id: 'logo-flat-1024',
        provenance: 'synthetic',
        file: 'logo-flat-1024.png',
        kind: 'flat',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: distinct(logo1024),
        thresholds: {
          meanColorError: 8,
          ssim: 0.9,
          minInkRecall: 0.98,
          maxPaths: 300,
          maxSubPaths: 300,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 0,
          maxPerColorCoverageDelta: 0.01,
          maxBytes: 150 * 1024,
          maxMs: 10000,
        },
        note: 'Responsiveness bar: must vectorize in under 10s.',
      },
      {
        id: 'photo-gradient',
        provenance: 'synthetic',
        file: 'photo-gradient-512x384.jpg',
        kind: 'photo',
        format: 'jpeg',
        width: 512,
        height: 384,
        supported: true,
        distinctColors: null,
        thresholds: {
          meanColorError: 28,
          ssim: 0.6,
          minInkRecall: 0.9,
          maxPaths: 4000,
          maxSubPaths: 6000,
          maxTinySubPathRatio: 0.3,
          maxBytes: 1024 * 1024,
          maxMs: 10000,
        },
        note: 'Continuous tone. Not the primary use case — thresholds are loose on purpose.',
      },
      {
        id: 'shapes-256-bmp',
        provenance: 'synthetic',
        file: 'shapes-256.bmp',
        kind: 'flat',
        format: 'bmp',
        width: 256,
        height: 256,
        supported: true,
        distinctColors: distinct(bmpShapes),
        thresholds: {
          meanColorError: 8,
          ssim: 0.88,
          minInkRecall: 0.97,
          maxPaths: 200,
          maxSubPaths: 200,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 0,
          maxPerColorCoverageDelta: 0.01,
          maxBytes: 100 * 1024,
          maxMs: 10000,
        },
        note: 'BMP ingest path (REFERENCE A1).',
      },
      {
        /**
         * The two visual defects a flat, hard-edged fixture cannot reproduce.
         *
         * Both were reported on real artwork and neither could be measured here:
         * every other generated fixture is drawn without antialiasing, and both
         * failures are made BY the antialiasing ramp.
         *
         *   - `minFeatureComponentRatio` — the light interior of every spike has
         *     to come back as its own component. Two outlines 4px apart welding
         *     into one chain merges two interiors into none, and no other metric
         *     in this harness moves: the ink is all still there (recall ~1), the
         *     colours are right, the shape count barely changes.
         *   - `minSpikeCornerAngle` — and each interior has to keep its point. A
         *     142° apex whose arms are 8px long is exactly the corner a
         *     fixed-window corner detector cannot see.
         *   - `maxSliverRatio` — nowhere in the picture may a pixel come back
         *     lighter than both of its neighbours when the source has nothing
         *     that light there. That is the crack between two abutting layers,
         *     and it is worst against ink, where it reads as a white hairline.
         *
         * Measured at DEFAULT_SETTINGS (no `settings` key) on purpose: this is
         * the configuration a user gets, and it is the one both defects were
         * reported at.
         *
         * TWO of the three bars are ratchets on today's number rather than the
         * number to aim at, and it is worth saying which and why:
         *
         *   - `minFeatureComponentRatio` 0.87 is seven of the eight spikes. The
         *     eighth is the 15px one, whose interior is ~15px² of light behind a
         *     2px outline; **1.0 is the number to aim at** and the ink-fusion
         *     guard (`preprocess.ts INK_GAP_GUARD`) already took this from 0.75.
         *   - `minSpikeCornerAngle` 60° is what the corners survive as today.
         *     **112° is the number to aim at, and it is known-reachable**: this
         *     same engine reaches it on this same crop with `regularizeBoundaries`
         *     switched off, so the corner rounding is that pass and nothing else.
         *     The fix is not free — the only lever found that recovers the corners
         *     (raising its small-shape guard so a 7x7 vote is never cast from
         *     inside a window that swallows a small shape) also stops the same
         *     vote thinning the fox's outlines, and takes
         *     `reference-fox-default`'s `strokeWidthOverExemplar` from 1.25x to
         *     1.27x against a 1.25 bar. Both are real; neither is worth trading
         *     blind, and now both are measured.
         */
        id: 'spikes-bands-384',
        provenance: 'synthetic',
        file: 'spikes-bands-384.png',
        kind: 'clipart',
        format: 'png',
        width: 384,
        height: 256,
        supported: true,
        distinctColors: null,
        salientRegions: [
          {
            name: 'spikes',
            ...spikes.spikeRow,
            thresholds: {
              minFeatureComponentRatio: 0.87,
              // 65 deg before the narrow-feature guard, 75 after it. The number
              // to aim at is still 112 and it is still an aspiration below —
              // the reach that reaches it collides with the fox's stroke
              // ratchets (src/engine/preprocess.ts `narrowHere`).
              minSpikeCornerAngle: 75,
              maxSliverRatio: 0.0001,
            },
            // The number to aim at, measured every run and never red
            // (docs/HARNESS.md `aspirations`). A ratchet at 60 stops measuring
            // the distance to 112; this keeps it on screen.
            aspirations: { minSpikeCornerAngle: 112, minFeatureComponentRatio: 1 },
          },
          {
            name: 'band-seam',
            ...spikes.bandSeam,
            thresholds: { maxSliverRatio: 0.0002, maxForeignColorRatio: 0.002 },
          },
        ],
        thresholds: {
          meanColorError: 8,
          ssim: 0.9,
          minInkRecall: 0.94,
          minFeatureComponentRatio: 0.87,
          minSpikeCornerAngle: 75,
          maxSliverRatio: 0.0001,
          /**
           * The ratchet that proves the measure is not just "sharp = bad".
           *
           * This fixture is eight triangles: it is nothing BUT sharp corners,
           * and its corners contribute exactly nothing to this number — the
           * whole 0.1609 comes from one hard notch on the inside edge of the
           * largest triangle's hole, which no gate here could see before and
           * which the staircase measure ranked first without being told where
           * to look. So it is a ratchet at where it stands, and the notch is
           * the next lap's work, not this one's.
           */
          maxStaircaseLocal: 0.17,
          maxPaths: 200,
          maxSubPaths: 200,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 0,
          maxBytes: 100 * 1024,
          maxMs: 10000,
        },
        note:
          `${spikes.spikes.length} outlined triangles, ${spikes.spikes[0].height}px down to ` +
          `${spikes.spikes[spikes.spikes.length - 1].height}px tall, 4px apart, over two ` +
          'abutting flat bands. Antialiased (supersampled 3x and box-averaged), which is ' +
          'the whole point: ink fusion and seam slivers are both made by the ramp.',
      },
      {
        /**
         * THE SMOOTH-ARC FIXTURE. See `drawArcs` for why it exists; the bar it
         * carries is `maxArcResidualRms`, and it is the only geometry gate in
         * this file measured against a shape rather than against a smoothed
         * copy of our own output.
         *
         * Reading the number: a trace that reproduced the pixel boundary
         * verbatim scores ~0.37px — the RMS of the staircase itself about the
         * circle it approximates — and one whose geometry is as good as the
         * low-passed boundary it was handed scores ~0.06px. The lap that added
         * this fixture measured 0.424px on the worst arc and left it at
         * 0.229px, so the gate is a ratchet at 0.24. The worst arc is now the
         * annulus, whose outer edge the anti-aliasing ramp snap also grows
         * unevenly (`src/engine/preprocess.ts INK_RAMP_BIAS`) — a different
         * defect from the one the fitter carried. 0.08 is the number to aim at
         * and it sits in `aspirations` so the distance stays on screen.
         */
        id: 'arcs-560x256',
        provenance: 'synthetic',
        file: 'arcs-560x256.png',
        kind: 'clipart',
        format: 'png',
        width: 560,
        height: 256,
        supported: true,
        distinctColors: null,
        arcs: arcs.arcs,
        thresholds: {
          meanColorError: 8,
          ssim: 0.9,
          maxArcResidualRms: 0.24,
          /**
           * The staircase measure's ABSOLUTE anchor.
           *
           * `maxArcResidualRms` asks how far the geometry sits from the circle
           * it was drawn from; this asks the shape-free version of the same
           * question — is there any turning in this boundary that cancels — and
           * on a fixture that is nothing but arcs the answer has to be none.
           * It measures 0.0000 here, exactly, which is what makes the number
           * readable everywhere else: the gate is not a ratchet round some
           * number we happen to score, it is zero plus room for the flattener.
           */
          maxStaircaseLocal: 0.02,
          /**
           * ...and the same anchor for the sustained form.
           *
           * This exists so that the staircase family is not gated ONLY on our
           * own artwork (`tests/engine/provenance.test.mjs`). A ratchet on the
           * mascot cannot tell "the filter improved the drawing" from "the
           * filter was tuned on this drawing"; a fixture drawn from an equation
           * can, because its right answer was fixed before we traced it. Arcs
           * measure 0.0000 sustained, so this is zero plus room, not a number
           * we backed into.
           */
          maxStaircaseSustained: 0.01,
          /**
           * The drawing must stay on its own canvas.
           *
           * Not a ratchet and not a taste: the viewBox is a fact about the
           * input. It measures 0.00px here and its ceiling is one pixel of
           * flattening slack. Before the curve-fitter's tangent solve was
           * bounded above, three fixtures traced to geometry 4000px outside a
           * 960px canvas and nothing in the harness noticed — the raster
           * metrics clip it away and the layer-shape metrics were corrupted by
           * it rather than blind to it.
           */
          maxCanvasOverflow: 1,
          maxPaths: 200,
          maxSubPaths: 200,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 0,
          maxBytes: 100 * 1024,
          maxMs: 10000,
        },
        aspirations: { maxArcResidualRms: 0.08 },
        note:
          'Four antialiased discs (r=100/60/32/16) and an annulus, drawn from the circle ' +
          'equation so the fitted boundary can be scored against the shape rather than ' +
          'against itself. `boundarySmoothness` reports the worst arc.',
      },
      {
        // The alpha fixture. Every other generated fixture is opaque, which is
        // how a whole lap shipped with transparent PNGs traced as solid black:
        // the renderer's canvas ingest hands the engine (0,0,0,0) and the
        // engine reads only RGB. `maxTransparentAreaColorError` measures what
        // the trace paints where the source is see-through — 0 if it leaves it
        // alone (or flattens onto white), ~255 if it paints a black backdrop.
        id: 'sticker-alpha-256',
        provenance: 'synthetic',
        file: 'sticker-alpha-256.png',
        kind: 'alpha',
        format: 'png',
        width: 256,
        height: 256,
        supported: true,
        distinctColors: distinctOpaque(sticker),
        thresholds: {
          meanColorError: 8,
          ssim: 0.9,
          minInkRecall: 0.95,
          maxTransparentAreaColorError: 8,
          maxPaths: 200,
          maxSubPaths: 200,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 0,
          maxBytes: 100 * 1024,
          maxMs: 10000,
        },
        note:
          'Sticker/decal with a fully transparent background (REFERENCE\'s named use case). ' +
          'Fidelity is judged against the source flattened on white, which is what resvg ' +
          'composites onto, so both "leave it transparent" and "flatten onto white" pass and ' +
          'only an invented opaque background fails.',
      },
      {
        // REFERENCE lines 73-83: the gold-standard blind A/B case. Not
        // generated — it is real, license-clean mascot artwork plus the SVG
        // the reference product actually produced for it, checked into
        // fixtures/reference/. Thresholds are derived from the exemplar rather
        // than invented, and every ratio below is a RATCHET on a number that
        // was measured, not a restatement of REFERENCE's 3x/5x headline (which
        // is the product floor, not the bar the engine is held to today).
        id: 'reference-fox',
        provenance: 'in-house',
        file: 'reference/fox-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: null,
        // The settings the exemplar was actually captured at, recorded live in
        // the settings this artwork is judged at: Clipart, an 8-colour
        // palette, Smart anti-aliasing on, Enhance on, Minimum Area 5px².
        settings: { colorCount: 8, antiAliasing: 'smart', minArea: 5, enhance: true },
        // Three crops, because one is not enough. The FACE is where line art is
        // lost (both eyes, the nose, the mouth curve, the whisker arcs — 7 % of
        // the canvas and all of the meaning). The MUZZLE is the only crop that
        // can ask the leak question: the head is orange and the muzzle is white,
        // so orange inside the *face* box is a colour that box legitimately
        // contains while inside the muzzle it is not. The PAW is a warm brown
        // sock inside an orange leg inside a black outline — a whole colour
        // family that a ramp snapper can collapse onto its neighbours. Region
        // gates read the worst crop.
        salientRegions: [
          { name: 'face', x: 340, y: 350, width: 380, height: 200 },
          {
            name: 'muzzle',
            x: 455,
            y: 455,
            width: 140,
            height: 90,
            thresholds: { maxForeignColorRatio: 0.0005 },
          },
          { name: 'paw', x: 370, y: 720, width: 140, height: 100 },
        ],
        thresholds: {
          // Absolutes. 76.5 % of this canvas is transparent (white, once
          // flattened) and both drawings get that part right, so the whole-frame
          // MAE is small for everyone: ours 1.80, the reference product's 1.03. It is
          // gated anyway because it is the number that moves if the alpha path
          // ever paints a backdrop again.
          meanColorError: 3,
          ssim: 0.95,
          minInkRecall: 0.95,
          // The salient half of the same question, aggregated to the worst crop
          // (the muzzle, 0.909). The reference product scores 0.995 there — this is a
          // ratchet on ours, not parity with theirs.
          minRegionInkRecall: 0.88,
          // Worst-crop colour error. Ours 10.37 on the muzzle against the
          // exemplar's 4.36 — the fatter our outline sits over an antialiased
          // source, the more of this we pay, so it is a ratchet.
          maxRegionMeanColorError: 12,
          // B3: 8 requested, 6 found in the image after Enhance, 5 delivered.
          // The exemplar settles what "enough" is — the SVG the reference product
          // produced for this artwork at this setting carries SEVEN `<g fill>`
          // layers, two of which are near-duplicates (rgb(125,64,29) beside
          // rgb(116,58,28), rgb(8,0,0) beside rgb(0,0,0)) that
          // `maxNearDuplicateFills: 0` below forbids us from shipping. One fold
          // is what that costs; two is our own folds losing a colour family.
          maxPaletteShortfall: 1,
          // D3: the DXF has to carry the curve fitting the SVG paid for (25
          // SPLINE entities today) and must not balloon past the EPS of the same
          // drawing by flattening them into vertex runs (2.23x today).
          minDxfSplines: 10,
          maxDxfEpsBytesRatio: 3,
          // 76.5 % of this artwork is transparent, which makes it a STRONGER
          // alpha guard than any other fixture: a trace that paints the alpha-0
          // background opaque scores ~255 here while the whole-frame MAE can
          // still look survivable. Categorical, not a ratchet — 0.05 today, and
          // anything approaching 8 means a backdrop came back.
          maxTransparentAreaColorError: 8,
          maxTinySubPathRatio: 0.02,
          // Anchored on the exemplar's own 0.671: runs of h/v/l are a staircase
          // however few <path> elements they hide in. Ours is 1.000.
          minCurveCommandRatio: 0.65,
          // The reference product ships two near-duplicate pairs on this artwork
          // (10.9 and 8.0 RGB units apart). We ship none, and that is the bar:
          // layers that close are one region split into a patchwork, not two
          // colours a user asked for.
          maxNearDuplicateFills: 0,
          maxMs: 10000,
        },
        note:
          'Gold-standard exemplar (REFERENCE "blind A/B"). Judged at the settings the captured ' +
          'output was actually produced at — Clipart / 8 colours / Smart anti-aliasing / Enhance ' +
          'on / Minimum Area 5px², see fixtures/reference/ARTWORK.md. It anchors ' +
          'ECONOMY (paths/sub-paths/bytes/curve ratio) and, because the source is 76.5% ' +
          'transparent, it is also the strongest alpha guard in the suite. Fidelity is gated ' +
          'absolutely here and relative to the exemplar in the region ratios.',
      },
      {
        /**
         * B3: is the colour fold something the user can undo?
         *
         * `reference-fox` asks for 8 colours and gets 5 back, which the exemplar
         * mostly justifies (its own capture of this artwork has seven `<g fill>`
         * layers, two pairs of which are near-duplicates). This row asks the
         * question the panel cannot answer: ask for SIXTEEN and turn the
         * output-groups merge threshold explicitly to 0.
         * `src/engine/index.ts` computes
         * `groupThreshold = max(opts.mergeThreshold, opts.enhance ? 1 : 0)`, so
         * with Enhance on the control cannot go below 1 % and the sub-1 % fold
         * is unreachable from the panel. The customer who clicks the 16 radio,
         * then drags MERGE THRESHOLD to 0 to get the colours back, gets the same
         * five and no explanation.
         *
         * The bar is a RATCHET, not the fix. Today: 5 delivered with the fold
         * explicitly off, against 6 that the same 16-colour request reaches by
         * turning ENHANCE off instead — so the control still cannot be observed
         * doing anything. `maxPaletteShortfall: 3` pins today's number so the
         * gap cannot widen unnoticed; 2 is the number to aim at, and it is
         * known-reachable because Enhance-off already reaches it with
         * `nearDuplicateFillPairs` still 0.
         */
        id: 'reference-fox-16c-nomerge',
        provenance: 'in-house',
        file: 'reference/fox-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 16, enhance: true, mergeThreshold: 0 },
        // Declared for the side-by-side print only; this row carries no
        // exemplar-relative gate, because more colour layers legitimately cost
        // more sub-paths and that trade is what the user asked for.
        salientRegions: [{ name: 'muzzle', x: 455, y: 455, width: 140, height: 90 }],
        thresholds: {
          // The point of the row.
          maxPaletteShortfall: 3,
          // ...and the guard that stops it ever being bought with near-identical
          // creams: extra colours have to be extra COLOURS.
          maxNearDuplicateFills: 0,
          // Undoing a cleanup must not undo the picture: the fidelity bars are
          // the ones `reference-fox` holds.
          meanColorError: 3,
          ssim: 0.95,
          minInkRecall: 0.95,
          maxRegionMeanColorError: 11,
          maxTransparentAreaColorError: 8,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.65,
          maxMs: 10000,
        },
        note:
          'B3 reversibility: 16 colours + Enhance with the output-groups merge threshold ' +
          'explicitly at 0. The fold that costs three colours must be reachable by the control ' +
          'the panel already shows (`merge-threshold`), or the shortfall the hint blames on ' +
          '"the cleanup settings" is not a setting.',
      },
      {
        /**
         * The opaque counterpart, and the only thing that can prove the alpha
         * path is what changed.
         *
         * `fox-sticker-white.png` is the same artwork with the transparency
         * flattened onto white — the picture a user gets by opening the sticker
         * in any editor that cannot keep alpha. Everything the engine sees is
         * identical except the alpha channel, so a divergence between this row
         * and `reference-fox` is attributable: it is the ingest, not the tracer.
         *
         * There is no reference-product capture of the flattened variant, so every
         * bar here is ABSOLUTE and measured on this build rather than a ratio
         * against something. The one that earns the row: the paw crop comes back
         * with 0.46 % of its pixels painted a colour the source crop does not
         * contain, where the transparent source scores 0.000 % — the flattened
         * ingest hands the quantizer a white plateau that the alpha path never
         * shows it, and a slot goes to the wrong family.
         */
        id: 'reference-fox-white',
        provenance: 'in-house',
        file: 'reference/fox-sticker-white.png',
        kind: 'clipart',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 8, antiAliasing: 'smart', minArea: 5, enhance: true },
        salientRegions: [
          { name: 'face', x: 340, y: 350, width: 380, height: 200 },
          { name: 'muzzle', x: 455, y: 455, width: 140, height: 90 },
          { name: 'paw', x: 370, y: 720, width: 140, height: 100 },
        ],
        thresholds: {
          meanColorError: 3,
          ssim: 0.94,
          minInkRecall: 0.95,
          minStrictInkRecall: 0.89,
          minRegionInkRecall: 0.87,
          minRegionStrictInkRecall: 0.83,
          maxRegionMeanColorError: 12,
          // The number this row exists for: 0.46 % of the paw is a hue the
          // source paw does not contain, against 0.000 % on the transparent
          // source at the same settings. Pinned so it cannot grow while every
          // other gate stays green; 0.0005 (the bar `reference-fox` holds) is
          // the number to aim at.
          maxRegionForeignColorRatio: 0.006,
          // 8 requested, 7 found in the image, 5 delivered — one fold more than
          // the transparent source loses, which is the same finding again.
          maxPaletteShortfall: 2,
          maxPaths: 16,
          maxSubPaths: 70,
          maxBytes: 32 * 1024,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.65,
          maxNearDuplicateFills: 0,
          maxMs: 10000,
        },
        note:
          'The white-flattened counterpart of reference-fox: same artwork, same settings, no ' +
          'alpha. Absolute bars only — there is no reference-product capture of the flattened variant ' +
          'to ratio against. It earns its keep by being the control that attributes a difference ' +
          'to the ingest rather than the tracer.',
      },
      {
        /**
         * The settings a user actually gets.
         *
         * The rows above all pin a configuration — 8 colours + Enhance,
         * 16 colours + Enhance with the fold off — which is how the 8-colour
         * default a user opens the app with went unmeasured for seven laps while
         * its output painted a region the wrong hue. No `settings` key at all is
         * the point of the row: whatever `DEFAULT_SETTINGS` says today is what
         * gets measured.
         *
         * On this fixture the defaults differ from `reference-fox` by exactly
         * one tick — Enhance off — because the reference product's own capture was
         * taken at Clipart / 8 colours / Smart AA / min-area 5, which is what
         * `DEFAULT_SETTINGS` already ships. So this row does double duty: it is
         * both "the configuration a user gets" and "the ENHANCE-OFF economy
         * measurement", and it carries the exemplar-relative economy bars for
         * that reason. If `DEFAULT_SETTINGS` ever moves, this row moves with it
         * and `reference-fox` does not — which is exactly the drift worth
         * catching.
         */
        id: 'reference-fox-default',
        provenance: 'in-house',
        file: 'reference/fox-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: null,
        salientRegions: [
          {
            name: 'face',
            x: 340,
            y: 350,
            width: 380,
            height: 200,
            // The reference product's own capture scores 4.75 on this exact crop and
            // ours scores 8.09. A ratchet, not parity — 4.75 is the number to
            // aim at, and this bar only holds that the default configuration
            // cannot quietly get worse at the crop that decides the blind A/B.
            thresholds: { maxMeanColorError: 10 },
          },
          {
            name: 'muzzle',
            x: 455,
            y: 455,
            width: 140,
            height: 90,
            // The head is orange and the muzzle is white, so this is the only
            // crop where "a hue the source does not contain" is a question with
            // an answer. Both the reference product and our default score 0.000 %.
            thresholds: { maxForeignColorRatio: 0.0005 },
          },
          {
            name: 'paw',
            x: 370,
            y: 720,
            width: 140,
            height: 100,
            thresholds: { maxForeignColorRatio: 0.0005 },
          },
        ],
        thresholds: {
          // Worst crop, which is the muzzle at 10.91 against the reference product's
          // 4.36 — the mouth arcs and the whisker curls are thin dark line art
          // over white, and every pixel of outline we paint fatter than the
          // source is mean colour error against an antialiased edge.
          maxRegionMeanColorError: 12,
          // The reference product keeps this crop's outlines at 0.957 strict ink
          // recall; ours is 0.848. Held as both an absolute floor and a ratio,
          // because the absolute one alone would let the exemplar improve out
          // from under us.
          minRegionStrictInkRecall: 0.82,
          // 8 requested, 6 found in the image, 5 delivered.
          maxPaletteShortfall: 1,
          meanColorError: 3,
          ssim: 0.95,
          minInkRecall: 0.95,
          maxTransparentAreaColorError: 8,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.65,
          maxNearDuplicateFills: 0,
          maxMs: 10000,
        },
        note:
          'DEFAULT_SETTINGS on the gold-standard artwork — deliberately no `settings` override. ' +
          'The other reference rows all pin a configuration, which left the one a user gets out ' +
          'of the box unmeasured while its default output had a hue-inverted region. On this ' +
          'fixture the defaults are also the Enhance-off configuration, so this row carries the ' +
          'default-settings economy bars as well.',
      },
      {
        /**
         * FRANKIE — the mascot, and the second reference-product exemplar.
         *
         * Same construction as `reference-fox` (original artwork, MIT, plus the
         * SVG the reference product actually produced for it, captured live and recorded
         * in fixtures/reference/ARTWORK.md) and kept alongside it rather
         * than instead of it: the fox stays a valid license-clean fixture and a
         * second subject is the only way to tell a finding from a coincidence.
         *
         * What this row adds that the fox cannot: an EYES box with a named
         * colour. The artwork's eyes are olive, rgb(187,161,80), and they are
         * 22.7 % of that crop and ~0.3 % of the canvas — small enough that
         * losing them entirely moves no other number in the harness. The fox
         * showed the same defect (blue eyes coming back grey) and nothing could
         * gate it, because there was no metric that could ask.
         *
         * The answer here, measured: at these settings **our engine loses the
         * eye colour completely** — 0.6 % of the source's olive survives, and
         * the palette comes back 6 of 8 with the eye pixels repainted in the
         * nose/ear PINK slot, rgb(227,139,105). The reference product keeps a
         * distinct eye colour on the same upload (its generative Enhance
         * repaints the olive as rgb(121,176,89) and spends a whole output layer
         * on it, 22.9 % of the crop). So the eye bar here is an ASPIRATION, not
         * a gate — it is a known engine gap, filed as issue #2, and
         * `reference-frankie-default` below proves it is reachable, because the
         * DEFAULT settings keep 99.2 % of the same colour.
         */
        id: 'reference-frankie',
        provenance: 'in-house',
        file: 'reference/frankie-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1195,
        height: 896,
        supported: true,
        distinctColors: null,
        // The settings the exemplar was captured at, recorded live in
        // the settings this artwork is judged at: Clipart, an 8-colour
        // palette, Smart anti-aliasing on by default for this upload, Enhance
        // on, Minimum Area 5px².
        settings: { colorCount: 8, antiAliasing: 'smart', minArea: 5, enhance: true },
        /**
         * Three crops. The FACE is the blind-A/B crop — both eyes, the nose, the
         * muzzle and the mouth arcs, which is all of the meaning and a fifth of
         * the drawing. The CHEST is the necklace-stripe area: cream chest, two
         * curved stripe-orange arcs and the body orange, three tones of one
         * colour family stacked inside 300x140 px and exactly what a ramp
         * snapper collapses. The EYES are the colour question.
         */
        salientRegions: [
          { name: 'face', x: 210, y: 295, width: 360, height: 200 },
          { name: 'chest', x: 240, y: 505, width: 300, height: 140 },
          {
            ...FRANKIE_NOSE,
            // 1.15 on the pre-scrub artwork, 1.19 on this one — the same white
            // muzzle that moved `maxMeanColorError` above.
            thresholds: { ...FRANKIE_NOSE.thresholds, maxInkCoverageRatio: 1.2 },
          },
          {
            ...FRANKIE_FOREHEAD,
            /**
             * A ratchet, and it moved: 0.944 before the hue-distinct slot
             * reservation (src/engine/color.ts `reserveChromatic`) and 0.980
             * after it. The stripe-orange was never the colour at risk here —
             * what changed is that the salmon and the olive stopped being folded
             * into the body orange, so the fold no longer has to re-centre the
             * orange onto pixels that belong to three colours.
             */
            /**
             * ...and the same question against the reference product, which was the
             * aspiration on this crop and is now a GATE: it keeps 0.976 of the
             * stripe-orange, we keep 0.980, and 1.004x is the first time
             * anything in this harness has said we match it on a small-feature
             * survival question. Stated as a ratio because the absolute number
             * belongs to the artwork and this one belongs to the tracer.
             */
            thresholds: { minColorPresenceRatio: 0.97 },
            aspirations: {},
          },
          {
            ...FRANKIE_CHEEK,
            /**
             * The demo defect, with a number on it. Before the fringe collapse
             * learned what "between" means (`FRINGE_BLEND_CORRIDOR`), this crop
             * kept 0.525 of the source's stripe-orange — the middle stripe gone
             * outright and the others thinned — against the reference product's
             * 1.006. It keeps 0.960 now, 0.955x the reference product's.
             */
            thresholds: { ...FRANKIE_CHEEK.thresholds, minColorPresenceRatio: 0.94 },
            // The reference product loses none of it. Neither should we.
            aspirations: {},
          },
          {
            name: 'eyes',
            x: 244,
            y: 304,
            width: 258,
            height: 84,
            // The source's own eye colour, and — separately — the colour the
            // reference product's generative Enhance repaints it as. Measuring the
            // exemplar against the olive would score it 1.9 % against our 0.6 %
            // and read as a photo finish, when in fact its eyes are green and
            // ours are gone.
            color: 'rgb(187,161,80)',
            exemplarColor: 'rgb(121,176,89)',
            // ...and the OTHER thing that goes wrong in this crop, which the
            // colour question cannot see: a cream ribbon wedged between the
            // black eye outline and the olive iris (docs/HARNESS.md
            // `seamSlivers`). 0.02 % is a ratchet on a crop that is clean here
            // because Enhance's median erases the source's own light rim; the
            // default-settings row is where it was reported.
            /**
             * ISSUE #2, AND IT IS A GATE NOW.
             *
             * Both of these were aspirations, at 0.006 and 0.006x, because
             * Enhance spent the eyes' palette slot on a second orange. The
             * hue-distinct slot reservation (src/engine/color.ts
             * `reserveChromatic`) gives it back: 1.032 of the source's olive
             * survives and 1.024x of what the reference product's generative repaint
             * puts in the same crop. The bars stay at the 0.9 they were written
             * at rather than being ratcheted onto today's number — the point of
             * this pair is "the eyes are the right colour", not "they are within
             * 3 % of a build from one Wednesday".
             */
            thresholds: {
              maxSliverRatio: 0.0002,
              minColorPresenceRatio: 0.9,
            },
          },
        ],
        thresholds: {
          // Absolutes. 53 % of this canvas is transparent (white once
          // flattened) — less than the fox's 76.5 %, so these are a little
          // tighter than the fox's equivalents on the same reasoning: they are
          // what moves if the alpha path ever paints a backdrop again.
          // Measured: 2.20 and 0.9597.
          meanColorError: 3,
          ssim: 0.94,
          minInkRecall: 0.95,
          // Worst crop, which is the face at 0.966 loose / 0.935 strict against
          // the reference product's 0.997 / 0.983.
          minRegionInkRecall: 0.95,
          minRegionStrictInkRecall: 0.9,
          // Worst crop's colour error, which is the eyes at 12.17 — and the eyes
          // are worst precisely BECAUSE the olive is gone, so this bar and the
          // aspiration above are the same finding measured two ways. The real
          // product scores 13.66 on the same crop, having repainted the eyes a
          // colour the source does not have.
          maxRegionMeanColorError: 14,
          /**
           * A colour the crop does not contain, anywhere. The reference product
           * scores 22.96 % in the eyes box because its generative Enhance
           * repaints them; ours is a trace, so ours has no excuse.
           *
           * 0.05 % until the muzzle was recoloured to white fur. It is the
           * chest crop that moved — 0.01 % on the pre-scrub artwork, 0.09 % on
           * this one — and the 26 pixels it now reports are not a leak: no two
           * of them are the same colour, each is 33-49 units off the nearest
           * source colour, and they are resvg's own edge antialiasing sampled
           * where a cream boundary meets a white one, which the white muzzle
           * created more of. Re-baselined at 0.1 %, still two orders of
           * magnitude under a repaint.
           */
          maxRegionForeignColorRatio: 0.001,
          // No crop may thread a light ribbon along a boundary the source draws
          // solid (docs/HARNESS.md `seamSlivers`). 0 today on every crop of this
          // row — Enhance's median erases the source's own light rim before the
          // quantizer can find a slot for it — so this is a ratchet on correct
          // behaviour, and the default-settings row is where the defect lives.
          maxRegionSliverRatio: 0.0002,
          // 8 requested, 8 found in the image, 6 delivered. Two folds, and one
          // of them is the eyes — pinned so it cannot become three.
          maxPaletteShortfall: 2,
          maxTinySubPathRatio: 0.02,
          // Anchored on the exemplar's own 0.647, the same way the fox's is.
          // Ours is 0.977.
          minCurveCommandRatio: 0.65,
          maxNearDuplicateFills: 0,
          // 53 % transparent, so this is a real alpha guard: a trace that paints
          // the alpha-0 background opaque scores ~255 here. 0.14 today.
          maxTransparentAreaColorError: 8,
          maxMs: 10000,
        },
        /**
         * The staircase, REPORTED and not gated — because this is our own
         * artwork (`provenance: 'in-house'`, and see
         * `tests/engine/provenance.test.mjs`).
         *
         * It was a ratchet at 0.016 for two laps, set where a filter developed
         * against this very drawing happened to leave it. That is the shape of
         * mistake this project keeps making — the fixture and the beneficiary
         * being the same object — and a number our own mascot alone can move is
         * not entitled to stop a build. The absolute anchor moved to
         * `arcs-560x256`, where the right answer comes from the equation the
         * discs were drawn from rather than from what we scored.
         *
         * 0.05 / 0.02 are the marks to beat, and they stay on screen every run.
         */
        aspirations: { maxStaircaseLocal: 0.05, maxStaircaseSustained: 0.02 },
        note:
          'The mascot, and the second gold-standard exemplar. Judged at the settings the ' +
          'captured output was produced at — Clipart / 8 colours / Smart anti-aliasing / Enhance ' +
          'on / Minimum Area 5px², see fixtures/reference/ARTWORK.md. It is the ' +
          'only fixture that can ask whether a small hue-distinct feature kept its palette slot ' +
          "(the eyes box names a colour); today it answers no, and that is an aspiration with an " +
          'open issue rather than a gate, because the default settings already reach it.',
      },
      {
        /**
         * The settings a user actually gets, on the mascot — and the row that
         * turns the eyes finding from an observation into a bar.
         *
         * These two rows differ by exactly one tick: `reference-frankie` pins
         * Enhance ON (because that is what the reference product's capture was taken
         * at) and this one takes `DEFAULT_SETTINGS`, which ships Enhance OFF and
         * is otherwise the same Clipart / 8 colours / Smart AA / min-area 5.
         *
         * The eye colour survives here — 99.2 % of the source's olive comes
         * back, in a palette of 7 rather than 6 — so this bar is a REAL gate and
         * not an aspiration. That is the useful shape of the finding: the
         * default configuration keeps a small hue-distinct feature, our own
         * Enhance is what spends its slot on a second orange, and now neither
         * half can move without a number moving with it.
         *
         * No `settings` key at all, on purpose: whatever `DEFAULT_SETTINGS` says
         * today is what gets measured, so if the defaults ever move, this row
         * moves and `reference-frankie` does not.
         */
        id: 'reference-frankie-default',
        provenance: 'in-house',
        file: 'reference/frankie-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1195,
        height: 896,
        supported: true,
        distinctColors: null,
        /**
         * No exemplar. The reference product's capture of this artwork was taken with
         * Enhance ON, and its Enhance is a generative re-illustration — it is
         * not a trace of these pixels at all. `reference-frankie` carries the
         * exemplar-relative economy bars for that reason; this row is gated
         * absolutely, on numbers measured on this build.
         */
        salientRegions: [
          { name: 'face', x: 210, y: 295, width: 360, height: 200 },
          { name: 'chest', x: 240, y: 505, width: 300, height: 140 },
          {
            ...FRANKIE_NOSE,
            // 1.30 on the pre-scrub artwork, 1.31 on this one — the white
            // muzzle again, and a tenth of what it cost the Enhance-on row,
            // because Enhance's median is what turns the extra contrast into
            // extra ink.
            thresholds: { ...FRANKIE_NOSE.thresholds, maxInkCoverageRatio: 1.35 },
          },
          {
            ...FRANKIE_FOREHEAD,
            // A ratchet at what the default settings keep today (0.967).
            thresholds: { minColorPresenceRatio: 0.96 },
            // ...and the reference product's 0.976 as the target, because the stripe
            // is thinned rather than lost and the distance is small enough that
            // only a measured number keeps it honest. Still unmet here, and met
            // on the Enhance-on row: the last 1 % of this crop is Enhance's
            // median smoothing the stripe's own shading, which is a different
            // mechanism from the fold that used to eat it.
            aspirations: { minColorPresenceRatio: 0.976 },
          },
          {
            ...FRANKIE_CHEEK,
            // 0.567 before the fringe-collapse fix, 0.967 after it. No
            // exemplar on this row, so the bar is absolute; the reference product's
            // 1.006 is recorded on `reference-frankie`.
            thresholds: { ...FRANKIE_CHEEK.thresholds, minColorPresenceRatio: 0.95 },
            aspirations: { minColorPresenceRatio: 1.0 },
          },
          {
            name: 'eyes',
            x: 244,
            y: 304,
            width: 258,
            height: 84,
            color: 'rgb(187,161,80)',
            thresholds: {
              // The point of the row. Measured 0.992 — the default settings keep
              // the eye colour. A ratchet on behaviour that is CORRECT today,
              // which is the cheapest kind to hold and the easiest to lose: the
              // fox's blue eyes went grey without a single number moving.
              // The other half of issue #2.
              minColorPresenceRatio: 0.9,
              // THE CREAM RIBBON, gated where it was reported. The source draws
              // a light rim inside the black eye outline (a sharpening halo of
              // its own resampling); at eight colours the nearest slot to that
              // rim is the MUZZLE CREAM, so the trace threads a cream ribbon
              // between the outline and the iris — a colour that belongs to
              // neither side of that boundary. `foreignColorRatio` cannot see it
              // (the crop legitimately contains cream), MAE moves by hundredths.
              // `seamSlivers` can: 47 pixels, 0.22 % of the crop.
              maxSliverRatio: 0.0002,
            },
          },
        ],
        thresholds: {
          // Measured 1.92 / 0.9670 / 0.996 / 0.991. Every bar here is absolute
          // and taken off this build — there is no exemplar to ratio against.
          meanColorError: 3,
          ssim: 0.94,
          minInkRecall: 0.95,
          minStrictInkRecall: 0.97,
          // No crop may thread a light ribbon along a boundary the source draws
          // solid. The face crop carries the eyes, so this is the same defect
          // asked of the whole face rather than of one box.
          maxRegionSliverRatio: 0.0002,
          // Worst crop: the face at 0.986 loose, 0.975 strict. Both better than
          // the Enhance-on row, which is worth saying out loud — the bundle
          // costs line art here as well as a palette slot.
          minRegionInkRecall: 0.96,
          minRegionStrictInkRecall: 0.95,
          // Worst crop is the eyes at 6.28, against 12.17 with Enhance on. Half
          // the error, because the eyes are still the right colour.
          maxRegionMeanColorError: 8,
          // Same re-baseline and the same 26 rasterizer-AA pixels as the
          // Enhance-on row above: 0.07 % here.
          maxRegionForeignColorRatio: 0.001,
          // 8 requested, 8 found, 7 delivered — one fold, against Enhance-on's
          // two, and the extra slot is the eyes.
          maxPaletteShortfall: 1,
          // The other side of the trade, and the reason this is not simply the
          // better configuration: Enhance off costs 225 sub-paths against 66 and
          // 49.3 KB against 18.5. Both are pinned so neither half of the trade
          // can drift unnoticed.
          maxPaths: 12,
          maxSubPaths: 300,
          maxBytes: 64 * 1024,
          maxTinySubPathRatio: 0.02,
          // Anchored on the reference product's 0.647 on this artwork, even though
          // this row carries no exemplar ratio. Ours is 0.984.
          minCurveCommandRatio: 0.65,
          maxNearDuplicateFills: 0,
          maxTransparentAreaColorError: 8,
          maxMs: 10000,
        },
        note:
          'DEFAULT_SETTINGS on the mascot — deliberately no `settings` override, so this row ' +
          'moves if the defaults do. It differs from reference-frankie by one tick (Enhance off) ' +
          'and that tick is worth a palette slot: the eyes keep their olive here and lose it ' +
          'there, which is the whole shape of the small-hue-distinct-colour finding.',
      },
      /**
       * THIRD-PARTY ARTWORK — the only fixtures entitled to decide that a
       * change to the engine is an improvement.
       *
       * Every other picture in this corpus we drew: eight synthetic ones from
       * equations, and two mascots. A filter tuned on our own drawings improves
       * our own drawings whether or not it improves anything else, which is how
       * a de-staircasing change got two laps into the repo on the strength of
       * how much it smoothed the mascot (`docs/HARNESS.md`, "Who is allowed to
       * decide that a change is an improvement").
       *
       * Licences, authors and source URLs are in
       * `fixtures/third-party/LICENSES.md`, written by
       * `scripts/source-fixture.mjs` from the source's metadata BEFORE each file
       * was downloaded. All four are public domain and redistributable, so
       * unlike the local set these ship in a clone and can gate CI.
       *
       * Thresholds here are deliberately structural — "did we produce a sane
       * document in reasonable time" — and not quality ratchets. A ratchet set
       * on a fixture's first-ever measurement is a bar at wherever we happened
       * to land, which is the same mistake in a different place; the numbers are
       * reported every run and can be ratcheted once someone has looked at what
       * they should be.
       */
      {
        id: 'third-party-poster',
        provenance: 'third-party',
        file: 'third-party/poster-letterforms-900.jpg',
        kind: 'clipart',
        format: 'jpeg',
        width: 960,
        height: 1223,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 8 },
        /**
         * Two crops, because the region metrics had nowhere else to live.
         *
         * Removing the un-redistributable local artwork took with it the only
         * non-authored fixture that declared salient regions, which left eight
         * region gates anchored solely on our own two mascots — the exact thing
         * `tests/engine/provenance.test.mjs` forbids, and it went red the moment
         * the local set was gone. These are the re-anchor.
         *
         * `wordmark` is the whole point of sourcing this picture: dark serif
         * type over flat poster colour, which is where ink recall, strict ink
         * recall, sliver ratio and foreign colour all mean something at once.
         *
         * ONE region, not two. A `sky` crop was tried alongside it and removed:
         * it contains no source ink at all, so its strict ink recall is 0 by
         * definition, and since the fixture-level region bars aggregate to the
         * WORST crop it dragged `regionStrictInkRecall` to zero and made the
         * gate unusable. A region that cannot fail for the right reason cannot
         * pass for the right reason either.
         */
        salientRegions: [
          {
            name: 'wordmark',
            x: 40,
            y: 1035,
            width: 880,
            height: 100,
            /**
             * Per-crop bars. `maxMeanColorError` and the ink-coverage pair are
             * REGION gates — declaring `maxMeanColorError` at fixture level is
             * accepted by the manifest and matches no metric at all, which the
             * dead-gate check reports as "no such gate". Measured here: MAE
             * 10.0, ink spend 1.19x the source's.
             */
            thresholds: {
              maxMeanColorError: 16,
              maxInkCoverageRatio: 1.5,
              minInkCoverageRatio: 0.85,
            },
          },
        ],
        thresholds: {
          meanColorError: 30,
          ssim: 0.6,
          maxPaths: 6000,
          maxSubPaths: 9000,
          maxBytes: 2 * 1024 * 1024,
          maxMs: 20000,
          /**
           * The region and palette bars, re-anchored here off the mascots.
           *
           * Set from this fixture's first measurement and deliberately LOOSE —
           * they are blow-up guards, not quality ratchets, and nobody has yet
           * decided what good looks like for letterforms. Measured: region ink
           * 0.989, strict 0.964, MAE 10.0, foreign colour 0.000 %, slivers
           * 0.032 %, palette shortfall 0, global strict ink 0.992.
           */
          minRegionInkRecall: 0.96,
          minRegionStrictInkRecall: 0.92,
          maxRegionMeanColorError: 16,
          maxRegionForeignColorRatio: 0.004,
          maxRegionSliverRatio: 0.001,
          maxPaletteShortfall: 2,
          minStrictInkRecall: 0.97,
          /**
           * D3 export structure, re-anchored here off the fox.
           *
           * These two were the longest-standing entries in
           * `KNOWN_IN_HOUSE_ANCHORS`: "the DXF must carry the curves the SVG
           * paid for" is a claim about the exporter and had no business being
           * provable only against a mascot we drew. Poster art fits an ordinary
           * number of cubics, so it anchors the same claim without the
           * provenance problem.
           */
          minDxfSplines: 10,
          maxDxfEpsBytesRatio: 6,
          // Same bar as arcs-560x256, on artwork nobody here drew: 0.79px today,
          // 4034px before the fitter's tangent solve was bounded above.
          maxCanvasOverflow: 2,
        },
        note:
          'WPA travel poster, 1938 (public domain). The corpus had NO letterforms at ' +
          'all before this, and a wordmark is the case a de-staircasing change endangers ' +
          'most: three sizes of serif type here, down to a caption a few pixels tall, over ' +
          'flat poster colour and a real scanned sky gradient.',
      },
      {
        id: 'third-party-photo',
        provenance: 'third-party',
        file: 'third-party/photo-highcontrast-800.jpg',
        kind: 'photo',
        format: 'jpeg',
        width: 960,
        height: 960,
        supported: true,
        distinctColors: null,
        // Traced at the preset the app offers for this kind of picture, which is
        // what a user dragging in a photograph would pick. At Clipart defaults
        // it scores SSIM 0.49, and that number is about the preset, not the
        // engine.
        settings: { preset: 'photo' },
        /**
         * Structural only, and deliberately no SSIM or colour-error bar.
         *
         * A real photograph reduced to nine flat colours scores SSIM ~0.50, and
         * the first threshold I wrote here (0.6) was a guess that the picture
         * then failed. Inventing a quality bar for a case nobody has looked at
         * yet, and setting it at whatever this run produced, is the same
         * mistake this whole area is about — so these numbers are reported
         * every run and gate nothing until someone decides what good looks like
         * for a photograph.
         */
        thresholds: {
          maxPaths: 12000,
          maxSubPaths: 20000,
          maxTinySubPathRatio: 0.3,
          maxBytes: 4 * 1024 * 1024,
          maxMs: 30000,
        },
        note:
          'A real photograph (NASA, public domain), rescaled and re-encoded by the ' +
          "source's own thumbnailer, so its JPEG ringing is genuine rather than " +
          'simulated. `photo-gradient` is a gradient we generated; this is what a user ' +
          'actually drags in.',
      },
      {
        id: 'third-party-lineart',
        provenance: 'third-party',
        file: 'third-party/lineart-engraving-447.jpg',
        kind: 'clipart',
        format: 'jpeg',
        width: 447,
        height: 539,
        supported: true,
        distinctColors: null,
        settings: { preset: 'sketch' },
        thresholds: {
          meanColorError: 30,
          ssim: 0.5,
          maxPaths: 8000,
          maxSubPaths: 12000,
          maxTinySubPathRatio: 0.4,
          maxBytes: 2 * 1024 * 1024,
          maxMs: 20000,
        },
        note:
          'A 19th-century engraving (public domain): dense cross-hatching, which is ' +
          'almost entirely one-pixel runs. Nothing else in the corpus looks remotely ' +
          'like this, and it is the hardest case for any filter that judges thin runs — ' +
          'which is exactly why it is here. Traced at the Sketch preset the artwork was ' +
          'drawn for.',
      },
      {
        id: 'third-party-sticker',
        provenance: 'third-party',
        file: 'third-party/sticker-figure-900.png',
        kind: 'clipart',
        format: 'png',
        width: 960,
        height: 1271,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 8 },
        thresholds: {
          meanColorError: 30,
          ssim: 0.55,
          maxPaths: 4000,
          maxSubPaths: 6000,
          maxTinySubPathRatio: 0.4,
          maxBytes: 1024 * 1024,
          maxMs: 20000,
        },
        /**
         * The reason this fixture exists, and it is NOT met.
         *
         * ZERO is the aim because zero is what the defect's absence looks like:
         * a traced silhouette should carry no hairline of colour that belongs to
         * nothing behind it, and the mascot reaches zero. Not a ratchet to
         * whatever we score — `snapAlphaFringe` takes this artwork from 42 to 8,
         * real progress that is not the finish, and the remaining 8 stay on
         * screen every run rather than being legislated away.
         *
         * The measured reason it is short: this artwork's edge is SOFT, with
         * partial-alpha runs of median 3px and p90 15px, while the pass reaches a
         * fixed 2px. Reading the reach from the alpha profile instead was tried
         * and measured WORSE (33 and 39 against 8) — that band is genuine
         * feathering as much as contamination, so seeding from it eats real
         * features. See docs/HARNESS.md, "An adaptive fix that measured worse".
         */
        aspirations: {
          maxAlphaFringeSlivers: 0,
        },
        note:
          'A CC0 figure with a transparent background, and the only artwork in the ' +
          'corpus that is BOTH transparent and not ours. It is here to hold the alpha ' +
          'fringe: a cut-out PNG was composited against something when it was drawn, ' +
          'and the pixels just inside its outline keep a trace of it, which quantizes ' +
          'into thin ribbons riding the silhouette. Nothing opaque can exercise that, ' +
          'so before this fixture the defect had no gate that could fire.',
      },
      {
        id: 'third-party-lowres',
        provenance: 'third-party',
        file: 'third-party/lowres-poster-250.jpg',
        kind: 'clipart',
        format: 'jpeg',
        width: 250,
        height: 343,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 8 },
        thresholds: {
          meanColorError: 30,
          ssim: 0.55,
          maxPaths: 4000,
          maxSubPaths: 6000,
          maxTinySubPathRatio: 0.4,
          maxBytes: 1024 * 1024,
          maxMs: 10000,
        },
        note:
          'A 1930s travel poster (public domain) at 250px — a low-resolution, heavily ' +
          'compressed web image, where the pixel grid IS most of the signal and every ' +
          'geometry metric behaves differently. Carries small glyphs and a soft gradient ' +
          'at a size where both are only a few pixels across.',
      },
      {
        id: 'unsupported-gif',
        provenance: 'synthetic',
        file: 'unsupported-animation.gif',
        kind: 'unsupported',
        format: 'gif',
        supported: false,
        note: 'Must be rejected with a clear message (REFERENCE A2).',
      },
      {
        id: 'unsupported-txt',
        provenance: 'synthetic',
        file: 'unsupported-notes.txt',
        kind: 'unsupported',
        format: 'text',
        supported: false,
        note: 'Must be rejected with a clear message (REFERENCE A2).',
      },
    ],
  };

  await fs.writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const f of manifest.fixtures) {
    // fixtures/reference/* are checked in, not generated — report them, don't
    // recreate them, and say so loudly if one has gone missing.
    const stat = await fs.stat(join(outDir, f.file)).catch(() => null);
    console.log(
      `${f.id.padEnd(20)} ${f.file.padEnd(28)} ${String(stat ? stat.size : 'MISSING').padStart(8)}` +
        (stat ? ' bytes' : '') +
        (f.distinctColors ? `  ${f.distinctColors} colours` : ''),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
