/**
 * Rendered-output tests — `npm run test:engine`.
 *
 * Everything here answers a question you cannot answer by comparing SVG
 * strings: does the *picture* change, is the outline actually curve-fitted, and
 * is the drawing economical in shapes rather than in `<path>` elements.
 *
 * These are the checks the critics had to perform by hand (rasterize, crop,
 * eyeball) turned into numbers. The heavier per-fixture versions live in
 * `npm run instruments`; these are the fast contract-level ones.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Resvg } from '@resvg/resvg-js';

import { decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';
import {
  countCubics,
  countSubPaths,
  curveCommandRatio,
  inkRecall,
  meanColorError,
  perColorCoverageDelta,
  pixelMismatchRatio,
  svgStructure,
  tinySubPathRatio,
} from '../../instruments/lib/metrics.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const engine = require(join(root, 'dist/engine/index.js'));
const fixture = (name) => join(root, 'fixtures', name);

const load = async (name) => flattenOnWhite(await decodeImageFile(fixture(name)));
const S = engine.DEFAULT_SETTINGS;

const flat = await load('logo-flat-512.png');
const noisy = await load('logo-noisy-512.png');
const photo = await load('photo-gradient-512x384.jpg');
const artwork = await load('reference/artwork.png');

/** Rasterize an SVG at the given size into the engine's RasterImage shape. */
function render(svg, width, height) {
  const { pixels } = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'white',
    font: { loadSystemFonts: false },
  }).render();
  return { width, height, data: new Uint8ClampedArray(pixels) };
}

const renderResult = (r) => render(r.svg, r.width, r.height);

test('[B2] every slider changes the rendered picture, not just the bytes', async () => {
  // A geometry change that no pixel can see is not "observably changes output".
  const cases = [
    ['colorCount', 8, 3],
    ['detail', 60, 5],
    ['smoothing', 0, 100],
    ['despeckle', 0, 90],
  ];
  for (const [key, from, to] of cases) {
    const a = await engine.vectorize(noisy, { ...S, [key]: from });
    const b = await engine.vectorize(noisy, { ...S, [key]: to });
    const mismatch = pixelMismatchRatio(renderResult(a), renderResult(b));
    assert.ok(
      mismatch > 0.01,
      `${key} ${from} -> ${to} moved only ${(mismatch * 100).toFixed(2)}% of pixels ` +
        `(SVG bytes ${a.svg.length} -> ${b.svg.length}) — the control is cosmetic`,
    );
  }
});

test('[B2] smoothing changes the shape of a curved boundary', async () => {
  // The photo fixture's boundaries are smooth analytic curves in the source, so
  // smoothing has something to fit; a lattice-locked tracer cannot move them.
  const sharp = await engine.vectorize(photo, { ...S, smoothing: 0 });
  const smooth = await engine.vectorize(photo, { ...S, smoothing: 100 });
  const mismatch = pixelMismatchRatio(renderResult(sharp), renderResult(smooth));
  assert.ok(
    mismatch > 0.01,
    `smoothing 0 -> 100 moved only ${(mismatch * 100).toFixed(2)}% of pixels`,
  );
  assert.ok(
    curveCommandRatio(smooth.svg) > curveCommandRatio(sharp.svg),
    'maximum smoothing must fit more curve than none',
  );

  // Hard-edged artwork is where smoothing has the most to do — a staircase to
  // remove — so the bar is higher there, and the removed staircase has to show
  // up as bytes that are no longer being spent on it.
  for (const [name, image] of [
    ['flat logo', flat],
    ['artwork', artwork],
  ]) {
    const a = await engine.vectorize(image, { ...S, smoothing: 0 });
    const b = await engine.vectorize(image, { ...S, smoothing: 100 });
    const moved = pixelMismatchRatio(renderResult(a), renderResult(b));
    assert.ok(
      moved > 0.015,
      `smoothing 0 -> 100 moved only ${(moved * 100).toFixed(2)}% of the ${name}'s pixels`,
    );
    assert.ok(
      b.svg.length < a.svg.length * 0.8,
      `smoothing the ${name} to 100 saved only ${a.svg.length - b.svg.length} bytes ` +
        `of ${a.svg.length} — the staircase is still being paid for`,
    );
  }
});

test('[quality] outlines are curve-fitted, not a pixel staircase', async () => {
  const r = await engine.vectorize(artwork, { ...S, colorCount: 16, enhance: true });
  const ratio = curveCommandRatio(r.svg);
  // fixtures/reference/artwork.svg (real the reference product output) scores 0.639.
  assert.ok(
    ratio >= 0.5,
    `curve command ratio ${ratio.toFixed(3)} — the exemplar scores 0.639; ` +
      'runs of h/v/l are a staircase however few <path> elements they hide in',
  );
  assert.ok(countCubics(r.svg) > 0, 'no cubic Bézier segments at all');
});

test('[quality] economy is measured in shapes, not in <path> elements', async () => {
  // One compound path per colour makes pathCount meaningless: count sub-paths.
  const r = await engine.vectorize(noisy, S);
  const ratio = tinySubPathRatio(r.svg);
  assert.ok(
    ratio < 0.1,
    `${(ratio * 100).toFixed(1)}% of sub-paths are 1x1 pixel specks at the default ` +
      'despeckle — REFERENCE Economy asks for shapes, "not thousands of specks"',
  );
  assert.ok(
    countSubPaths(r.svg) <= 1200,
    `${countSubPaths(r.svg)} sub-paths on the noisy fixture (limit 1200)`,
  );
});

test('[quality] flat artwork stays within a couple of hundred shapes', async () => {
  const r = await engine.vectorize(flat, S);
  const s = svgStructure(r.svg);
  assert.ok(s.subPathCount <= 200, `${s.subPathCount} sub-paths (limit 200)`);
  assert.ok(s.tinySubPathRatio < 0.02, `${s.tinySubPathRatio} of shapes are single pixels`);
});

test('[quality] thin dark features do not erode away', async () => {
  // The half-pixel inset from midpoint contour nodes thins hairlines; MAE and
  // SSIM average it away, per-colour area does not.
  const r = await engine.vectorize(flat, S);
  const delta = perColorCoverageDelta(flat, render(r.svg, r.width, r.height), r.palette);
  assert.ok(
    delta <= 0.01,
    `a palette colour's area moved by ${(delta * 100).toFixed(2)}% between source and trace`,
  );
});

test('[quality] the gold-standard exemplar is matched on economy and fidelity', async () => {
  // REFERENCE lines 73-83: same source, ~16 colours, "path count within ~3x of
  // the exemplar's (not thousands of specks), file size within ~5x".
  const exemplar = readFileSync(fixture('reference/artwork.svg'), 'utf8');
  const ex = svgStructure(exemplar);
  const r = await engine.vectorize(artwork, { ...S, colorCount: 16, enhance: true });
  const ours = svgStructure(r.svg);

  assert.ok(
    ours.subPathCount <= ex.subPathCount * 3,
    `${ours.subPathCount} shapes vs the exemplar's ${ex.subPathCount} (limit 3x)`,
  );
  assert.ok(
    ours.bytes <= ex.bytes * 5,
    `${ours.bytes} bytes vs the exemplar's ${ex.bytes} (limit 5x)`,
  );

  // ...and the rendering has to hold up next to it, at the source size.
  const mae = meanColorError(artwork, render(r.svg, r.width, r.height));
  assert.ok(mae < 20, `mean colour error ${mae.toFixed(2)} against the source`);
});

test('[quality] hairlines stay unbroken through the cleanup passes', async () => {
  /**
   * The cleanups (Enhance's canvas-proportional area floor, the despeckle
   * noise filter) judge a region by how many pixels it has, and a hairline has
   * almost none: the reference artwork's eyelids are 2px wide, so an area-only
   * test deleted them piece by piece and left dashes. MAE and SSIM barely
   * noticed — 0.3 % of the pixels — which is why this is measured separately.
   */
  const r = await engine.vectorize(artwork, { ...S, colorCount: 16, enhance: true });
  const recall = inkRecall(artwork, render(r.svg, r.width, r.height));
  assert.ok(
    recall >= 0.94,
    `only ${(recall * 100).toFixed(1)}% of the source's ink is still ink after tracing — ` +
      'the cleanup passes are eating line art',
  );

  // Enhance must not be the setting that costs you the linework: with every
  // cleanup off the trace is noisier but keeps everything, and Enhance has to
  // stay in the same class.
  const raw = await engine.vectorize(artwork, { ...S, colorCount: 16 });
  const rawRecall = inkRecall(artwork, render(raw.svg, raw.width, raw.height));
  assert.ok(
    recall >= rawRecall - 0.03,
    `enhance drops ink recall from ${rawRecall.toFixed(3)} to ${recall.toFixed(3)}`,
  );
});

test('[quality] the black outline survives a small colour budget', async () => {
  // At 6 colours the real product keeps artwork's black outline; a plain
  // coverage-ranked palette loses it into dark teal and the drawing falls apart.
  const r = await engine.vectorize(artwork, { ...S, colorCount: 6, enhance: true });
  const darkest = r.palette
    .map((c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b)
    .reduce((a, b) => Math.min(a, b), 255);
  assert.ok(
    darkest < 60,
    `the darkest of 6 palette entries has luma ${darkest.toFixed(0)} — the outline black is gone`,
  );
});
