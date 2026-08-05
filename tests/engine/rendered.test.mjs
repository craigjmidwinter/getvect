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

import { canvasIngest, decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';
import { rasterizeExemplarContent } from '../../instruments/lib/render.mjs';
import {
  countCubics,
  countSubPaths,
  cropRegion,
  curveCommandRatio,
  fillLayerChunks,
  foreignColorRatio,
  inkRecall,
  layerBoundaryWobble,
  layerCompactness,
  meanColorError,
  nearDuplicateFillPairs,
  perColorCoverageDelta,
  pixelMismatchRatio,
  strictInkRecall,
  svgStructure,
  tinySubPathRatio,
} from '../../instruments/lib/metrics.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const engine = require(join(root, 'dist/engine/index.js'));
const fixture = (name) => join(root, 'fixtures', name);

const load = async (name) => flattenOnWhite(await decodeImageFile(fixture(name)));
/**
 * ONE DECODE CONTRACT (docs/HARNESS.md). What the engine is handed is what the
 * renderer's canvas ingest produces — `(0,0,0,0)` for every transparent pixel —
 * while fidelity is judged against the same file flattened on white. The
 * gold-standard source is 76.5 % transparent, and the difference is not
 * cosmetic: the white-flattened variant of this same artwork
 * (`reference-fox-white`) paints 0.46 % of the paw a hue the source does not
 * contain where the alpha-preserving ingest paints 0.000 %. A contract measured
 * on pixels the product never sees is not a contract.
 */
const loadIngest = async (name) => canvasIngest(await decodeImageFile(fixture(name)));
const S = engine.DEFAULT_SETTINGS;

/**
 * Defaults with every optional cleanup off.
 *
 * `DEFAULT_SETTINGS` ships Smart anti-aliasing on (the real product does too —
 * fixtures/reference/OBSERVED-UI.md — and it is what keeps the default output
 * economical). Its index-image majority pass is also a very effective impulse
 * remover, so on the speckled fixture the noise-removal controls have nothing
 * left to remove and cannot be observed at all. Checks that ask "does THIS
 * control move the picture" isolate it here; checks about the shipped
 * configuration use `S`.
 */
const RAW = { ...S, antiAliasing: 'off' };

const flat = await load('logo-flat-512.png');
const noisy = await load('logo-noisy-512.png');
const photo = await load('photo-gradient-512x384.jpg');
/** Judged against (opaque). */
const fox = await load('reference/fox-sticker.png');
/** Handed to the engine (alpha preserved). */
const foxIn = await loadIngest('reference/fox-sticker.png');
/** The real the reference product output for that artwork — the blind-A/B exemplar. */
const FOX_EXEMPLAR = 'reference/fox-sticker-clipart-8colors-smartAA.svg';
/**
 * The settings the exemplar was captured at (fixtures/reference/OBSERVED-UI.md):
 * Clipart, 8 colours, Smart anti-aliasing, Minimum Area 5px², Enhance on. Every
 * A/B below runs at these, because comparing two different pictures is not an
 * A/B.
 */
const EXEMPLAR_SETTINGS = { colorCount: 8, antiAliasing: 'smart', minArea: 5, enhance: true };

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

/**
 * Rasterize an exemplar for pixel comparison.
 *
 * NOT `render()`: an exemplar is only registered against the source when the
 * real product wrote the source's own pixel dimensions into it, and captures
 * that declare a padded frame draw the artwork in a corner of it — rendering
 * such a file against its declared box puts the real product's paw where our
 * margin is, and every comparison then passes for the wrong reason. Shared with
 * the instruments so both measure the same picture (instruments/lib/render.mjs).
 */
const renderExemplar = async (name) =>
  (await rasterizeExemplarContent(readFileSync(fixture(name), 'utf8'), fox.width, fox.height)).image;

test('[B2] every slider changes the rendered picture, not just the bytes', async () => {
  // A geometry change that no pixel can see is not "observably changes output".
  const cases = [
    ['colorCount', 8, 3],
    ['detail', 60, 5],
    ['smoothing', 0, 100],
    ['despeckle', 0, 90],
  ];
  for (const [key, from, to] of cases) {
    const a = await engine.vectorize(noisy, { ...RAW, [key]: from });
    const b = await engine.vectorize(noisy, { ...RAW, [key]: to });
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
    ['fox', fox],
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
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const ratio = curveCommandRatio(r.svg);
  // The real the reference product output for this artwork scores 0.671; ours is 1.000.
  assert.ok(
    ratio >= 0.65,
    `curve command ratio ${ratio.toFixed(3)} — the exemplar scores 0.671; ` +
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
  /**
   * REFERENCE lines 73-83 name the product floor: same source, same colour
   * budget, "path count within ~3x of the exemplar's (not thousands of specks),
   * file size within ~5x". On this artwork we are at 0.22x its shapes and 0.42x
   * its bytes, so 3x/5x would gate nothing at all — the bars here are the
   * measured numbers with headroom, and they are the same ones
   * `fixtures/manifest.json` holds on `reference-fox`.
   */
  const exemplar = readFileSync(fixture(FOX_EXEMPLAR), 'utf8');
  const ex = svgStructure(exemplar);
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const ours = svgStructure(r.svg);

  assert.ok(
    ours.subPathCount <= ex.subPathCount * 0.5,
    `${ours.subPathCount} shapes vs the exemplar's ${ex.subPathCount} ` +
      `(${(ours.subPathCount / ex.subPathCount).toFixed(2)}x, limit 0.5x)`,
  );
  assert.ok(
    ours.bytes <= ex.bytes * 0.8,
    `${ours.bytes} bytes vs the exemplar's ${ex.bytes} ` +
      `(${(ours.bytes / ex.bytes).toFixed(2)}x, limit 0.8x)`,
  );

  // ...and the rendering has to hold up next to it, at the source size. Ours
  // scores 1.80 and the real product 1.03 — three quarters of this canvas is
  // transparent and both drawings get that part right, which is why the
  // interesting fidelity numbers below are all measured inside a crop.
  const mae = meanColorError(fox, render(r.svg, r.width, r.height));
  assert.ok(mae < 3, `mean colour error ${mae.toFixed(2)} against the source`);
});

test('[quality] hairlines stay unbroken through the cleanup passes', async () => {
  /**
   * The cleanups (Enhance's canvas-proportional area floor, the despeckle
   * noise filter) judge a region by how many pixels it has, and a hairline has
   * almost none: the reference artwork's whisker arcs and mouth curve are a few
   * pixels wide, so an area-only test deleted them piece by piece and left
   * dashes. MAE and SSIM barely noticed — a fraction of a percent of the
   * pixels — which is why this is measured separately.
   */
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const recall = inkRecall(fox, render(r.svg, r.width, r.height));
  assert.ok(
    recall >= 0.95,
    `only ${(recall * 100).toFixed(1)}% of the source's ink is still ink after tracing — ` +
      'the cleanup passes are eating line art',
  );

  // Enhance must not be the setting that costs you the linework: with every
  // cleanup off the trace is noisier but keeps everything, and Enhance has to
  // stay in the same class.
  const raw = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS, enhance: false });
  const rawRecall = inkRecall(fox, render(raw.svg, raw.width, raw.height));
  assert.ok(
    recall >= rawRecall - 0.03,
    `enhance drops ink recall from ${rawRecall.toFixed(3)} to ${recall.toFixed(3)}`,
  );
});

/**
 * The face of the gold-standard artwork: both eyes, the nose, the mouth curve
 * and the whisker arcs. Same box `fixtures/manifest.json` gives `reference-fox`
 * as its `face` region, so the instrument gate and this contract cannot drift.
 */
const FOX_FACE = { x: 340, y: 350, width: 380, height: 200 };

/**
 * The left front paw: a warm brown sock, mean rgb(133,73,37) in the source,
 * inside an orange leg inside a near-black outline. Same box
 * `fixtures/manifest.json` gives the gold-standard rows as their `paw` region.
 * It is where a ramp snapper can lose a whole colour family, and — being a set
 * of toe arcs inside a contour — it is also where outline continuity and
 * quantization raggedness are easiest to see.
 */
const FOX_PAW = { x: 370, y: 720, width: 140, height: 100 };

/**
 * The nose, the mouth arcs and the white muzzle around them. Same box
 * `fixtures/manifest.json` gives the gold-standard rows as their `muzzle`
 * region, and the only crop that can ask the leak question: the head is orange,
 * so orange inside the *face* box is a colour that box legitimately contains,
 * while cropped to the muzzle it is a hue that does not belong.
 */
const FOX_MUZZLE = { x: 455, y: 455, width: 140, height: 90 };

/** Mean RGB of a region, for asking "did this end up the right hue at all". */
function meanColor(image) {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = image.width * image.height;
  for (let i = 0; i < image.data.length; i += 4) {
    r += image.data[i];
    g += image.data[i + 1];
    b += image.data[i + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

test('[B1] the face survives the Enhance bundle, not just the frame average', async () => {
  /**
   * A blind A/B against the real product is won or lost here, and every
   * whole-frame number in this file is area-weighted: the face is 7 % of the
   * canvas and three quarters of the rest is transparent, so an output that
   * loses both eye arcs and the mouth curve still scores a whole-frame MAE
   * under 2 and an ink recall of 0.967. Measured inside the crop, the same
   * output scores 0.962 against the real product's 0.999 — which is the number
   * that moves when a cleanup pass starts eating thin dark line art.
   */
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const rendered = render(r.svg, r.width, r.height);
  const recall = inkRecall(cropRegion(fox, FOX_FACE), cropRegion(rendered, FOX_FACE));
  assert.ok(
    recall >= 0.94,
    `only ${(recall * 100).toFixed(1)}% of the face's ink survives (eyes, nose, mouth, ` +
      'whiskers) — the whole-frame ink recall cannot see this because the face is 7% of the ' +
      'canvas',
  );

  // ...and Enhance must not be the reason. Whatever the bundle buys in economy,
  // it may not cost the salient region more than a point of ink.
  const raw = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS, enhance: false });
  const rawRecall = inkRecall(
    cropRegion(fox, FOX_FACE),
    cropRegion(render(raw.svg, raw.width, raw.height), FOX_FACE),
  );
  assert.ok(
    recall >= rawRecall - 0.01,
    `Enhance drops face ink recall from ${rawRecall.toFixed(3)} to ${recall.toFixed(3)} — the ` +
      'cleanup that buys the economy budget is being paid for out of the face',
  );
});

test('[quality] colour layers are distinct colours, not a near-duplicate patchwork', async () => {
  /**
   * Ours emitted rgb(213,202,193) beside rgb(197,186,179) (26.6 RGB units) and
   * rgb(94,149,169) beside rgb(115,162,180) (27.0), which renders as blotchy
   * banding — recolour one swatch and a flat region turns out to be a speckled
   * mosaic of two near-identical shades. The metric's window was 24 and
   * reported 0; it is 32 now, and this is the contract that keeps it honest.
   *
   * This is one of the few bars where we are STRICTER than the real product
   * rather than chasing it: its own capture of this artwork ships two such
   * pairs — rgb(125,64,29) beside rgb(116,58,28) (10.9) and rgb(8,0,0) beside
   * rgb(0,0,0) (8.0), two browns and a doubled black — which is exactly the
   * patchwork this forbids, and is most of why our palette comes back one
   * colour shorter than its seven layers.
   */
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const pairs = nearDuplicateFillPairs(r.svg);
  const exemplar = nearDuplicateFillPairs(readFileSync(fixture(FOX_EXEMPLAR), 'utf8'));
  assert.equal(
    exemplar,
    2,
    'the real product ships two near-duplicate layer pairs on this artwork — if that number ' +
      'moved, re-read the paragraph above before trusting the palette-shortfall bars that cite it',
  );
  assert.equal(
    pairs,
    0,
    `${pairs} pair(s) of colour layers within 32 RGB units — layers that close are one region ` +
      'split into a patchwork, not two colours a user asked for',
  );
});

test('[quality] the DEFAULT quality settings stay in the exemplar economy class', async () => {
  /**
   * The exemplar A/B above runs at `enhance: true`, because that is the
   * configuration the captured output corresponds to — which is how the
   * DEFAULT one went unmeasured for seven laps. On this artwork the defaults
   * differ from those settings by exactly one tick (Enhance off), and they cost
   * 36 sub-paths and 17.2 KB against 25 and 14.6 KB: 0.32x and 0.50x the real
   * product's, where turning Smart anti-aliasing off as well would be 1.20x and
   * 0.86x. The real product's own measured effect for that control is -81 %
   * path count (fixtures/reference/OBSERVED-UI.md).
   *
   * The bars are looser than the enhance-on 0.5x/0.8x and still nowhere near
   * REFERENCE's 3x/5x product floor, which nothing here would trip.
   */
  const exemplar = svgStructure(readFileSync(fixture(FOX_EXEMPLAR), 'utf8'));
  const r = await engine.vectorize(foxIn, S);
  const ours = svgStructure(r.svg);
  assert.ok(
    ours.subPathCount <= exemplar.subPathCount * 0.7,
    `${ours.subPathCount} shapes vs the exemplar's ${exemplar.subPathCount} ` +
      `(${(ours.subPathCount / exemplar.subPathCount).toFixed(2)}x, limit 0.7x) at the default ` +
      'quality settings',
  );
  assert.ok(
    ours.bytes <= exemplar.bytes * 0.9,
    `${(ours.bytes / 1024).toFixed(1)} KB vs the exemplar's ${(exemplar.bytes / 1024).toFixed(1)} KB ` +
      `(${(ours.bytes / exemplar.bytes).toFixed(2)}x, limit 0.9x) at the default quality settings`,
  );
});

test('[B4] the default pipeline does not invert a region\'s hue', async () => {
  /**
   * The paw is a warm brown sock inside an orange leg — mean rgb(133,73,37) in
   * the source, red 95 above blue — and the failure this pins is not a fidelity
   * slip but the wrong colour family: Smart anti-aliasing's ramp snapper can
   * collapse a shaded region onto its neighbours' extremes before quantization,
   * the brown loses its histogram mass, and the region is repainted from the
   * nearest surviving colour. On the retired exemplar that produced a warm brown
   * paw pad rendered a cool teal at DEFAULT_SETTINGS, with every global gate
   * green.
   *
   * Judged on the sign, not the size, so it cannot be argued down: a region the
   * source paints clearly warm must not come back cool.
   */
  const src = cropRegion(fox, FOX_PAW);
  const sourceMean = meanColor(src);
  assert.ok(
    sourceMean.r - sourceMean.b >= 20,
    'the fixture crop is not clearly warm any more — re-derive the box before touching this test',
  );

  for (const settings of [{ ...S }, { ...S, colorCount: 6, enhance: true }]) {
    const r = await engine.vectorize(foxIn, settings);
    const out = meanColor(cropRegion(render(r.svg, r.width, r.height), FOX_PAW));
    assert.ok(
      out.r - out.b >= 0,
      `at ${settings.colorCount} colours the paw comes back rgb(${out.r.toFixed(0)},` +
        `${out.g.toFixed(0)},${out.b.toFixed(0)}) from a source rgb(${sourceMean.r.toFixed(0)},` +
        `${sourceMean.g.toFixed(0)},${sourceMean.b.toFixed(0)}) — a warm brown rendered cool, ` +
        'i.e. the colour family was deleted before quantization, not approximated',
    );
  }
});

test('[quality-bar] the DEFAULT settings paint no colour the crop does not contain', async () => {
  /**
   * The configuration a user gets on load, on the crop that decides REFERENCE's
   * blind A/B. The failure mode: specks of a hue the crop does not contain,
   * dropped inside a flat region by nearest-colour matching in plain RGB —
   * the warm skirt of an outline handed to a slot that belongs somewhere else.
   *
   * Nothing else can see it: a few stray specks inside a flat region move mean
   * colour error by hundredths, SSIM by nothing (the local variance term barely
   * blinks) and ink recall by nothing. It is a *categorical* error, so it is
   * asked categorically: what share of the crop is painted a colour the SOURCE
   * crop does not contain (`foreignColorRatio`, tolerance 40).
   *
   * The exemplar's own score is the bar, and the exemplar scores zero. So do
   * we, on the transparent source — the white-flattened variant of the same
   * artwork scores 0.46 % on the paw, which is what `reference-fox-white` in
   * fixtures/manifest.json exists to pin.
   */
  const ex = await renderExemplar(FOX_EXEMPLAR);
  for (const [label, settings] of [
    ['defaults', { ...S }],
    ['the exemplar settings', { ...S, ...EXEMPLAR_SETTINGS }],
  ]) {
    const r = await engine.vectorize(foxIn, settings);
    const ours = renderResult(r);
    for (const [name, box] of [
      ['muzzle', FOX_MUZZLE],
      ['paw', FOX_PAW],
    ]) {
      const src = cropRegion(fox, box);
      const theirs = foreignColorRatio(src, cropRegion(ex, box));
      const mine = foreignColorRatio(src, cropRegion(ours, box));
      assert.ok(
        mine <= Math.max(theirs, 0.0005),
        `${label}: ${(mine * 100).toFixed(2)} % of the ${name} is painted a colour the source ` +
          `crop does not contain, against the real product's ${(theirs * 100).toFixed(2)} % — a ` +
          'hue that is not in the picture is still a hue that is not in the picture',
      );
    }
  }
});

test('[quality] outlines come back as solid strokes, not thinned or dashed', async () => {
  /**
   * `inkRecall` accepts anything darker than luma 128 as "kept", which answers
   * "was this stroke erased" and not "is it still a stroke": on the paw crop it
   * scores us 0.997 against the exemplar's 1.000 for toe arcs that come back
   * visibly thinner than the real product's.
   *
   * Strictly (source ink < 60 must come back < 60) the same crop reads 0.947 of
   * the exemplar's score and the face 0.951. The bar is relative on purpose: a
   * global absolute bar cannot be used, because an exemplar drops antialiased
   * skirts everywhere and its own global score is not the question. The
   * question is only ever "is the real product's line more solid than ours,
   * where ours is worst" — and here it is, by five points.
   */
  const ex = await renderExemplar(FOX_EXEMPLAR);
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const ours = render(r.svg, r.width, r.height);

  for (const [name, box] of [
    ['paw', FOX_PAW],
    ['face', FOX_FACE],
  ]) {
    const src = cropRegion(fox, box);
    const theirs = strictInkRecall(src, cropRegion(ex, box));
    const mine = strictInkRecall(src, cropRegion(ours, box));
    assert.ok(
      mine >= theirs * 0.93,
      `${name}: strict ink recall ${mine.toFixed(3)} against the real product's ` +
        `${theirs.toFixed(3)} (${(mine / theirs).toFixed(3)}x) — its outlines are solid where ` +
        'ours are thin or broken',
    );
  }
});

test('[quality] colour boundaries are smooth sweeps, not sawtooth', async () => {
  /**
   * The signature that makes a many-colour output read as "posterized photo"
   * rather than "clipart": the seam between two shades of the same colour runs
   * as a ragged sawtooth with spikes and notches instead of one clean curve.
   * Nothing else in the suite can see it — both sides of the seam are nearly
   * the right colour (MAE is fine), no ink is involved (ink recall is fine) and
   * it is one big region either way (sub-path count is fine).
   *
   * `layerCompactness` is perimeter / (2*sqrt(pi*area)) per colour layer,
   * averaged over the layers that carry the picture: 1.0 for a disc, higher the
   * more ragged the boundary. Ours 2.99 against the exemplar's 4.55 — on this
   * artwork we are the smooth one, because the real product spends two of its
   * seven layers on near-identical browns whose boundaries interleave.
   *
   * The bar is the instruments' own (`maxLayerCompactnessRatio: 0.8` on
   * `reference-fox`), not the 1.1 it was when we were the ragged one: three
   * changes closed that gap — the pre-fit boundary low-pass, the linework
   * moving to the silhouette layer, and the Enhance area floors — and a bar
   * left where reality no longer is would let any one of them rot without a
   * test noticing.
   */
  const exemplar = layerCompactness(readFileSync(fixture(FOX_EXEMPLAR), 'utf8'));
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const ours = layerCompactness(r.svg);
  assert.ok(
    ours.mean <= exemplar.mean * 0.8,
    `mean layer compactness ${ours.mean.toFixed(2)} over ${ours.counted} layers vs the exemplar's ` +
      `${exemplar.mean.toFixed(2)} over ${exemplar.counted} ` +
      `(${(ours.mean / exemplar.mean).toFixed(2)}x, limit 0.8x) — our colour boundaries carry ` +
      'that much more perimeter for the area they enclose',
  );
});

test('[quality] the linework is one silhouette, not a network of thin ribbons', async () => {
  /**
   * The most expensive layer in a piece of line art is the ink, and trimmed to
   * its own pixels it is the worst-shaped thing in the document: a compound
   * path of dozens of long, near-zero-area contours that follow both sides of
   * every stroke. Painted first as the whole drawn SILHOUETTE it is a single
   * smooth outline, and the picture is identical because every non-ink pixel is
   * repainted by its own layer on top — plus the sub-pixel cracks where two
   * trimmed layers meet now show the OUTLINE colour instead of the paper, which
   * on line art is the thing that should be there.
   *
   * What this pins is that the bottom layer is the ink and that it really is
   * one shape: the alternative (bottom layer = dominant colour) costs ~2x the
   * bytes on the gold standard and is what the layer-compactness gate above was
   * failing on. On this artwork the bottom layer comes back rgb(2,2,2) as a
   * single contour, while the real product's own capture puts a near-white
   * sticker border underneath everything and pays for it in perimeter.
   */
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const first = /<g fill="rgb\((\d+),\s*(\d+),\s*(\d+)\)">([\s\S]*?)(?=<g fill=|<\/svg>)/.exec(r.svg);
  assert.ok(first, 'no colour layer groups in the output');
  const luma = 0.299 * Number(first[1]) + 0.587 * Number(first[2]) + 0.114 * Number(first[3]);
  assert.ok(
    luma < 60,
    `the bottom layer is rgb(${first[1]},${first[2]},${first[3]}) (luma ${luma.toFixed(0)}) — the ` +
      'drawing has ink and something else was painted underneath it',
  );
  assert.equal(
    countSubPaths(first[4]),
    1,
    'the ink layer is the silhouette, so it is exactly one closed contour with no holes',
  );
});

test('[B3] every colour the palette promises appears in the drawing', async () => {
  /**
   * The palette editor lists a swatch per output colour and the groups panel
   * draws a circle for it, so a colour that survives the segmentation and then
   * loses every one of its shapes to an area floor is a swatch that paints
   * nothing. The Enhance floor is a *simplification*, and simplifying a colour
   * out of existence is a different act from tidying its edges — so a layer the
   * floor would empty is retraced at Minimum Area instead.
   *
   * Measured at the setting where it bites: the exemplar settings, whose
   * Minimum Area of 5px² plus the Enhance floor is what empties a layer.
   */
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const painted = new Set(
    fillLayerChunks(r.svg)
      .filter((layer) => countSubPaths(layer.body) > 0 || /<(rect|circle)\b/.test(layer.body))
      .map((layer) => layer.fill.replace(/\s+/g, '')),
  );
  const missing = r.palette
    .map((c) => `rgb(${c.r},${c.g},${c.b})`)
    .filter((fill) => !painted.has(fill));
  assert.deepEqual(
    missing,
    [],
    `the palette promises ${r.palette.length} colours and ${missing.length} of them ` +
      `(${missing.join(', ')}) are nowhere in the document`,
  );
});

test('[quality] the seam through a shading gradient is one arc, not a mountain range', async () => {
  /**
   * The local half of the sawtooth question, and the one a person actually
   * sees. `layerCompactness` (above) is perimeter over area for a whole layer,
   * so it cannot separate a shape that is genuinely intricate from a smooth
   * shape traced onto a noisy per-pixel threshold — and `curveCommandRatio`
   * cannot either, because our commands ARE cubics. They can be cubics fitted
   * to a wobble the real product never had: on the retired exemplar the lap-6
   * critique measured 43 % more boundary length than the real output for the
   * same region, with the source showing a soft gradient and the exemplar one
   * clean arc.
   *
   * `layerBoundaryWobble` walks both boundaries at the same fraction of each
   * drawing's own diagonal (so the exemplar's 10x viewBox needs no scale
   * factor) and measures the heading change per unit travelled. Ours 28.4
   * against the exemplar's 80.2 — the bar is 0.45x, the instruments' own
   * (`maxLayerWobbleRatio` on `reference-fox`), because a bar above 1 is a bar
   * this drawing cannot reach from the wrong side any more.
   */
  const exemplar = layerBoundaryWobble(readFileSync(fixture(FOX_EXEMPLAR), 'utf8'));
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const ours = layerBoundaryWobble(r.svg);
  assert.ok(
    ours.mean <= exemplar.mean * 0.45,
    `boundary wobble ${ours.mean.toFixed(1)} over ${ours.counted} layers vs the exemplar's ` +
      `${exemplar.mean.toFixed(1)} over ${exemplar.counted} ` +
      `(${(ours.mean / exemplar.mean).toFixed(2)}x, limit 0.45x) — our colour boundaries change ` +
      'direction that much more often per unit of boundary walked, which is what reads as ' +
      'posterized photo rather than clipart',
  );
});

test('[quality] the black outline survives a small colour budget', async () => {
  // At 6 colours the real product keeps the drawing's black outline; a plain
  // coverage-ranked palette loses it into the nearest dark mid-tone and the
  // drawing falls apart. Ours keeps rgb(2,2,2).
  const r = await engine.vectorize(foxIn, { ...S, colorCount: 6, enhance: true });
  const darkest = r.palette
    .map((c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b)
    .reduce((a, b) => Math.min(a, b), 255);
  assert.ok(
    darkest < 60,
    `the darkest of 6 palette entries has luma ${darkest.toFixed(0)} — the outline black is gone`,
  );
});
