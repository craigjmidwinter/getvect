/**
 * Engine parity tests — `npm run test:engine`.
 *
 * engine.test.mjs covers the contract the harness was built around. This file
 * covers the REFERENCE features the app does not implement yet, at the level
 * where they are cheapest to check: the pure engine. Every setting REFERENCE
 * lists as "observably changes output" is asserted here in the direction the
 * control promises, so an implementation that only jiggles the bytes fails.
 *
 * Expect this file to be red until B2-B6 land.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { canvasIngest, decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';
import {
  countSubPaths,
  curveCommandRatio,
  layerFills,
  nearDuplicateFillPairs,
  subPathBoxes,
  pathDataAttributes,
} from '../../instruments/lib/metrics.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const engine = require(join(root, 'dist/engine/index.js'));
const fixture = (name) => join(root, 'fixtures', name);

const load = async (name) => flattenOnWhite(await decodeImageFile(fixture(name)));
const S = engine.DEFAULT_SETTINGS;

/**
 * Defaults with every optional cleanup off.
 *
 * `DEFAULT_SETTINGS` ships Smart anti-aliasing on — it is what keeps the default
 * output economical; fixtures/reference/ARTWORK.md has the measurement. Its index-image majority pass is also a very effective impulse
 * remover, so on the speckled fixture the noise-removal controls have nothing
 * left to remove and cannot be observed at all. Checks that ask "does THIS
 * control do something" isolate it here; checks about the shipped configuration
 * use `S`.
 */
const RAW = { ...S, antiAliasing: 'off' };

const flat = await load('logo-flat-512.png');
const noisy = await load('logo-noisy-512.png');
const fox = await load('reference/fox-sticker.png');
/**
 * The gold standard as the *app* hands it over — `(0,0,0,0)` for every
 * transparent pixel, the one decode contract in docs/HARNESS.md. Colour-budget
 * questions have to be asked on these pixels: the flattened version donates a
 * palette slot to a white background the user never asked for, and on this
 * artwork three quarters of the canvas is that background.
 */
const foxIn = canvasIngest(await decodeImageFile(fixture('reference/fox-sticker.png')));
/**
 * The settings the checked-in exemplar was captured at
 * (fixtures/reference/ARTWORK.md): Clipart, 8 colours, Smart anti-aliasing,
 * Enhance on. Colour-budget questions are asked here rather than at 16, because
 * 8 is the budget there is a reference-product capture to argue with.
 */
const EXEMPLAR_COLORS = 8;

/** The six colours scripts/generate-fixtures.mjs draws the flat fixture from. */
const FLAT_SOURCE_COLORS = ['#f2efe6', '#1b3a5c', '#2b2b2b', '#e4572e', '#2e9e5b', '#f2c14e'];

const fillsIn = (svg) => {
  const set = new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  set.delete('none');
  return set;
};
const hexOfLayer = (c) =>
  `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

const run = (image, overrides) => engine.vectorize(image, { ...S, ...overrides });
/** `run`, with the default cleanups off — see `RAW`. */
const runRaw = (image, overrides) => engine.vectorize(image, { ...RAW, ...overrides });

/** Compare documents by digest so a failure prints a reason, not 40KB of path data. */
const digest = (svg) => createHash('sha1').update(svg).digest('hex').slice(0, 12);
const assertDiffers = (a, b, message) => assert.notEqual(digest(a), digest(b), message);

// --- B2: model presets ------------------------------------------------------

test('[B2] the four model presets each produce a different picture', async () => {
  const seen = new Map();
  for (const preset of ['clipart', 'photo', 'sketch', 'drawing']) {
    const r = await run(flat, { preset });
    for (const [other, svg] of seen) {
      assertDiffers(r.svg, svg, `preset ${preset} is identical to ${other}`);
    }
    seen.set(preset, r.svg);
  }
});

test('[B2] the Sketch preset is grayscale', async () => {
  const r = await run(flat, { preset: 'sketch' });
  for (const c of r.palette) {
    assert.ok(c.r === c.g && c.g === c.b, `sketch palette entry ${hexOfLayer(c)} is not grey`);
  }
});

test('[B2] the Drawing preset is two-tone and its threshold moves the edge', async () => {
  const r = await run(flat, { preset: 'drawing' });
  assert.ok(r.palette.length <= 2, `drawing produced ${r.palette.length} colours`);
  const fills = [...fillsIn(r.svg)].sort();
  assert.ok(
    fills.every((f) => /^(#000000|#ffffff|rgb\(0, ?0, ?0\)|rgb\(255, ?255, ?255\))$/.test(f)),
    `drawing fills should be black/white, got ${fills.join(', ')}`,
  );
  const dark = await run(flat, { preset: 'drawing', bwThreshold: 60 });
  const light = await run(flat, { preset: 'drawing', bwThreshold: 200 });
  assertDiffers(dark.svg, light.svg, 'bwThreshold left the output unchanged');
});

test('[B2] the Clipart detail level runs from Maximum to Minimum', async () => {
  const levels = ['maximum', 'ultra', 'very-high', 'high', 'medium', 'low', 'minimum'];
  const sizes = [];
  for (const detailLevel of levels) {
    const r = await run(noisy, { preset: 'clipart', detailLevel });
    sizes.push({ detailLevel, subPaths: countSubPaths(r.svg), bytes: r.svg.length });
  }
  const distinct = new Set(sizes.map((s) => s.bytes));
  assert.equal(distinct.size, levels.length, 'every detail level must produce its own output');
  assert.ok(
    sizes[sizes.length - 1].subPaths < sizes[0].subPaths,
    'Minimum detail must be simpler than Maximum',
  );
});

// --- B3: output colour groups ----------------------------------------------

test('[B3] disabling a colour removes its layer entirely', async () => {
  const base = await run(flat, {});
  const dominant = hexOfLayer(base.palette[0]);
  const r = await run(flat, { disabledColors: [0] });

  const fills = layerFills(r.svg).map(hexOfLayer);
  assert.ok(!fills.includes(dominant), `disabled colour ${dominant} still has a layer`);
  assert.ok(
    !/<rect[^>]*width="512"[^>]*height="512"/.test(r.svg),
    'a disabled background must not leave a full-bleed backdrop rect',
  );
});

/**
 * Strip the colour off an SVG, leaving the drawing.
 *
 * A palette override is documented (docs/HARNESS.md, and the comment above
 * `vectorize`'s quantize step) as an *output colour table*: it repaints slots,
 * it does not re-segment the image. That claim is exactly "the geometry is the
 * same document with different fills", which is what this makes checkable.
 */
const geometryOf = (svg) => svg.replace(/fill="rgb\([^)]*\)"/g, 'fill="X"');

test('[B3] a palette fed back unchanged repaints nothing — it must not re-segment', async () => {
  /**
   * The palette editor's change / merge / remove all reduce to "re-vectorize
   * with this explicit `settings.palette`", so the identity case is the whole
   * contract in one line: hand the engine back the palette it just computed and
   * the document must not move.
   *
   * It moves. On the gold standard at 16 colours + Enhance the base run returns
   * an 8-colour palette and a 71-sub-path SVG; feeding that same palette back
   * returns 88 sub-paths and different geometry — the face gains a blue wash
   * over the mouth and right eye and the shoulders turn black. Cause:
   * `src/engine/index.ts` clusters at `override.length` when a palette is set
   * and at `presetColorCount(opts)` otherwise, so the un-overridden run
   * clusters at 16 and folds down to 8 while the override run clusters from
   * scratch at k=8. Slot i is then paired with a cluster from a different
   * segmentation, and *every* palette-editor operation silently re-quantizes
   * real artwork.
   *
   * Every existing b3-palette spec runs on `logo-flat-512.png`, where requested
   * 8 folds to 6 and the identity happens to hold — hence the gold standard
   * here, at both configurations, plus the flat fixture as the regression
   * anchor.
   */
  const cases = [
    ['logo-flat-512 at the defaults', flat, {}],
    ['the gold standard at the defaults', foxIn, {}],
    ['the gold standard at the exemplar settings', foxIn, { colorCount: EXEMPLAR_COLORS, enhance: true }],
  ];
  for (const [label, image, overrides] of cases) {
    const base = await run(image, overrides);
    const identity = await run(image, { ...overrides, palette: base.palette });
    assert.deepEqual(
      identity.palette.map(engine.hexOf),
      base.palette.map(engine.hexOf),
      `${label}: the palette changed when it was fed back unchanged`,
    );
    assert.equal(
      countSubPaths(identity.svg),
      countSubPaths(base.svg),
      `${label}: feeding the palette back re-segmented the image ` +
        `(${countSubPaths(base.svg)} sub-paths -> ${countSubPaths(identity.svg)})`,
    );
    assert.equal(
      geometryOf(identity.svg),
      geometryOf(base.svg),
      `${label}: the geometry changed under an identity palette override — a no-op palette ` +
        'edit repainted the picture',
    );
  }
});

test('[B3] a merge survives the next setting change', async () => {
  /**
   * The identity check above only covers the first edit. The editor's merge
   * makes the *displayed* palette shorter than the engine's slot table (two
   * slots, one colour), so what the app stores as the override has to be
   * `result.slots`, not `result.palette` — hand back the deduped list and k-1
   * colours land on k slots, which shifts every colour past the merge one place
   * along the moment the user touches any other control.
   *
   * So: merge, then re-vectorize with what the engine handed back, and the
   * document must be byte-identical.
   */
  const base = await run(foxIn, { colorCount: EXEMPLAR_COLORS, enhance: true });
  assert.equal(base.slots.length, base.palette.length, 'an unedited result has one slot per colour');

  const mergeInto0 = base.slots.map((c, i) => (i === 3 ? { ...base.slots[0] } : c));
  const merged = await run(foxIn, { colorCount: EXEMPLAR_COLORS, enhance: true, palette: mergeInto0 });
  assert.equal(
    merged.palette.length,
    base.palette.length - 1,
    'merging two slots must collapse them into one output colour',
  );
  assert.equal(
    merged.slots.length,
    base.slots.length,
    'a merge repaints slots; it must not remove one',
  );

  const again = await run(foxIn, { colorCount: EXEMPLAR_COLORS, enhance: true, palette: merged.slots });
  assert.equal(
    again.svg,
    merged.svg,
    'feeding the merged slot table back changed the document — the second edit after a merge ' +
      'repaints the wrong slots',
  );
});

test('[B3] recolouring one swatch repaints that slot and leaves the drawing alone', async () => {
  /**
   * The user-visible half of the check above: pick a swatch, change its colour,
   * and every contour must be where it was. Anything else means the click that
   * was meant to recolour a region re-traced the artwork.
   */
  for (const [label, image, overrides] of [
    ['logo-flat-512', flat, {}],
    ['the gold standard', foxIn, { colorCount: EXEMPLAR_COLORS, enhance: true }],
  ]) {
    const base = await run(image, overrides);
    const target = base.palette.length - 1;
    const palette = base.palette.map((c, i) => (i === target ? { r: 255, g: 0, b: 255 } : c));
    const edited = await run(image, { ...overrides, palette });
    assert.ok(
      layerFills(edited.svg).map(hexOfLayer).includes('#ff00ff'),
      `${label}: the colour the user picked never reached the output`,
    );
    assert.equal(
      geometryOf(edited.svg),
      geometryOf(base.svg),
      `${label}: recolouring slot ${target} moved the geometry — a palette override is an output ` +
        'colour table, not a new set of cluster centres',
    );
  }
});

test('[B3] the merge threshold collapses near-identical output colours', async () => {
  const none = await run(noisy, { colorCount: 16, mergeThreshold: 0 });
  const merged = await run(noisy, { colorCount: 16, mergeThreshold: 5 });
  assertDiffers(none.svg, merged.svg, 'mergeThreshold left the output unchanged');
  assert.ok(
    layerFills(merged.svg).length <= layerFills(none.svg).length,
    'merging must not increase the layer count',
  );
});

test('[B3] the sort order reorders layers without changing the colour set', async () => {
  const a = await run(flat, { sortOrder: 'coverage' });
  const b = await run(flat, { sortOrder: 'brightness' });
  const fa = layerFills(a.svg).map(hexOfLayer);
  const fb = layerFills(b.svg).map(hexOfLayer);
  assert.notDeepEqual(fa, fb, 'sortOrder left the layer order unchanged');
  assert.deepEqual([...fa].sort(), [...fb].sort(), 'sorting must not change which colours exist');
});

test('[B3] the colour budget is spent on colours the user can tell apart', async () => {
  /**
   * `colorCount` is the headline control of the product, so a shortfall has to
   * be *earned*. The floor is a property of the ARTWORK, not of any particular
   * tracer: at an 8-colour budget `fox-sticker.png` contains five regions a
   * person would name as separate colours — white, pink, orange, brown, black —
   * plus the cyan eyes, which are small enough that losing them is a known
   * defect class rather than a palette shortfall (issue #2). Five is therefore
   * the floor a trace has to clear to be describable as an 8-colour trace at
   * all, and it is a floor rather than a target: today we deliver SIX distinct
   * `<g fill>` layers on this image, closest pair 121.3 apart in Euclidean RGB,
   * which is well clear of the 32-unit halo window `nearDuplicateFillPairs`
   * calls a duplicate.
   *
   * An earlier revision demanded `min(requested, found) - 1` at every budget.
   * That bar is not reachable together with the repo's own
   * `maxNearDuplicateFills: 0` gate: the clusters this image yields at a large
   * budget contain pairs inside the halo window, so a palette of all-but-one of
   * them ships duplicates. Shipping the duplicates and folding them are the two
   * available resolutions; we fold, which is what every other check in this
   * repo asks for. Only one of the two bars can stand, and this is the one that
   * survives the folding gate.
   */
  const euclid = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  const HALO = 32;
  // Colours the artwork itself carries at this budget, deduped at HALO — see above.
  const floors = { [EXEMPLAR_COLORS]: 5 };
  /**
   * What the quantizer itself finds before any fold, measured on this artwork.
   * Pinned per budget rather than as `min(colorCount, 16)`: this is flat
   * clipart with a handful of colour families, so demanding sixteen clusters
   * from it would be demanding the quantizer invent them.
   */
  const clusterFloors = { 6: 5, 8: 6, 12: 10, 16: 12 };

  const delivered = [];
  for (const colorCount of [6, 8, 12, 16]) {
    const r = await engine.vectorize(foxIn, { ...S, colorCount });
    delivered.push({ colorCount, n: r.palette.length, source: r.sourceColors });

    let closest = Infinity;
    let pair = '';
    for (let i = 0; i < r.palette.length; i++) {
      for (let j = i + 1; j < r.palette.length; j++) {
        const d = euclid(r.palette[i], r.palette[j]);
        if (d < closest) {
          closest = d;
          pair = `rgb(${r.palette[i].r},${r.palette[i].g},${r.palette[i].b}) / ` +
            `rgb(${r.palette[j].r},${r.palette[j].g},${r.palette[j].b})`;
        }
      }
    }
    assert.ok(
      r.palette.length >= Math.min(colorCount, r.sourceColors) - 1 || closest > HALO,
      `at ${colorCount} colours the palette both fell short (${r.palette.length} of ` +
        `${r.sourceColors} found) AND shipped a near-duplicate pair ${pair} ${closest.toFixed(1)} ` +
        'apart — a fold is only allowed to cost a colour when it removes a duplicate',
    );
    assert.ok(
      r.sourceColors >= clusterFloors[colorCount],
      `the quantizer only found ${r.sourceColors} clusters for a ${colorCount}-colour request ` +
        `where it found ${clusterFloors[colorCount]} when this bar was measured — the shortfall ` +
        'starts before the folds, which is a different bug from the one this check is about',
    );
    const floor = floors[colorCount];
    if (floor !== undefined) {
      assert.ok(
        r.palette.length >= floor,
        `at ${colorCount} colours we deliver ${r.palette.length} output groups where the real ` +
          `product's own capture of this image delivers ${floor} distinguishable ones`,
      );
    }
  }

  for (let i = 1; i < delivered.length; i++) {
    assert.ok(
      delivered[i].n >= delivered[i - 1].n,
      `asking for more colours delivered fewer: ${JSON.stringify(delivered)}`,
    );
  }
});

test('[B3] the fold that costs the colours is one the user can turn off', async () => {
  /**
   * The check above settles how MANY colours a budget has to buy. This one
   * settles whether the customer has a say.
   *
   * Ask for a budget with Enhance on and fewer come back: the panel's own hint
   * says so ("5 colours in the result — 6 were found and the cleanup settings
   * merged the rest") and `data-shortfall` blames the settings rather than the
   * image, which is honest. The problem is the next click. The only cleanup
   * control that speaks about colour groups is MERGE THRESHOLD, and
   * `src/engine/index.ts` used to compute
   *
   *     groupThreshold = max(opts.mergeThreshold, opts.enhance ? 1 : 0)
   *
   * so with Enhance on, dragging that control to 0 changed nothing at all —
   * the sub-1 % fold was unreachable from the panel and the shortfall the hint
   * attributes to "the cleanup settings" was not, in fact, a setting. Two
   * configurations of the same request delivered different counts, and no
   * surface in the product explained why.
   *
   * The bar is deliberately not "every colour requested": it is that turning
   * the control off reaches at least what turning ENHANCE off already reaches
   * on this same image (measured, in `artifacts/metrics.json` under
   * `reference-fox-default`, which is the Enhance-off configuration here).
   * Either fix satisfies it: let `mergeThreshold` override the Enhance floor,
   * or expose the floor as its own control and make THAT one reversible. What
   * is not allowed is a documented cleanup with no off switch.
   *
   * HOW IT WAS FIXED, and why this reads the way it does now. The `max(...)`
   * went away entirely: `groupThreshold` is `opts.mergeThreshold`, full stop,
   * and Enhance deals with quantization debris by raising the *area* floors
   * instead — a colour that only ever appears in 15×15 scraps loses the scraps
   * on the picture, not its seat in the palette. So the original phrasing ("the
   * default folds, mergeThreshold: 0 unfolds") can no longer be written down:
   * `DEFAULT_SETTINGS.mergeThreshold` IS 0, so `{...S, enhance: true}` and the
   * same object with `mergeThreshold: 0` are byte-identical requests and no
   * engine can distinguish them. The three properties the check is actually
   * about all survive, and are what is asserted below:
   *
   *   1. the default configuration folds nothing a control cannot reach — it
   *      delivers at least what turning Enhance off delivers;
   *   2. the merge threshold, moved off 0, observably folds (that is the
   *      "documented cleanup" now, and it has an off switch by construction);
   *   3. the colours that come back are colours, not near-duplicate creams.
   */
  const dflt = await engine.vectorize(foxIn, { ...S, colorCount: EXEMPLAR_COLORS, enhance: true });
  const merged = await engine.vectorize(foxIn, {
    ...S,
    colorCount: EXEMPLAR_COLORS,
    enhance: true,
    mergeThreshold: 5,
  });
  const enhanceOff = await engine.vectorize(foxIn, { ...S, colorCount: EXEMPLAR_COLORS, enhance: false });

  assert.ok(
    dflt.palette.length >= enhanceOff.palette.length,
    `Enhance on delivers ${dflt.palette.length} colours where Enhance off delivers ` +
      `${enhanceOff.palette.length} on the same ${dflt.sourceColors}-colour image — the user has ` +
      'to abandon the whole cleanup bundle to get colours back',
  );
  assert.ok(
    merged.palette.length < dflt.palette.length,
    `the merge threshold moved from 0 to 5 % and the palette stayed at ` +
      `${merged.palette.length} — the control the hint blames does nothing`,
  );
  // ...and the colours have to be colours. `maxNearDuplicateFills: 0` is the
  // standing guard against buying a palette back with near-identical creams.
  assert.equal(
    nearDuplicateFillPairs(dflt.svg),
    0,
    'the colours the default configuration keeps are near-duplicates of one another',
  );
});

// --- B4: noise reduction / anti-aliasing ------------------------------------

test('[B4] the default pipeline keeps every colour family the image has', async () => {
  /**
   * The blocker Smart anti-aliasing (the DEFAULT) can cause on real artwork: a
   * whole *hue* disappears. The failure this pins was measured on the retired
   * exemplar, where a warm brown paw pad (source rgb(164,143,125)) came back
   * rgb(103,150,167) — a light teal — because the delivered palette held three
   * blues and no brown, while `computePalette` had found the brown perfectly
   * well. The quantizer was not the culprit; the pre-trace ramp snapper was
   * (`src/engine/preprocess.ts` treated a wide smooth gradient as if it were a
   * 1px antialiasing ramp and collapsed its interior onto the extremes).
   *
   * The fox has the same shape of exposure: a DARK warm brown (the socks and
   * the ear linings, rgb(120,60,28)) that sits between a large orange body and
   * a black outline, and is exactly the family a ramp snapper collapses onto
   * its neighbours. Note the window — the body orange is warm too but far
   * lighter, so a bar written on "any warm colour" would be satisfied by the
   * one colour that can never be lost.
   *
   * A dark warm mid-tone is therefore something the delivered palette must
   * still contain, at the default settings and at a six-colour budget.
   */
  const luma = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const isWarmMidtone = (c) => c.r - c.b >= 40 && luma(c) >= 55 && luma(c) <= 120;
  const show = (list) => list.map((c) => `rgb(${c.r},${c.g},${c.b})`).join(' ');

  const candidates = await engine.computePalette(foxIn, 8);
  assert.ok(
    candidates.some(isWarmMidtone),
    `the quantizer itself found no dark warm mid-tone in [${show(candidates)}] — this check ` +
      'assumes the brown is in the image; if the fixture changed, change the check',
  );

  for (const colorCount of [S.colorCount, 6]) {
    const r = await engine.vectorize(foxIn, { ...S, colorCount });
    assert.ok(
      r.palette.some(isWarmMidtone),
      `at ${colorCount} colours the delivered palette [${show(r.palette)}] has no dark warm ` +
        `mid-tone, while computePalette finds [${show(candidates.filter(isWarmMidtone))}] — the ` +
        'paws and ear linings have nothing left to be painted with',
    );
  }
});


test('[B4] noise reduction has three levels, each quieter than the last', async () => {
  // Isolated from Smart anti-aliasing (`RAW`): both remove impulse noise, and
  // with the default on there is none left for this control to remove.
  const off = await runRaw(noisy, { noiseReduction: 'off' });
  const low = await runRaw(noisy, { noiseReduction: 'low' });
  const high = await runRaw(noisy, { noiseReduction: 'high' });
  assertDiffers(low.svg, off.svg, 'noiseReduction low === off');
  assertDiffers(high.svg, low.svg, 'noiseReduction high === low');
  assert.ok(countSubPaths(low.svg) <= countSubPaths(off.svg));
  assert.ok(countSubPaths(high.svg) <= countSubPaths(low.svg));
});

test('[B4] anti-aliasing suppresses near-duplicate halo layers', async () => {
  const off = await run(fox, { colorCount: EXEMPLAR_COLORS, antiAliasing: 'off' });
  const smart = await run(fox, { colorCount: EXEMPLAR_COLORS, antiAliasing: 'smart' });
  const mid = await run(fox, { colorCount: EXEMPLAR_COLORS, antiAliasing: 'mid' });
  assertDiffers(smart.svg, off.svg, 'antiAliasing smart === off');
  assertDiffers(mid.svg, smart.svg, 'antiAliasing mid === smart');
  assert.ok(
    nearDuplicateFillPairs(smart.svg) <= nearDuplicateFillPairs(off.svg),
    'Smart anti-aliasing must not add near-duplicate colour layers',
  );
});

test('[B4] an explicit anti-aliasing choice survives the Enhance bundle', async () => {
  /**
   * Enhance turns Smart anti-aliasing on internally, and it used to do it by
   * *ignoring* `settings.antiAliasing`: with Enhance ticked, `off` and `smart`
   * produced byte-identical documents and only `mid` differed. The UI still shows whatever the user chose, so "Anti-aliasing:
   * Off" with Enhance on tells the reader the opposite of what the engine did —
   * and the two are separate controls in the UI, so silently coupling them
   * makes the panel lie about the document it produced.
   *
   * Either the explicit value wins, or the renderer must stop offering it while
   * Enhance is on. The engine half of that choice is this contract.
   */
  const off = await run(fox, { colorCount: EXEMPLAR_COLORS, enhance: true, antiAliasing: 'off' });
  const smart = await run(fox, { colorCount: EXEMPLAR_COLORS, enhance: true, antiAliasing: 'smart' });
  assertDiffers(
    off.svg,
    smart.svg,
    'with Enhance on, antiAliasing "off" and "smart" produce the identical document — the ' +
      'control is dead and the UI reports a state the engine is not in',
  );
});

test('[B4] enhance cannot introduce a colour absent from the source', async () => {
  const r = await run(flat, { enhance: true });
  for (const c of r.palette) {
    assert.ok(
      FLAT_SOURCE_COLORS.includes(hexOfLayer(c)),
      `enhance invented ${hexOfLayer(c)} — the source has only ${FLAT_SOURCE_COLORS.join(', ')}`,
    );
  }
});

// --- B5: advanced vectorization --------------------------------------------

test('[B5] roundness has three levels and rounder means more curve', async () => {
  const results = [];
  for (const roundness of [0, 1, 2]) {
    const r = await run(flat, { roundness });
    results.push({ roundness, svg: r.svg, curve: curveCommandRatio(r.svg) });
  }
  assert.equal(new Set(results.map((r) => r.svg)).size, 3, 'each roundness level must differ');
  assert.ok(
    results[2].curve > results[0].curve,
    `roundness 2 fitted no more curve than 0 (${results[2].curve} vs ${results[0].curve})`,
  );
});

test('[B5] minimum area 0/5/90 px2 removes progressively larger specks', async () => {
  // Isolated from Smart anti-aliasing (`RAW`): the specks a minimum-area floor
  // is meant to drop are the ones the default cleanup has already dropped.
  const keep = await runRaw(noisy, { minArea: 0 });
  const min5 = await runRaw(noisy, { minArea: 5 });
  const min90 = await runRaw(noisy, { minArea: 90 });

  assertDiffers(min5.svg, keep.svg, 'minArea 5 === 0');
  assertDiffers(min90.svg, min5.svg, 'minArea 90 === 5');
  assert.ok(countSubPaths(min5.svg) < countSubPaths(keep.svg));
  assert.ok(countSubPaths(min90.svg) < countSubPaths(min5.svg));

  // The control is defined in px², so measure the shapes that survive.
  const areasUnder = (svg, limit) => {
    let n = 0;
    for (const d of pathDataAttributes(svg)) {
      for (const b of subPathBoxes(d)) {
        if (b.width * b.height < limit) n++;
      }
    }
    return n;
  };
  assert.equal(areasUnder(min5.svg, 5), 0, 'shapes under 5px2 survived Minimum Area 5');
  assert.equal(areasUnder(min90.svg, 90), 0, 'shapes under 90px2 survived Minimum Area 90');
});

test('[B5] overlap Full/High changes how layers stack', async () => {
  const full = await run(flat, { overlap: 'full' });
  const high = await run(flat, { overlap: 'high' });
  assertDiffers(full.svg, high.svg, 'overlap left the output unchanged');
  assert.ok(countSubPaths(high.svg) <= countSubPaths(full.svg));
});

test('[B5] circle detection changes round geometry', async () => {
  const off = await run(flat, { circleDetection: false });
  const on = await run(flat, { circleDetection: true });
  assertDiffers(on.svg, off.svg, 'circleDetection left the output unchanged');
  const circles = (on.svg.match(/<(circle|ellipse)\b/g) ?? []).length;
  assert.ok(
    circles > 0 || curveCommandRatio(on.svg) > curveCommandRatio(off.svg),
    'circle detection produced neither circles nor rounder paths',
  );
});

test('[B5] circle detection finds every circular contour, not just the outermost', async () => {
  /**
   * A detector that only accepts the outermost contour of a region is a demo,
   * not a feature: the cases it misses are the concentric one (a ring, whose
   * inner edge is a hole) and the nested one (a disc sitting inside another
   * colour's disc), which is most of what a logo is made of. Snapping them is
   * also what keeps a circle from being paid for as a few dozen Béziers.
   *
   * The artwork is built here rather than taken from `logo-flat-512.png`,
   * because that fixture does not contain the contours this check needs: it has
   * exactly ONE circular *shape*, the ink ring drawn last (both of whose edges
   * are found — they come out as a single stroked circle, one element for two
   * contours). Its navy disc is not a circular contour at all — the green bar
   * is drawn over the bottom of it, so the boundary is a truncated disc, and a
   * detector that called it a circle would be repainting the picture.
   * `scripts/generate-fixtures.mjs` draws it that way on purpose; measuring
   * circle detection there was measuring the wrong artwork.
   */
  const image = drawCircleArtwork();
  const on = await run(image, { circleDetection: true });
  const off = await run(image, { circleDetection: false });
  const circles = [...on.svg.matchAll(/<(?:circle|ellipse)\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(
    circles.length >= 3,
    `${circles.length} circular element(s) for a plain disc, a ring and a disc nested in a ` +
      `second ring — concentric and nested circles are not being recognised:\n${on.svg.slice(0, 400)}`,
  );
  // The ring cases prove the *hole* was recognised too: a stroked circle is
  // what an outer circle plus a concentric circular hole collapses into.
  assert.ok(
    circles.filter((c) => c.includes('stroke-width=')).length >= 2,
    `only ${circles.filter((c) => c.includes('stroke-width=')).length} of the two annuli came ` +
      'out as stroked circles — an inner (hole) contour is not being detected',
  );
  assert.ok(
    countSubPaths(on.svg) < countSubPaths(off.svg),
    'snapping a circle must cost fewer sub-paths than fitting Béziers round it',
  );
});

test('[B5] circle detection works at every size, not just the big obvious one', async () => {
  /**
   * "Is this a feature or a demo?" is answered by scale, not by one hit: a
   * detector tuned to one radius, or one that only fires on the biggest shape
   * in the picture, is a demo. Six discs spanning a 10× range of radii are
   * traced in one pass here, and every one of them has to come back as a
   * `<circle>` with the radius and centre it was drawn at (within the fit
   * tolerance), not merely as "some circles were found".
   */
  const radii = [4, 6, 10, 16, 24, 40];
  const width = 640;
  const height = 160;
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, [242, 239, 230]);
  const centres = radii.map((r, i) => ({ r, cx: 60 + i * 100, cy: 80 }));
  for (const { r, cx, cy } of centres) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) put(x, y, [27, 58, 92]);
      }
    }
  }

  const on = await run({ width, height, data }, { circleDetection: true });
  const found = [...on.svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(
    (m) => ({ cx: Number(m[1]), cy: Number(m[2]), r: Number(m[3]) }),
  );
  for (const want of centres) {
    const hit = found.find((c) => Math.hypot(c.cx - want.cx, c.cy - want.cy) < 2);
    assert.ok(
      hit,
      `the r=${want.r} disc at (${want.cx},${want.cy}) was not recognised as a circle — ` +
        `found ${JSON.stringify(found)}`,
    );
    assert.ok(
      Math.abs(hit.r - want.r) <= 1.5,
      `the r=${want.r} disc came back as r=${hit.r} — the snapped circle is not the drawn one`,
    );
  }
});

test('[B5] circle detection does not round off shapes that are not circles', async () => {
  /**
   * The other half of the feature, and the half a keen detector gets wrong:
   * `logo-flat-512.png` has exactly ONE circular shape — the ink ring, whose
   * two edges collapse into a single stroked `<circle>`. Its navy disc looks
   * round in a thumbnail but the green bar is painted across the bottom of it
   * and the orange triangle sits inside it, so its contour is a truncated disc
   * (`scripts/generate-fixtures.mjs` draws it that way deliberately). Snapping
   * that to a circle would repaint the artwork, so "1 circle here" is the
   * correct reading of this fixture, and this test pins it — including the
   * ring's measured geometry, so a detector that finds a circle in the wrong
   * place cannot pass by counting.
   */
  const on = await run(flat, { circleDetection: true });
  const circles = [...on.svg.matchAll(/<circle[^>]*>/g)].map((m) => m[0]);
  assert.equal(
    circles.length,
    1,
    `expected exactly the ink ring; got ${circles.length}:\n${circles.join('\n')}`,
  );
  const [, cx, cy, r, strokeWidth] =
    /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"[^>]*stroke-width="([\d.]+)"/.exec(
      circles[0],
    ) ?? [];
  assert.ok(strokeWidth, `the ring must be a stroked circle, not a filled one: ${circles[0]}`);
  // Drawn as ring(256, 232, outer 190, inner 172): mid-radius 181, width 18.
  assert.ok(Math.abs(Number(cx) - 256) < 2 && Math.abs(Number(cy) - 232) < 2, `centre ${cx},${cy}`);
  assert.ok(Math.abs(Number(r) - 181) < 2, `mid-radius ${r}, expected ~181`);
  assert.ok(Math.abs(Number(strokeWidth) - 18) < 2, `ring width ${strokeWidth}, expected ~18`);
});

/**
 * 512x256 of flat artwork whose every shape boundary is exactly circular, drawn
 * without antialiasing so the contours are exact:
 *   - a filled navy disc (the plain case),
 *   - an ink ring on paper (concentric: outer edge + circular hole),
 *   - an orange disc inside a green disc (nested: the green layer is a ring
 *     whose hole is a different colour's outer edge).
 */
function drawCircleArtwork() {
  const width = 512;
  const height = 256;
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const paper = [242, 239, 230];
  const navy = [27, 58, 92];
  const ink = [43, 43, 43];
  const green = [46, 158, 91];
  const orange = [228, 87, 46];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, paper);
  const disc = (cx, cy, radius, color) => {
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y++) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= radius * radius) put(x, y, color);
      }
    }
  };
  disc(100, 128, 62, navy);
  disc(256, 128, 70, ink);
  disc(256, 128, 45, paper);
  disc(412, 128, 70, green);
  disc(412, 128, 40, orange);
  return { width, height, data };
}

// --- B6: result styles ------------------------------------------------------

test('[B6] the stroked result style outlines every layer instead of filling it', async () => {
  const filled = await run(flat, { resultStyle: 'filled' });
  const stroked = await run(flat, { resultStyle: 'stroked' });

  assertDiffers(filled.svg, stroked.svg, 'resultStyle left the output unchanged');
  const strokes = [...stroked.svg.matchAll(/<g[^>]*\bstroke="([^"]+)"/g)].map((m) =>
    m[1].toLowerCase(),
  );
  assert.ok(strokes.length > 1, 'stroked layers must carry a stroke colour');
  assert.match(stroked.svg, /<g[^>]*fill="none"/);
  assert.match(stroked.svg, /stroke-width="/);
});

// --- D1: document structure -------------------------------------------------

test('[D1] colour layers use rgb(r,g,b) notation, which every editor parses', async () => {
  const r = await run(flat, {});
  const groups = [...r.svg.matchAll(/<g[^>]*\bfill="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(groups.length > 1, 'expected several colour layers');
  for (const fill of groups) {
    assert.match(
      fill,
      /^rgb\(\d{1,3}, ?\d{1,3}, ?\d{1,3}\)$/,
      `REFERENCE D1 documents rgb(...) layer fills; got ${fill}`,
    );
  }
});

// --- D3: DXF colour fidelity ------------------------------------------------

test('[D3] every palette colour gets its own DXF layer colour', async () => {
  const r = await run(flat, {});
  const dxf = engine.toDxf(r);

  // LAYER records: name (group 2) followed by colour number (group 62).
  const layers = [...dxf.matchAll(/\n\s*2\n(C_[0-9A-Fa-f]{6})\n[\s\S]{0,40}?\n\s*62\n\s*(-?\d+)/g)];
  assert.ok(layers.length >= r.palette.length, 'every palette colour needs a DXF layer');

  const byAci = new Map();
  for (const [, name, aci] of layers) {
    const existing = byAci.get(aci);
    assert.ok(
      !existing || existing === name,
      `DXF layers ${existing} and ${name} share colour index ${aci} — indistinguishable in CAD`,
    );
    byAci.set(aci, name);
  }

  // A saturated colour must never fall through to the 250-255 grey ramp.
  for (const [, name, aci] of layers) {
    const rgb = {
      r: parseInt(name.slice(2, 4), 16),
      g: parseInt(name.slice(4, 6), 16),
      b: parseInt(name.slice(6, 8), 16),
    };
    const chroma = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
    if (chroma > 60) {
      assert.ok(
        Number(aci) < 250,
        `${name} is saturated (chroma ${chroma}) but was mapped onto grey ACI ${aci}`,
      );
    }
  }
});

test('[D3] curved outlines survive the DXF as curves, not as thousands of vertices', async () => {
  /**
   * REFERENCE E lists "DXF lines-vs-splines variants" as a stretch feature, but
   * the *default* being a flattened polyline soup is a D3 problem on its own:
   * the curve fitting the SVG paid for is thrown away at the door, and the file
   * balloons. Measured on the gold-standard artwork the DXF was 1.49 MB of
   * POLYLINE/VERTEX against a 71 KB SVG — 21x — while the EPS of the same
   * drawing kept real `curveto` geometry in 124 KB. It is 55 KB of SPLINE
   * against a 24 KB EPS today.
   *
   * The contract: a drawing whose SVG is mostly curves must carry SPLINE
   * entities, and the DXF must stay in the same order of magnitude as the EPS.
   */
  const r = await run(fox, { colorCount: EXEMPLAR_COLORS, enhance: true });
  const dxf = engine.toDxf(r);
  const eps = engine.toEps(r);

  const splines = (dxf.match(/\n\s*0\nSPLINE\b/g) ?? []).length;
  const vertices = (dxf.match(/\n\s*0\nVERTEX\b/g) ?? []).length;
  assert.ok(
    splines > 0,
    `${vertices} VERTEX entities and no SPLINE: the SVG is ${(curveCommandRatio(r.svg) * 100).toFixed(0)}% ` +
      'curve commands and every one of them was flattened to line segments',
  );
  assert.ok(
    dxf.length <= eps.length * 3,
    `DXF ${(dxf.length / 1024).toFixed(0)} KB vs EPS ${(eps.length / 1024).toFixed(0)} KB for the ` +
      'same drawing — the DXF is paying per vertex for geometry the EPS stores as curves',
  );
});
