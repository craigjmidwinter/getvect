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

import { decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';
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
 * `DEFAULT_SETTINGS` ships Smart anti-aliasing on (the real product does too —
 * fixtures/reference/OBSERVED-UI.md — and it is what keeps the default output
 * economical). Its index-image majority pass is also a very effective impulse
 * remover, so on the speckled fixture the noise-removal controls have nothing
 * left to remove and cannot be observed at all. Checks that ask "does THIS
 * control do something" isolate it here; checks about the shipped configuration
 * use `S`.
 */
const RAW = { ...S, antiAliasing: 'off' };

const flat = await load('logo-flat-512.png');
const noisy = await load('logo-noisy-512.png');
const artwork = await load('reference/artwork.png');

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

// --- B4: noise reduction / anti-aliasing ------------------------------------

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
  const off = await run(artwork, { colorCount: 16, antiAliasing: 'off' });
  const smart = await run(artwork, { colorCount: 16, antiAliasing: 'smart' });
  const mid = await run(artwork, { colorCount: 16, antiAliasing: 'mid' });
  assertDiffers(smart.svg, off.svg, 'antiAliasing smart === off');
  assertDiffers(mid.svg, smart.svg, 'antiAliasing mid === smart');
  assert.ok(
    nearDuplicateFillPairs(smart.svg) <= nearDuplicateFillPairs(off.svg),
    'Smart anti-aliasing must not add near-duplicate colour layers',
  );
});

test('[B4] an explicit anti-aliasing choice survives the Enhance bundle', async () => {
  /**
   * Enhance turns Smart anti-aliasing on internally, and it does it by
   * *ignoring* `settings.antiAliasing`: with Enhance ticked, `off` and `smart`
   * produce byte-identical documents (md5 941885e0, 71 KB each) and only `mid`
   * differs. The UI still shows whatever the user chose, so "Anti-aliasing:
   * Off" with Enhance on tells the reader the opposite of what the engine did —
   * and `fixtures/reference/OBSERVED-UI.md` step ③ records the real product
   * exposing Enhance and Anti-aliasing as independent controls.
   *
   * Either the explicit value wins, or the renderer must stop offering it while
   * Enhance is on. The engine half of that choice is this contract.
   */
  const off = await run(artwork, { colorCount: 16, enhance: true, antiAliasing: 'off' });
  const smart = await run(artwork, { colorCount: 16, enhance: true, antiAliasing: 'smart' });
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

test('[D1] colour layers use the rgb(r,g,b) notation the reference product emits', async () => {
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
   * drawing kept real `curveto` geometry in 124 KB.
   *
   * The contract: a drawing whose SVG is mostly curves must carry SPLINE
   * entities, and the DXF must stay in the same order of magnitude as the EPS.
   */
  const r = await run(artwork, { colorCount: 16, enhance: true });
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
