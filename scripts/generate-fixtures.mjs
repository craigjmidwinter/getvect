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
        thresholds: {
          meanColorError: 14,
          ssim: 0.7,
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
        note: 'Same mark + seeded speckle. Exercises despeckle and the enhance toggle (B4).',
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
        thresholds: {
          meanColorError: 7,
          ssim: 0.9,
          minInkRecall: 0.94,
          maxPathRatio: 3,
          maxSubPathRatio: 3,
          maxBytesRatio: 5,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxNearDuplicateFills: 4,
          maxMs: 10000,
        },
        note:
          'Gold-standard exemplar (REFERENCE "blind A/B"). Judged at 16 colours + enhance, ' +
          'the setting the captured output corresponds to. snorlax.svg is a low-colour ' +
          'capture, so it anchors ECONOMY (paths/sub-paths/bytes/curve ratio); fidelity is ' +
          'gated absolutely here and relatively in reference-snorlax-6c.',
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
        thresholds: {
          maxMeanColorErrorRatio: 1.5,
          minInkRecall: 0.94,
          maxPathRatio: 3,
          maxSubPathRatio: 3,
          maxBytesRatio: 5,
          maxTinySubPathRatio: 0.02,
          minCurveCommandRatio: 0.5,
          maxMs: 10000,
        },
        note: 'Blind A/B against real Clipart 6-colour output (93 paths, 91KB, curve ratio 0.64).',
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
