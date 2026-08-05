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
        // generated — it is real artwork plus the SVG the reference product actually
        // produced for it, checked into fixtures/reference/. Thresholds are
        // derived from the exemplar rather than invented: <= 3x its path and
        // sub-path counts, <= 5x its bytes, comparable rasterized fidelity.
        id: 'reference-snorlax',
        file: 'reference/snorlax.png',
        kind: 'clipart',
        format: 'png',
        width: 1046,
        height: 833,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 16, enhance: true },
        exemplar: 'reference/snorlax.svg',
        // Two crops, because one was not enough. The FACE is where line art is
        // lost (both eyes, both fangs, the mouth curve — 8 % of the canvas and
        // all of the meaning). The PAW PAD is where a whole colour family is
        // lost: its source colour is rgb(164,143,125), a warm brown, and the
        // pre-trace ramp snapper collapses it onto its neighbours' extremes so
        // it comes back a light teal. Region gates read the worst crop.
        salientRegions: [
          { name: 'face', x: 300, y: 200, width: 360, height: 200 },
          // The muzzle, with its own leak bar — this configuration is the one
          // that gets it RIGHT (0.000 % foreign colour, same as the exemplar),
          // while the default configuration paints teal into the fangs. Pinned
          // here so the fix for `reference-snorlax-default` has to be a fix and
          // not a redistribution.
          {
            name: 'muzzle',
            x: 420,
            y: 290,
            width: 220,
            height: 90,
            thresholds: { maxForeignColorRatio: 0.0005 },
          },
          { name: 'paw-pad', x: 60, y: 670, width: 110, height: 80 },
        ],
        thresholds: {
          meanColorError: 7,
          ssim: 0.9,
          minInkRecall: 0.94,
          // Continuity against the real product, in the crop where we are
          // worst relative to it. Loosely (`inkRecall`, luma < 128 counts as
          // kept) our paw outline scores 0.978 to the exemplar's 1.000 and
          // `regionInkRecallRatio` reads 1.08x — the metric said we beat the
          // real product on the picture where a critic could see the contour
          // was dashed. Strictly (ink must come back as ink) the same crop
          // reads 0.943x of the exemplar.
          minRegionStrictInkRecallRatio: 0.98,
          // Boundary raggedness: our mid-tone layers sawtooth through the
          // shading where the exemplar sweeps. Ours 3.35 mean vs its 2.67 —
          // 1.25x, i.e. passing a 1.3 bar by four hundredths while a designer
          // looking at artifacts/raster/reference-snorlax.png beside the
          // exemplar still sees our belly seam wobble where theirs is one arc
          // (and our paw pad split along a hard diagonal where theirs is a
          // clean ellipse). A gate that a visible difference passes is a gate
          // set in the wrong place: 1.1 is "the same class of edge", which is
          // what REFERENCE's blind A/B actually asks for.
          maxLayerCompactnessRatio: 1.1,
          // The same defect, measured locally instead of globally. Compactness
          // is perimeter over area for a whole layer, so an intricate-but-clean
          // shape and a smooth-looking shape traced onto a noisy threshold can
          // score alike; `layerWobble` (metrics.mjs `layerBoundaryWobble`) walks
          // both boundaries at the same step and measures how much the heading
          // changes per unit travelled. The lap-6 critique measured this by hand
          // on the raster — "43 % more perimeter for the same region" over the
          // paw box — while `curveCommandRatio` read 0.872 and reported health,
          // because our commands ARE curves: they are fitted to a wobble the
          // real product never had. Ours 55.4 against the exemplar's 37.2
          // (1.49x); 1.15 is "the same class of edge".
          maxLayerWobbleRatio: 1.15,
          // Stroke-width UNIFORMITY against the real product's, in the crop
          // where we are worst (metrics.mjs `strokeWidthProfile`). This is the
          // thing REFERENCE's blind A/B is actually decided on and the thing
          // every other ink metric in this repo reads BACKWARDS: a line that
          // thickens, thins and breaks recalls more ink and joins more
          // components than an even one, so `regionStrictInkRecall` scored us
          // 0.967 against the exemplar's 0.755 and `inkComponentRatio` 0.43x
          // for a mouth arc that tapered to a spindle and detached from both
          // fangs.
          //
          // These two bars are RATCHETS, not parity — say so plainly. The real
          // product's paw outline is nearly twice as even as ours (cv 0.176
          // against our 0.340) and the number to aim at is 1.15x, which is the
          // bar the lap-7 critique named. What these hold is that the numbers
          // measured today (1.93x uniformity, 1.18x fattening, down from 1.22x
          // before the ink layers were unified) cannot quietly get worse while
          // every other gate stays green — which is exactly how the defect
          // survived seven laps.
          maxStrokeWidthCvRatio: 2,
          // ...and how much fatter our line is than the real product's trace of
          // the same line. Measured by hand on the lower jaw the lap-7 critique
          // had us at 1.76x the source's width against the exemplar's 1.44x;
          // it is 1.51x now.
          maxStrokeWidthOverExemplar: 1.25,
          // B3: 16 requested, 16 found in the image, 8 delivered.
          //
          // The bar is 8, not 1, because the exemplar settles it: the SVG
          // the reference product produced for this artwork at the same ~16-colour
          // setting carries exactly EIGHT `<g fill>` layers. A shortfall of 8
          // is therefore parity with the real product, and a bar of 1 demanded
          // fifteen layers on a picture whose gold-standard rendering has
          // eight — while `maxNearDuplicateFills: 0` below simultaneously
          // forbids shipping the near-duplicate creams that a 15-layer palette
          // would have to be made of. Anything ABOVE 8 is still a failure: that
          // is our folds losing a colour family the real product kept.
          maxPaletteShortfall: 8,
          // Same image, Enhance off + Smart AA, scores 0.965 here, so this is
          // not a bar the tracer cannot reach — it is the bar the Enhance
          // bundle currently fails while every global gate passes.
          minRegionInkRecall: 0.93,
          // Now that an exemplar is rasterized from its content box instead of
          // its declared viewBox (docs/HARNESS.md), the fidelity half of the
          // A/B is a real number: the exemplar scores MAE 13.50 here, so "no
          // worse than the real product" is a bar rather than a formality.
          maxMeanColorErrorRatio: 1,
          // D3: the DXF has to carry the curve fitting the SVG paid for.
          minDxfSplines: 1,
          maxDxfEpsBytesRatio: 3,
          // 32.5% of this artwork is transparent. The real product's output for
          // it has a white/transparent background; painting it opaque is the
          // blocker this gate names.
          maxTransparentAreaColorError: 8,
          maxPathRatio: 3,
          maxSubPathRatio: 3,
          maxBytesRatio: 5,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          // The exemplar's own eight layers are never closer than 37 RGB units
          // apart. Ours emits pairs at 26.6 and 27.0 — the mottled two-cream
          // patchwork across the belly — which the old 24-unit window could not
          // see and a budget of 4 would have forgiven anyway.
          maxNearDuplicateFills: 0,
          maxMs: 10000,
        },
        note:
          'Gold-standard exemplar (REFERENCE "blind A/B"). Judged at 16 colours + enhance, ' +
          'the settings the captured output corresponds to (fixtures/reference/OBSERVED-UI.md ' +
          'records Smart anti-aliasing and Enhance on; our Enhance bundles that same cleanup). ' +
          'It anchors ECONOMY (paths/sub-paths/bytes/curve ratio); fidelity is gated absolutely ' +
          'here and relatively in reference-snorlax-6c.',
      },
      {
        // The configuration a user actually gets. Every exemplar gate above
        // runs at `enhance: true`, because that is the setting the captured
        // output corresponds to — which left the DEFAULT (Enhance off) path
        // completely ungated, and it is 13x the exemplar's bytes and 27x its
        // sub-paths: 405 KB and 1747 shapes against 31 KB and 65. The limits
        // here are deliberately looser than the enhance-on ones and still far
        // inside what the engine has been measured doing: the same fixture with
        // Smart anti-aliasing alone lands at 5.3x bytes / 9.3x sub-paths, so
        // this is a bar an honest default reaches without the Enhance bundle.
        id: 'reference-snorlax-noenhance',
        file: 'reference/snorlax.png',
        kind: 'clipart',
        format: 'png',
        width: 1046,
        height: 833,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 16, enhance: false },
        exemplar: 'reference/snorlax.svg',
        salientRegions: [
          { name: 'face', x: 300, y: 200, width: 360, height: 200 },
          { name: 'paw-pad', x: 60, y: 670, width: 110, height: 80 },
        ],
        thresholds: {
          meanColorError: 7,
          ssim: 0.9,
          minInkRecall: 0.92,
          minRegionInkRecall: 0.9,
          // The same 16-colour request delivers 10 here and 8 with Enhance on,
          // and no UI surface explains the difference. Pinned at what this
          // configuration reaches today so the two numbers cannot drift further
          // apart unnoticed while `reference-snorlax-16c-nomerge` argues for
          // closing the gap from the other side.
          maxPaletteShortfall: 6,
          maxMeanColorErrorRatio: 1,
          maxTransparentAreaColorError: 8,
          maxBytesRatio: 8,
          maxSubPathRatio: 12,
          maxPathRatio: 3,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxMs: 10000,
        },
        note:
          'REFERENCE economy at the DEFAULT quality settings (Enhance off), which no other ' +
          'exemplar gate covers. Looser ratios than reference-snorlax on purpose — the point ' +
          'is that the out-of-the-box configuration is measured at all, not that it matches a ' +
          'run with every cleanup on.',
      },
      {
        /**
         * B3: is the colour fold something the user can undo?
         *
         * `reference-snorlax` asks for 16 colours, the image has 16, and 8 come
         * back — which the exemplar justifies (its own capture of this artwork
         * has eight `<g fill>` layers) but the UI does not: the shortfall is
         * attributed to "the cleanup settings" and no cleanup setting reverses
         * it. `src/engine/index.ts` computes
         * `groupThreshold = max(opts.mergeThreshold, opts.enhance ? 1 : 0)`, so
         * with Enhance on the merge-threshold control cannot go below 1 % and
         * the sub-1 % fold is unreachable from the panel. The customer who
         * clicks the 16 radio, then drags MERGE THRESHOLD to 0 to get them
         * back, gets the same eight colours and no explanation.
         *
         * Same source, same 16-colour request, Enhance on — and the fold
         * explicitly turned off. The bar is not "16 delivered": it is that
         * turning the control off reaches at least what turning ENHANCE off
         * already reaches (10 delivered, `reference-snorlax-noenhance`, with
         * `nearDuplicateFillPairs` still 0), which is evidence from this repo's
         * own runs rather than an invented number. Today it delivers 8, exactly
         * as if the control were not there.
         */
        id: 'reference-snorlax-16c-nomerge',
        file: 'reference/snorlax.png',
        kind: 'clipart',
        format: 'png',
        width: 1046,
        height: 833,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 16, enhance: true, mergeThreshold: 0 },
        exemplar: 'reference/snorlax.svg',
        salientRegions: [{ name: 'muzzle', x: 420, y: 290, width: 220, height: 90 }],
        thresholds: {
          // The point of the row.
          maxPaletteShortfall: 6,
          // ...and the guard that stops it being bought with near-identical
          // creams: extra colours have to be extra COLOURS. Enhance off already
          // ships 10 of them on this image with zero pairs inside the halo
          // window, so both halves of this row are jointly reachable.
          maxNearDuplicateFills: 0,
          // Undoing a cleanup must not undo the picture: the fidelity and
          // economy bars are the ones `reference-snorlax` holds, minus the
          // exemplar-relative economy (more colour layers legitimately cost
          // more sub-paths, and that trade is what the user asked for).
          meanColorError: 7,
          ssim: 0.9,
          minInkRecall: 0.94,
          maxTransparentAreaColorError: 8,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxMs: 10000,
        },
        note:
          'B3 reversibility: 16 colours + Enhance with the output-groups merge threshold ' +
          'explicitly at 0. The fold that costs eight colours must be reachable by the control ' +
          'the panel already shows (`merge-threshold`), or the shortfall the hint blames on ' +
          '"the cleanup settings" is not a setting.',
      },
      {
        // The DOM-extracted Clipart / 6-colour / Minimum Area 90px² output is
        // the tightest fidelity comparison available: same source, same colour
        // budget, and the real product scores MAE ~18 on it. Ours must be in
        // the same class rather than losing the black outline into dark teal.
        id: 'reference-snorlax-6c',
        file: 'reference/snorlax.png',
        kind: 'clipart',
        format: 'png',
        width: 1046,
        height: 833,
        supported: true,
        distinctColors: null,
        settings: { colorCount: 6, enhance: true },
        exemplar: 'reference/snorlax-clipart-6colors-min90.svg',
        // The 6-colour run is where the missing colour family is most visible:
        // the real product's 6 colours include a tan, rgb(141,128,114), and it
        // paints the paw pad with it (region MAE 21.9). Ours paints the same
        // pad in blue.
        salientRegions: [{ name: 'paw-pad', x: 60, y: 670, width: 110, height: 80 }],
        thresholds: {
          maxMeanColorErrorRatio: 1.5,
          minInkRecall: 0.94,
          // The exemplar itself scores 21.89 in this crop at six colours, so
          // this is "no worse than the real product, plus a little", not an
          // invented bar. Ours scores 34.18: a warm brown rendered light teal.
          maxRegionMeanColorError: 24,
          maxPaletteShortfall: 1,
          maxTransparentAreaColorError: 8,
          maxPathRatio: 3,
          maxSubPathRatio: 3,
          maxBytesRatio: 5,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxMs: 10000,
        },
        note:
          'Blind A/B against real Clipart 6-colour output (93 paths, 91KB, curve ratio 0.64). ' +
          'Carries the paw-pad crop because the 6-colour palette failure is most visible there.',
      },
      {
        // The settings a user actually gets. Every other gold-standard row pins
        // something: 16 colours + Enhance, 16 colours, 6 colours + Enhance — so
        // DEFAULT_SETTINGS on real artwork was never measured, and that is
        // exactly where the anti-aliasing ramp snapper destroys the paw pad's
        // colour family (palette [cream, blue, grey-cream, blue, blue, near
        // black]: three blues and no brown, pad MAE 33.5 with the pad rendered
        // rgb(103,150,167) against a source rgb(164,143,125)). No `settings`
        // key at all is the point of the row: whatever DEFAULT_SETTINGS says
        // today is what gets measured.
        id: 'reference-snorlax-default',
        file: 'reference/snorlax.png',
        kind: 'clipart',
        format: 'png',
        width: 1046,
        height: 833,
        supported: true,
        distinctColors: null,
        // Report-only (no ratio gates on this row): it is what makes the stdout
        // print the real product's own score for each crop beside ours at the
        // default settings, which is where the face bar below comes from.
        exemplar: 'reference/snorlax.svg',
        salientRegions: [
          /**
           * The face, at the settings a user gets.
           *
           * It was declared on all three *pinned* rows and on none of the
           * default one, so the crop that decides REFERENCE's blind A/B was
           * unmeasured at exactly the configuration the app opens with — and
           * the default output paints 123 teal pixels inside the mouth/fang box
           * (x 420..640, y 290..380) where the source has none, while the row
           * still reported pass. Its own gates, because the paw-pad bar below
           * is deliberately looser (see there) and the aggregate reads the
           * worst crop.
           */
          {
            name: 'face',
            x: 300,
            y: 200,
            width: 360,
            height: 200,
            thresholds: {
              // The real product's own 16-colour output scores 19.13 here.
              maxMeanColorError: 19.13,
            },
          },
          /**
           * The mouth and both fangs, on their own.
           *
           * The face box above cannot ask this question: the head's own outline
           * is a dark teal, so teal is a colour the *face crop* legitimately
           * contains and 123 stray teal pixels inside the cream muzzle are not
           * foreign to it. Cropped to the muzzle the source has no teal at all,
           * and the leak is unmissable — measured on this build: default 0.50 %
           * of the crop painted rgb(38,90,108) (palette slot #265a6c) against
           * 0.000 % for our own 16-colour + Enhance run and 0.000 % for the real
           * the reference product exemplar. MAE is not gated here (the exemplar scores
           * 25.13 to our 13.64 — it paints a fatter outline); the leak is.
           */
          {
            name: 'muzzle',
            x: 420,
            y: 290,
            width: 220,
            height: 90,
            thresholds: { maxForeignColorRatio: 0.0005 },
          },
          {
            name: 'paw-pad',
            x: 60,
            y: 670,
            width: 110,
            height: 80,
            // The same slot leaking into the same place: 0.38 % of this crop is
            // that dark teal, where both real exemplars score 0.000 %. Region
            // MAE alone stopped seeing it once the pad's *average* colour came
            // back close enough; a hue that is not in the picture is still a
            // hue that is not in the picture.
            thresholds: { maxForeignColorRatio: 0.0005 },
          },
        ],
        thresholds: {
          // Anchored on the exemplars, not invented. The real product's own
          // 16-colour output scores 14.46 on this exact crop and its 6-colour
          // output scores 21.89, so a bar of 12 asked our EIGHT-colour default
          // to beat the gold standard's sixteen — on the one crop where the
          // dominant error is the outline, which the real product deliberately
          // paints FATTER than the source (2496 ink pixels in the paw box where
          // the source has 1210). It was therefore in direct opposition to
          // `minRegionStrictInkRecall` below: every pixel of solid outline this
          // row demands is a pixel of mean colour error against an antialiased
          // source. 22 keeps the honest statement — our default must not paint
          // this crop worse than the real product's *six*-colour output does.
          maxRegionMeanColorError: 22,
          // Both real exemplars keep this crop's outlines at >= 0.983 strict
          // ink recall. Ours is 0.904: the pad ellipse and the paw contour come
          // back thinner than the pixel run they were traced from.
          minRegionStrictInkRecall: 0.94,
          // 8 requested, 8 found in the image, 6 delivered.
          maxPaletteShortfall: 1,
          minInkRecall: 0.94,
          maxTransparentAreaColorError: 8,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxMs: 10000,
        },
        note:
          'DEFAULT_SETTINGS on the gold-standard artwork — deliberately no `settings` override. ' +
          'The other three reference rows all pin a configuration, which left the one a user ' +
          'gets out of the box unmeasured while its default output had a hue-inverted region.',
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
