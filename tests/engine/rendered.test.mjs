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
  inkRecall,
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
 * gold-standard source is 33 % transparent, and the difference is not
 * cosmetic: fed the flattened image the face keeps 0.956 of its ink, fed the
 * pixels the app actually produces it keeps 0.865. A contract measured on
 * pixels the product never sees is not a contract.
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
const artwork = await load('reference/artwork.png');
/** Handed to the engine (alpha preserved). */
const artworkIn = await loadIngest('reference/artwork.png');

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
 * NOT `render()`: `fixtures/reference/artwork.svg` draws its artwork in the
 * top-left quarter of its declared viewBox, so rendering it against that box
 * puts the real product's paw where our margin is. Every comparison would then
 * pass for the wrong reason. Shared with the instruments so both measure the
 * same picture (instruments/lib/render.mjs).
 */
const renderExemplar = async (name) =>
  (await rasterizeExemplarContent(readFileSync(fixture(name), 'utf8'), artwork.width, artwork.height))
    .image;

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
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
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
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
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
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
  const recall = inkRecall(artwork, render(r.svg, r.width, r.height));
  assert.ok(
    recall >= 0.94,
    `only ${(recall * 100).toFixed(1)}% of the source's ink is still ink after tracing — ` +
      'the cleanup passes are eating line art',
  );

  // Enhance must not be the setting that costs you the linework: with every
  // cleanup off the trace is noisier but keeps everything, and Enhance has to
  // stay in the same class.
  const raw = await engine.vectorize(artworkIn, { ...S, colorCount: 16 });
  const rawRecall = inkRecall(artwork, render(raw.svg, raw.width, raw.height));
  assert.ok(
    recall >= rawRecall - 0.03,
    `enhance drops ink recall from ${rawRecall.toFixed(3)} to ${recall.toFixed(3)}`,
  );
});

/**
 * The face of the gold-standard artwork: both eyes, both fangs, the mouth
 * curve. Same box `fixtures/manifest.json` gives `reference-artwork` as its
 * `salientRegion`, so the instrument gate and this contract cannot drift.
 */
const ARTWORK_FACE = { x: 300, y: 200, width: 360, height: 200 };

/**
 * The left paw pad: a warm brown, rgb(164,143,125) in the source, surrounded by
 * cream and outlined in near-black. Same box `fixtures/manifest.json` gives the
 * gold-standard rows as their `paw-pad` salient region. It is where the default
 * pipeline loses a whole colour family, and — being an ellipse inside a contour
 * inside a shaded region — it is also where outline continuity and quantization
 * raggedness are easiest to see.
 */
const ARTWORK_PAW_PAD = { x: 60, y: 670, width: 110, height: 80 };

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
   * A blind A/B against the real product was lost here with every gate green.
   * Rasterized side by side, ours had a mouth broken into dark blobs, both
   * white fangs gone (one inverted to a blob) and the right eye swallowed by a
   * shading wedge, while the real output kept two clean eye arcs, two crisp
   * fangs and one unbroken mouth. The whole-frame numbers could not see it:
   * MAE 5.37, SSIM 0.9168, ink recall 0.9421 against a 0.94 floor — because
   * the face is 8 % of the canvas and every one of those scores is
   * area-weighted.
   *
   * Measured inside the face, the same output scores 0.865 while the SAME
   * image with Enhance off scores 0.912 and with Enhance off + Smart AA 0.965.
   * So this is the Enhance bundle eating thin dark line art, not a limit of
   * the tracer.
   */
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
  const rendered = render(r.svg, r.width, r.height);
  const recall = inkRecall(cropRegion(artwork, ARTWORK_FACE), cropRegion(rendered, ARTWORK_FACE));
  assert.ok(
    recall >= 0.93,
    `only ${(recall * 100).toFixed(1)}% of the face's ink survives (eyes, fangs, mouth) — ` +
      'the whole-frame ink recall cannot see this because the face is 8% of the canvas',
  );

  // ...and Enhance must not be the reason. Whatever the bundle buys in economy,
  // it may not cost the salient region more than a point of ink.
  const raw = await engine.vectorize(artworkIn, { ...S, colorCount: 16 });
  const rawRecall = inkRecall(
    cropRegion(artwork, ARTWORK_FACE),
    cropRegion(render(raw.svg, raw.width, raw.height), ARTWORK_FACE),
  );
  assert.ok(
    recall >= rawRecall - 0.01,
    `Enhance drops face ink recall from ${rawRecall.toFixed(3)} to ${recall.toFixed(3)} — the ` +
      'cleanup that buys the economy budget is being paid for out of the face',
  );
});

test('[quality] colour layers are distinct colours, not a near-duplicate patchwork', async () => {
  /**
   * The real exemplar's eight `<g fill>` layers are never closer than 37 RGB
   * units apart. Ours emitted rgb(213,202,193) beside rgb(197,186,179) (26.6)
   * and rgb(94,149,169) beside rgb(115,162,180) (27.0), which renders as
   * blotchy banding across the belly and arms — recolour one swatch and the
   * body turns out to be a speckled mosaic of two near-identical creams. The
   * metric's window was 24 and reported 0; it is 32 now, and this is the
   * contract that keeps it honest.
   */
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
  const pairs = nearDuplicateFillPairs(r.svg);
  const exemplar = nearDuplicateFillPairs(readFileSync(fixture('reference/artwork.svg'), 'utf8'));
  assert.equal(exemplar, 0, 'the exemplar itself must have no near-duplicate layers');
  assert.equal(
    pairs,
    0,
    `${pairs} pair(s) of colour layers within 32 RGB units — layers that close are one region ` +
      'split into a patchwork, not two colours a user asked for',
  );
});

test('[quality] the DEFAULT quality settings stay in the exemplar economy class', async () => {
  /**
   * Every exemplar gate runs at `enhance: true`, so the configuration a user
   * gets out of the box was never measured: at 16 colours with Enhance off the
   * output is 396 KB / 1747 sub-paths against the exemplar's 31 KB / 65 — 13x
   * bytes, 27x shapes. The limits below are much looser than the enhance-on
   * 5x/3x, and still well inside what the engine has been measured doing:
   * Smart anti-aliasing alone (no Enhance) reaches 5.3x / 9.3x. The real
   * product's own measured effect for that control is -81 % path count
   * (fixtures/reference/OBSERVED-UI.md).
   */
  const exemplar = svgStructure(readFileSync(fixture('reference/artwork.svg'), 'utf8'));
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16 });
  const ours = svgStructure(r.svg);
  assert.ok(
    ours.subPathCount <= exemplar.subPathCount * 12,
    `${ours.subPathCount} shapes vs the exemplar's ${exemplar.subPathCount} ` +
      `(${(ours.subPathCount / exemplar.subPathCount).toFixed(1)}x, limit 12x) at the default ` +
      'quality settings',
  );
  assert.ok(
    ours.bytes <= exemplar.bytes * 8,
    `${(ours.bytes / 1024).toFixed(0)} KB vs the exemplar's ${(exemplar.bytes / 1024).toFixed(0)} KB ` +
      `(${(ours.bytes / exemplar.bytes).toFixed(1)}x, limit 8x) at the default quality settings`,
  );
});

test('[B4] the default pipeline does not invert a region\'s hue', async () => {
  /**
   * The paw pad is a warm brown in the source — mean rgb(153,136,121), red 32
   * above blue — and at DEFAULT_SETTINGS it comes back mean rgb(107,137,146),
   * red 39 *below* blue. That is not a fidelity slip, it is the wrong colour
   * family: Smart anti-aliasing's ramp snapper collapses the pad's shading onto
   * its neighbours' extremes before quantization, the brown loses its histogram
   * mass, and the region is repainted from the nearest surviving colour, which
   * is a blue.
   *
   * Judged on the sign, not the size, so it cannot be argued down: a region the
   * source paints clearly warm must not come back cool.
   */
  const src = cropRegion(artwork, ARTWORK_PAW_PAD);
  const sourceMean = meanColor(src);
  assert.ok(
    sourceMean.r - sourceMean.b >= 20,
    'the fixture crop is not clearly warm any more — re-derive the box before touching this test',
  );

  for (const settings of [{ ...S }, { ...S, colorCount: 6, enhance: true }]) {
    const r = await engine.vectorize(artworkIn, settings);
    const out = meanColor(cropRegion(render(r.svg, r.width, r.height), ARTWORK_PAW_PAD));
    assert.ok(
      out.r - out.b >= 0,
      `at ${settings.colorCount} colours the paw pad comes back rgb(${out.r.toFixed(0)},` +
        `${out.g.toFixed(0)},${out.b.toFixed(0)}) from a source rgb(${sourceMean.r.toFixed(0)},` +
        `${sourceMean.g.toFixed(0)},${sourceMean.b.toFixed(0)}) — a warm brown rendered a cool ` +
        'teal, i.e. the colour family was deleted before quantization, not approximated',
    );
  }
});

test('[quality] outlines come back as solid strokes, not thinned or dashed', async () => {
  /**
   * `inkRecall` accepts anything darker than luma 128 as "kept", which answers
   * "was this stroke erased" and not "is it still a stroke". On the paw crop it
   * scored us 0.978 against the exemplar's 1.000 — and `regionInkRecall` even
   * read 1.08x the exemplar overall — for a contour a critic could see was
   * hairline-thin and interrupted where the real product's was unbroken.
   *
   * Strictly (source ink < 60 must come back < 60) the same crop reads 0.943 of
   * the exemplar's score. The bar is relative on purpose: a global absolute bar
   * cannot be used, because the exemplar drops antialiased skirts everywhere
   * and scores 0.859 globally to our 0.899. The question is only ever "is the
   * real product's line more solid than ours, where ours is worst".
   */
  const ex = await renderExemplar('reference/artwork.svg');
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
  const ours = render(r.svg, r.width, r.height);

  for (const [name, box] of [
    ['paw pad', ARTWORK_PAW_PAD],
    ['face', ARTWORK_FACE],
  ]) {
    const src = cropRegion(artwork, box);
    const theirs = strictInkRecall(src, cropRegion(ex, box));
    const mine = strictInkRecall(src, cropRegion(ours, box));
    assert.ok(
      mine >= theirs * 0.98,
      `${name}: strict ink recall ${mine.toFixed(3)} against the real product's ` +
        `${theirs.toFixed(3)} (${(mine / theirs).toFixed(3)}x) — its outlines are solid where ` +
        'ours are thin or broken',
    );
  }
});

test('[quality] colour boundaries are smooth sweeps, not sawtooth', async () => {
  /**
   * The signature that makes a 16-colour output read as "posterized photo"
   * rather than "clipart": the seam between two shades of the same colour runs
   * as a ragged sawtooth with spikes and notches instead of one clean curve.
   * Nothing else in the suite can see it — both sides of the seam are nearly
   * the right colour (MAE is fine), no ink is involved (ink recall is fine) and
   * it is one big region either way (sub-path count is fine).
   *
   * `layerCompactness` is perimeter / (2*sqrt(pi*area)) per colour layer,
   * averaged over the layers that carry the picture: 1.0 for a disc, higher the
   * more ragged the boundary. Ours 3.73 against the exemplar's 2.67.
   */
  const exemplar = layerCompactness(readFileSync(fixture('reference/artwork.svg'), 'utf8'));
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 16, enhance: true });
  const ours = layerCompactness(r.svg);
  assert.ok(
    ours.mean <= exemplar.mean * 1.3,
    `mean layer compactness ${ours.mean.toFixed(2)} over ${ours.counted} layers vs the exemplar's ` +
      `${exemplar.mean.toFixed(2)} over ${exemplar.counted} ` +
      `(${(ours.mean / exemplar.mean).toFixed(2)}x, limit 1.3x) — our colour boundaries carry ` +
      'that much more perimeter for the area they enclose',
  );
});

test('[quality] the black outline survives a small colour budget', async () => {
  // At 6 colours the real product keeps artwork's black outline; a plain
  // coverage-ranked palette loses it into dark teal and the drawing falls apart.
  const r = await engine.vectorize(artworkIn, { ...S, colorCount: 6, enhance: true });
  const darkest = r.palette
    .map((c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b)
    .reduce((a, b) => Math.min(a, b), 255);
  assert.ok(
    darkest < 60,
    `the darkest of 6 palette entries has luma ${darkest.toFixed(0)} — the outline black is gone`,
  );
});
