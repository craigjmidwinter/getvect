/**
 * FLAT MARKS KEEP THEIR GEOMETRY: spikes, corners, shards, keylines, straight edges.
 *
 * The reports: a 219x168 three-colour logo (a flame with spikes, a one-pixel white
 * keyline between two colours, small detached shards) came back from the default
 * Clipart settings as a smooth blob, and then the same logo exported at 542px with
 * a transparent background and a white sticker outline failed the same way.
 *
 * Two causes, found in this order, and each has its own test below:
 *
 * 1. SIZE. Every cleanup between the pixels and the tracer is defined in whole
 *    source pixels, so on a small input a feature one or two pixels wide cannot be
 *    told from the noise those passes remove. Turning smoothing, despeckle and
 *    detail all the way to "keep everything" did not bring the spikes back; tracing
 *    a 2x copy did. See `supersampleFactorFor` in src/engine/preprocess.ts.
 *
 * 2. THE INDEX-LEVEL PASSES SMART ANTI-ALIASING ADDS. The 3x3 majority votes and
 *    the seam regularizer round real geometry at ANY size: on fixtures/spikes-bands-384
 *    (384px, no supersampling involved) a straight-edged triangle comes back as a
 *    bowed arch with rounded corners, and either pass alone does it. With both off
 *    it comes back straight and sharp. They are skipped for flat marks (few shapes)
 *    and kept for busy art, where they earn their keep (`isFlatArt`).
 *
 * The fixtures are synthetic (scripts/generate-fixtures.mjs `drawComet`, and the
 * spikes fixture); nothing here is traced from anyone's artwork. Measured at the
 * defaults, original engine -> now:
 *
 *   comet 219x168        mean error vs source   4.45 -> 1.81
 *                        pixels off by > 60     2.97% -> 0.93%
 *                        keyline pixels kept    0.18 -> 0.70
 *                        navy edge vs source    0.63 -> 1.02
 *   spikes-bands-384     mean error             1.68 -> 1.01
 *                        navy edge vs source    0.74 -> 1.04
 *   comet sticker 542    mean error (on white)  3.61 -> 3.23
 *                        pixels off by > 60     2.09% -> 1.84%
 *                        cyan sawtooth length   0.92 -> 0.99
 *
 * Every bar sits between the two numbers, not at today's, and is red on the
 * original engine.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasIngest, decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';
import { rasterizeSvg } from '../../instruments/lib/render.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { vectorize } = require(join(root, 'dist/engine/index.js'));
const { supersampleFactorFor, isFlatArt, countRegions } = require(join(root, 'dist/engine/preprocess.js'));

const COMET = join(root, 'fixtures/comet-flame-219x168.png');
const STICKER = join(root, 'fixtures/comet-flame-sticker-542x416.png');
const SPIKES = join(root, 'fixtures/spikes-bands-384.png');

const isNavy = (c) => c[0] < 70 && c[1] < 120 && c[2] < 160;
const isCyan = (c) => c[0] < 80 && c[1] > 120 && c[2] > 170;
const isWhite = (c) => c[0] > 215 && c[1] > 215 && c[2] > 215;
const isLight = (c) => c[0] > 150 && c[1] > 190 && c[2] > 200;

/** The fixture as the app ingests it, and the same flattened on white (what resvg composites onto). */
async function load(file) {
  const source = canvasIngest(await decodeImageFile(file));
  return { source, flat: flattenOnWhite(source) };
}

async function render(svg, source) {
  return (await rasterizeSvg(svg, source.width, source.height)).image;
}

function pixelOf(img) {
  const { width: W, data } = img;
  return (x, y) => {
    const i = (y * W + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
}

/** Mean per-channel error and the share of pixels off by more than 60, source vs render. */
function errorOf(a, b) {
  let sum = 0;
  let bad = 0;
  const n = a.width * a.height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    sum += d;
    if (d > 60) bad++;
  }
  return { meanError: sum / n, badRatio: bad / n };
}

/** Pixels of one colour class that touch something else: the length of that colour's edge. */
function edgeLength(img, isColor) {
  const at = pixelOf(img);
  const { width: W, height: H } = img;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!isColor(at(x, y))) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !isColor(at(x + dx, y + dy)))) n++;
    }
  }
  return n;
}

/** Navy edge that borders paper: long and jagged where spikes survive, short where they are rounded off. */
function navyPaperEdge(img) {
  const at = pixelOf(img);
  const { width: W, height: H } = img;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!isNavy(at(x, y))) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isWhite(at(x + dx, y + dy)))) n++;
    }
  }
  return n;
}

test('a small flat logo keeps its spikes, shards and keyline at the defaults', async () => {
  const { source, flat } = await load(COMET);
  const result = await vectorize(source, {});
  const out = await render(result.svg, source);
  const e = errorOf(flat, out);

  // The keyline is the thin light gap with cyan on one side and navy on the other,
  // not the paper, which has neither within two pixels.
  const at = pixelOf(flat);
  const near = (x, y, r, pred) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < flat.width && yy < flat.height && pred(at(xx, yy))) return true;
      }
    }
    return false;
  };
  const outAt = pixelOf(out);
  let keyline = 0;
  let kept = 0;
  for (let y = 0; y < flat.height; y++) {
    for (let x = 0; x < flat.width; x++) {
      if (!isLight(at(x, y)) || !near(x, y, 2, isCyan) || !near(x, y, 2, isNavy)) continue;
      keyline++;
      if (isLight(outAt(x, y))) kept++;
    }
  }

  assert.ok(keyline > 300, `the fixture lost its keyline (${keyline} px) — regenerate it`);
  assert.ok(e.meanError <= 2.6, `mean colour error ${e.meanError.toFixed(2)} > 2.6 (4.45 before the fix, 1.81 after)`);
  assert.ok(e.badRatio <= 0.015, `${(e.badRatio * 100).toFixed(2)}% of pixels are badly wrong (2.97% before, 0.93% after)`);
  assert.ok(kept / keyline >= 0.5, `only ${((100 * kept) / keyline).toFixed(0)}% of the white keyline survived (18% before, 70% after)`);
  const ratio = navyPaperEdge(out) / navyPaperEdge(flat);
  assert.ok(ratio >= 0.85, `the navy outline's edge is ${(ratio * 100).toFixed(0)}% of the source's: the spikes have rounded off (63% before, 102% after)`);
  assert.ok(ratio <= 1.3, `the navy outline's edge is ${(ratio * 100).toFixed(0)}% of the source's: the trace has gone ragged`);
});

test('the same mark at 542px on a transparent background keeps its sawtooth and its outline', async () => {
  const { source, flat } = await load(STICKER);
  const result = await vectorize(source, {});
  const out = await render(result.svg, source);
  const e = errorOf(flat, out);
  const ratio = edgeLength(out, isCyan) / edgeLength(flat, isCyan);

  assert.ok(e.meanError <= 3.45, `mean colour error ${e.meanError.toFixed(2)} > 3.45 (3.61 before the fix, 3.23 after)`);
  assert.ok(e.badRatio <= 0.0195, `${(e.badRatio * 100).toFixed(2)}% of pixels are badly wrong (2.09% before, 1.84% after)`);
  assert.ok(
    ratio >= 0.96,
    `the cyan wedge's edge is ${(ratio * 100).toFixed(1)}% of the source's: its sawtooth has been smoothed into a wave (92.4% before, 98.6% after)`,
  );
  // A transparent source must not come back with an invented backdrop: the corner is paper.
  assert.ok(!/<rect/.test(result.svg.replace(/<g fill="[^"]*"><rect[^>]*\/><\/g>/, '')), 'unexpected extra rect');
  const outAt = pixelOf(out);
  assert.ok(isWhite(outAt(2, 2)) && isWhite(outAt(source.width - 3, source.height - 3)), 'the see-through corners did not stay paper');
});

test('straight-edged shapes stay straight and sharp (the cause was the index passes, not the size)', async () => {
  const { source, flat } = await load(SPIKES);
  const result = await vectorize(source, {});
  const out = await render(result.svg, source);
  const e = errorOf(flat, out);
  const ratio = navyPaperEdge(out) / navyPaperEdge(flat);

  assert.ok(e.meanError <= 1.35, `mean colour error ${e.meanError.toFixed(2)} > 1.35 (1.68 before the fix, 1.01 after)`);
  assert.ok(
    ratio >= 0.9,
    `the outlines' edge is ${(ratio * 100).toFixed(0)}% of the source's: the triangles have bowed into arches (74% before, 104% after)`,
  );
});

test('the flat-art rule counts shapes, in source pixels, and leaves busy art alone', () => {
  const W = 200;
  const H = 200;
  const TRANSPARENT = 255;
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
  ];
  /** A source whose every pixel IS its palette colour: the best case for a flat mark. */
  const onPalette = (indices, w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const c = palette[indices[p]];
      data.set([c.r, c.g, c.b, 255], p * 4);
    }
    return { width: w, height: h, data };
  };

  // Ten big bands: a flat mark.
  const bands = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) bands[p] = Math.floor((p % W) / 20) % 2;
  assert.equal(countRegions(bands, W, H, 16, TRANSPARENT), 10);
  assert.equal(isFlatArt(bands, onPalette(bands, W, H), palette, 1, TRANSPARENT), true);

  // The same ten bands, but the pixels are a smooth ramp that the quantizer folded
  // into them: few shapes, yet nothing sits on its palette colour. That is a
  // gradient, not a mark, and Smart anti-aliasing has to keep doing its job on it
  // (the B4 contract found this out: smart and off came back byte-identical).
  const ramp = onPalette(bands, W, H);
  for (let p = 0; p < W * H; p++) {
    const v = Math.round(((p % W) * 255) / (W - 1));
    ramp.data.set([v, v, v, 255], p * 4);
  }
  assert.equal(isFlatArt(bands, ramp, palette, 1, TRANSPARENT), false, 'a quantized gradient is not a flat mark');

  // A grid of 400 ten-by-ten-pixel cells in a checkerboard: far past the shape limit.
  const checks = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) checks[y * W + x] = (Math.floor(x / 10) + Math.floor(y / 10)) % 2;
  assert.equal(isFlatArt(checks, onPalette(checks, W, H), palette, 1, TRANSPARENT), false, '400 shapes of 100px must not count as a flat mark');

  // Debris is not shapes: one-pixel specks on a flat field do not make it busy.
  const specked = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p += 7) specked[p] = 1;
  assert.equal(isFlatArt(specked, onPalette(specked, W, H), palette, 1, TRANSPARENT), true, 'one-pixel specks are debris, not shapes');

  // The same checkerboard seen through a 2x working copy has 4x the pixels per cell:
  // the threshold must follow, or a mark counts as busier the larger its working copy is.
  const big = new Uint8Array(W * 2 * H * 2);
  for (let y = 0; y < H * 2; y++) for (let x = 0; x < W * 2; x++) big[y * W * 2 + x] = checks[Math.floor(y / 2) * W + Math.floor(x / 2)];
  assert.equal(countRegions(big, W * 2, H * 2, 16, TRANSPARENT), 400);
  assert.equal(countRegions(big, W * 2, H * 2, 16 * 4, TRANSPARENT), 400, 'cells are 400px at 2x, above the scaled threshold');
});

test('Smart anti-aliasing still does something on a gradient (it is not mistaken for a flat mark)', async () => {
  // The e2e B4 contract found this: a quantized gradient has few shapes, so counting
  // shapes alone called it flat, the index passes were skipped, and Smart came back
  // byte-identical to Off. Found only by the 10-minute browser suite; this is the
  // same check in a second.
  const { source } = await load(join(root, 'fixtures/photo-gradient-512x384.jpg'));
  const smart = await vectorize(source, { antiAliasing: 'smart' });
  const off = await vectorize(source, { antiAliasing: 'off' });
  assert.notEqual(smart.svg, off.svg, 'Smart anti-aliasing changed nothing on a gradient');
});

test('circle detection still finds the rings of a small flat logo on its 2x working copy', async () => {
  // The e2e B5 contract found this: the two rings were detected, but "concentric"
  // was a one-pixel test in working pixels, and on a 2x copy the centres of a
  // perfect ring are a working pixel apart, so the annulus never became a circle.
  const { source } = await load(join(root, 'fixtures/shapes-256.bmp'));
  const on = await vectorize(source, { circleDetection: true });
  const off = await vectorize(source, { circleDetection: false });
  const circles = (on.svg.match(/<(circle|ellipse)\b/g) ?? []).length;
  assert.ok(circles > 0, 'circle detection found no circle on a logo drawn from discs');
  assert.equal((off.svg.match(/<(circle|ellipse)\b/g) ?? []).length, 0);
});

test('supersampling is an internal detail: the document stays in source units and stays deterministic', async () => {
  const { source } = await load(COMET);
  const a = await vectorize(source, {});
  const b = await vectorize(source, {});

  assert.equal(a.svg, b.svg, 'same image + same settings must be byte-identical');
  assert.equal(a.width, source.width);
  assert.equal(a.height, source.height);
  assert.match(a.svg, new RegExp(`width="${source.width}" height="${source.height}" viewBox="0 0 ${source.width} ${source.height}"`));

  // Nothing may be drawn outside the canvas the user supplied: a 2x working copy
  // scaled back wrongly would land everything at twice (or half) the size.
  const nums = [...a.svg.matchAll(/ d="([^"]*)"/g)].flatMap((m) => m[1].match(/-?\d+(?:\.\d+)?/g) ?? []);
  assert.ok(nums.length > 0);
  assert.ok(Math.max(...nums.map(Number)) < source.width * 1.5, 'path data is not in source units');
});

test('only small inputs are supersampled, so larger images are untouched', () => {
  assert.equal(supersampleFactorFor(219, 168), 2);
  assert.equal(supersampleFactorFor(319, 100), 2);
  assert.equal(supersampleFactorFor(320, 100), 1);
  assert.equal(supersampleFactorFor(542, 416), 1);
  assert.equal(supersampleFactorFor(1024, 1024), 1);
});
