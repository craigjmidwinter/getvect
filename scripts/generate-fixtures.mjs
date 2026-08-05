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

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const logo512 = drawLogo(512);
  const logo1024 = drawLogo(1024);
  const noisy512 = speckle(logo512, 0x5eed1234);
  const gradient = drawGradient(512, 384);
  const bmpShapes = drawLogo(256);
  const sticker = drawSticker(256);

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
        // The alpha fixture. Every other generated fixture is opaque, which is
        // how a whole lap shipped with transparent PNGs traced as solid black:
        // the renderer's canvas ingest hands the engine (0,0,0,0) and the
        // engine reads only RGB. `maxTransparentAreaColorError` measures what
        // the trace paints where the source is see-through — 0 if it leaves it
        // alone (or flattens onto white), ~255 if it paints a black backdrop.
        id: 'sticker-alpha-256',
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
        file: 'reference/fox-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: null,
        // The settings the exemplar was actually captured at, recorded live in
        // fixtures/reference/OBSERVED-UI.md: Clipart, an auto-selected 8-colour
        // palette, Smart anti-aliasing on, Enhance on, Minimum Area 5px².
        settings: { colorCount: 8, antiAliasing: 'smart', minArea: 5, enhance: true },
        exemplar: 'reference/fox-sticker-clipart-8colors-smartAA.svg',
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
          // MAE is small for everyone: ours 1.80, the real product's 1.03. It is
          // gated anyway because it is the number that moves if the alpha path
          // ever paints a backdrop again.
          meanColorError: 3,
          ssim: 0.95,
          minInkRecall: 0.95,
          // The salient half of the same question, aggregated to the worst crop
          // (the muzzle, 0.909). The real product scores 0.995 there — this is a
          // ratchet on ours, not parity with theirs.
          minRegionInkRecall: 0.88,
          // Continuity against the real product, in the crop where we are worst
          // relative to it. Loosely (`inkRecall`, luma < 128 counts as kept) a
          // thinned or dashed contour still scores ~1; strictly (source ink must
          // come back as ink) the muzzle reads 0.903x of the exemplar's score.
          // The number to aim at is 1.0 — the real product's mouth arcs and
          // whiskers come back solid where ours taper.
          minRegionStrictInkRecallRatio: 0.87,
          // Worst-crop colour error. Ours 10.37 on the muzzle against the
          // exemplar's 4.36 — the fatter our outline sits over an antialiased
          // source, the more of this we pay, so it is a ratchet.
          maxRegionMeanColorError: 12,
          // Boundary raggedness against the real product's, globally
          // (perimeter over area per colour layer). Ours 2.99 against its 4.55,
          // i.e. 0.66x: on this artwork the real product spends its layers on
          // two near-identical browns and a doubled black, and we do not. The
          // bar is 0.8 because 1.1 ("the same class of edge", which is what it
          // meant when we were the ragged one) is 1.7x reality here, and a gate
          // that far above the measurement is a deleted gate.
          maxLayerCompactnessRatio: 0.8,
          // The same defect measured locally: turning per unit boundary length
          // (metrics.mjs `layerBoundaryWobble`), which is what sees a cubic
          // fitted to a noisy threshold. Compactness is global and cannot tell a
          // genuinely intricate shape from a smooth one traced onto a noisy
          // threshold. Ours 28.4 against the exemplar's 80.2 (0.35x).
          maxLayerWobbleRatio: 0.45,
          // Stroke-width UNIFORMITY against the real product's, in the crop
          // where we are worst (metrics.mjs `strokeWidthProfile`). This is the
          // thing REFERENCE's blind A/B is actually decided on and the thing
          // every other ink metric in this repo reads BACKWARDS: a line that
          // thickens, thins and breaks recalls more ink and joins more
          // components than an even one. Ours is 1.64x the exemplar's cv on the
          // muzzle (0.455 against 0.277); 1.15x is the number to aim at.
          maxStrokeWidthCvRatio: 1.8,
          // ...and how much fatter our line is than the real product's trace of
          // the same line. 1.11x on the face, worst crop.
          maxStrokeWidthOverExemplar: 1.25,
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
          // Economy against the real product. REFERENCE asks for "within ~3x
          // paths, ~5x bytes"; we are at 0.08x, 0.22x and 0.42x, so the product
          // floor would gate nothing. These are the measured numbers with
          // headroom. (Path count is the weakest of the three — we emit one
          // compound path per colour layer, so it is bounded by `colorCount` —
          // which is why sub-paths and bytes carry the real bar.)
          maxPathRatio: 0.3,
          maxSubPathRatio: 0.5,
          maxBytesRatio: 0.8,
          maxTinySubPathRatio: 0.02,
          // Anchored on the exemplar's own 0.671: runs of h/v/l are a staircase
          // however few <path> elements they hide in. Ours is 1.000.
          minCurveCommandRatio: 0.65,
          // The real product ships two near-duplicate pairs on this artwork
          // (10.9 and 8.0 RGB units apart). We ship none, and that is the bar:
          // layers that close are one region split into a patchwork, not two
          // colours a user asked for.
          maxNearDuplicateFills: 0,
          maxMs: 10000,
        },
        note:
          'Gold-standard exemplar (REFERENCE "blind A/B"). Judged at the settings the captured ' +
          'output was actually produced at — Clipart / 8 colours / Smart anti-aliasing / Enhance ' +
          'on / Minimum Area 5px², recorded live in fixtures/reference/OBSERVED-UI.md. It anchors ' +
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
        exemplar: 'reference/fox-sticker-clipart-8colors-smartAA.svg',
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
         * There is no real-product capture of the flattened variant, so every
         * bar here is ABSOLUTE and measured on this build rather than a ratio
         * against something. The one that earns the row: the paw crop comes back
         * with 0.46 % of its pixels painted a colour the source crop does not
         * contain, where the transparent source scores 0.000 % — the flattened
         * ingest hands the quantizer a white plateau that the alpha path never
         * shows it, and a slot goes to the wrong family.
         */
        id: 'reference-fox-white',
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
          'alpha. Absolute bars only — there is no real-product capture of the flattened variant ' +
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
         * one tick — Enhance off — because the real product's own capture was
         * taken at Clipart / 8 colours / Smart AA / min-area 5, which is what
         * `DEFAULT_SETTINGS` already ships. So this row does double duty: it is
         * both "the configuration a user gets" and "the ENHANCE-OFF economy
         * measurement", and it carries the exemplar-relative economy bars for
         * that reason. If `DEFAULT_SETTINGS` ever moves, this row moves with it
         * and `reference-fox` does not — which is exactly the drift worth
         * catching.
         */
        id: 'reference-fox-default',
        file: 'reference/fox-sticker.png',
        kind: 'clipart',
        format: 'png',
        width: 1024,
        height: 1024,
        supported: true,
        distinctColors: null,
        exemplar: 'reference/fox-sticker-clipart-8colors-smartAA.svg',
        salientRegions: [
          {
            name: 'face',
            x: 340,
            y: 350,
            width: 380,
            height: 200,
            // The real product's own capture scores 4.75 on this exact crop and
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
            // an answer. Both the real product and our default score 0.000 %.
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
          // Worst crop, which is the muzzle at 10.91 against the real product's
          // 4.36 — the mouth arcs and the whisker curls are thin dark line art
          // over white, and every pixel of outline we paint fatter than the
          // source is mean colour error against an antialiased edge.
          maxRegionMeanColorError: 12,
          // The real product keeps this crop's outlines at 0.957 strict ink
          // recall; ours is 0.848. Held as both an absolute floor and a ratio,
          // because the absolute one alone would let the exemplar improve out
          // from under us.
          minRegionStrictInkRecall: 0.82,
          minRegionStrictInkRecallRatio: 0.86,
          // 8 requested, 6 found in the image, 5 delivered.
          maxPaletteShortfall: 1,
          meanColorError: 3,
          ssim: 0.95,
          minInkRecall: 0.95,
          // Enhance off costs stroke evenness, which is the honest reading of
          // what the bundle buys: 1.97x the exemplar's cv on the muzzle against
          // 1.64x with Enhance on.
          maxStrokeWidthCvRatio: 2.2,
          maxStrokeWidthOverExemplar: 1.25,
          // ECONOMY at the default quality settings, which no other row covers
          // now: 0.50x the exemplar's bytes and 0.32x its sub-paths. Looser than
          // `reference-fox` on purpose (Enhance is what buys the last of it) and
          // still far tighter than REFERENCE's 3x/5x product floor.
          maxBytesRatio: 0.9,
          maxSubPathRatio: 0.7,
          maxPathRatio: 0.3,
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
        id: 'unsupported-gif',
        file: 'unsupported-animation.gif',
        kind: 'unsupported',
        format: 'gif',
        supported: false,
        note: 'Must be rejected with a clear message (REFERENCE A2).',
      },
      {
        id: 'unsupported-txt',
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
