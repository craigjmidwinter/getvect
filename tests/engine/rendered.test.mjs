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
import {
  boundarySmoothness,
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
 * `DEFAULT_SETTINGS` ships Smart anti-aliasing on — it is what keeps the default
 * output economical; fixtures/reference/ARTWORK.md has the measurement. Its index-image majority pass is also a very effective impulse
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
/**
 * The settings the A/B comparisons below run at: Clipart, 8 colours, Smart
 * anti-aliasing, Minimum Area 5px², Enhance on. Every
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
  // Ours scores 1.000 on this artwork: every boundary segment is a curve command.
  assert.ok(
    ratio >= 0.65,
    `curve command ratio ${ratio.toFixed(3)} — runs of h/v/l are a staircase ` +
      'however few <path> elements they hide in',
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
   * Whether the trace looks right to a person is won or lost here, and every
   * whole-frame number in this file is area-weighted: the face is 7 % of the
   * canvas and three quarters of the rest is transparent, so an output that
   * loses both eye arcs and the mouth curve still scores a whole-frame MAE
   * under 2 and an ink recall of 0.967. Measured inside the crop it scores
   * 0.962 — and that is the number that moves when a cleanup pass starts
   * eating thin dark line art. A whole-frame average cannot see the face.
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
   * The bar is ABSOLUTE — zero pairs — and always was. It used to be asserted
   * alongside a comparative leg against a checked-in exemplar; that leg is gone
   * and nothing about this contract changed, which is the tell that it was
   * never carrying the test.
   */
  const r = await engine.vectorize(foxIn, { ...S, ...EXEMPLAR_SETTINGS });
  const pairs = nearDuplicateFillPairs(r.svg);
  assert.equal(
    pairs,
    0,
    `${pairs} pair(s) of colour layers within 32 RGB units — layers that close are one region ` +
      'split into a patchwork, not two colours a user asked for',
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
   * The bar is ZERO, and it always effectively was: this used to read
   * `mine <= Math.max(theirs, 0.0005)` against a checked-in exemplar that
   * scored 0, so the comparison never bound and 0.0005 was the whole contract.
   * On the transparent source we score zero; the white-flattened variant of the
   * same artwork scores 0.46 % on the paw, which is what `reference-fox-white`
   * in fixtures/manifest.json exists to pin.
   */
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
      const mine = foreignColorRatio(src, cropRegion(ours, box));
      assert.ok(
        mine <= 0.0005,
        `${label}: ${(mine * 100).toFixed(2)} % of the ${name} is painted a colour the source ` +
          'crop does not contain — a hue that is not in the picture is still a hue that is ' +
          'not in the picture',
      );
    }
  }
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
   * bytes on this artwork and is what the layer-compactness gate above was
   * failing on. Here the bottom layer comes back rgb(2,2,2) as a single
   * contour. Laying a near-white sticker border underneath everything is the
   * other plausible choice, and it pays for itself in perimeter.
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

test('[quality] the black outline survives a small colour budget', async () => {
  // At 6 colours a plain coverage-ranked palette loses the drawing's black
  // outline into the nearest dark mid-tone and the drawing falls apart. Ink is
  // a small fraction of the pixels and carries most of the legibility, so it
  // has to survive a small budget on merit rather than on area. Ours keeps
  // rgb(2,2,2).
  const r = await engine.vectorize(foxIn, { ...S, colorCount: 6, enhance: true });
  const darkest = r.palette
    .map((c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b)
    .reduce((a, b) => Math.min(a, b), 255);
  assert.ok(
    darkest < 60,
    `the darkest of 6 palette entries has luma ${darkest.toFixed(0)} — the outline black is gone`,
  );
});

test('[quality] a smooth source arc comes back smooth, not as the pixel grid', async () => {
  /**
   * The one geometry contract in this file measured against a KNOWN shape.
   *
   * Everything else here compares the trace with a smoothed copy of itself,
   * which does not know what the boundary was meant to be: a curve fitter that spends its whole error budget on a long arc
   * emits a boundary that leaves the arc in the middle of every segment and
   * rejoins it at the ends, and that scores *better* on turning-per-unit-length
   * than the truth it is approximating. `fixtures/arcs-560x256.png` is drawn
   * from the circle equation, so the residual is a fact.
   *
   * A trace that reproduced the pixel boundary verbatim scores ~0.37px; the lap
   * that added this measured 0.42px before and 0.23px after.
   */
  const manifest = JSON.parse(readFileSync(fixture('manifest.json'), 'utf8'));
  const entry = manifest.fixtures.find((f) => f.id === 'arcs-560x256');
  assert.ok(entry?.arcs?.length, 'the arcs fixture must declare the circles it was drawn from');
  const image = await loadIngest(entry.file);
  const r = await engine.vectorize(image, { ...S });
  const smoothness = boundarySmoothness(r.svg, entry.arcs);
  assert.equal(smoothness.counted, entry.arcs.length, 'every declared arc must be found');
  const worst = smoothness.arcs.reduce((a, b) => (a.rms >= b.rms ? a : b));
  assert.ok(
    smoothness.rms <= 0.24,
    `the worst fitted arc (${worst.name}, r=${worst.r}) sits RMS ${smoothness.rms.toFixed(3)}px ` +
      `from the circle it traces, worst point ${smoothness.max.toFixed(3)}px — the fitter is ` +
      'handing back the pixel staircase it was given (0.37px is the staircase itself)',
  );
});
