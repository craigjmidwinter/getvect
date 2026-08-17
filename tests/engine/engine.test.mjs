/**
 * Engine contract tests — `npm run test:engine`.
 *
 * Pure Node (`node --test`), no Electron and no browser: this exercises
 * `dist/engine/index.js` directly, the same way the instruments harness and the
 * renderer's worker do.
 *
 * These cover the obligations that the fidelity instruments cannot see —
 * determinism, the meaning of each setting, the palette-override semantics that
 * drive the palette editor, and the structural validity of the EPS/DXF writers.
 * `npm run instruments` measures how *good* the output looks; this asserts that
 * it is the output the rest of the app is entitled to expect.
 *
 * Run `npm run build:node` first (the `pretest:engine` script does it for you).
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const engine = require(join(root, 'dist/engine/index.js'));
const fixture = (name) => join(root, 'fixtures', name);

const load = async (name) => flattenOnWhite(await decodeImageFile(fixture(name)));
const S = engine.DEFAULT_SETTINGS;

/**
 * Defaults with every optional cleanup off.
 *
 * `DEFAULT_SETTINGS` ships Smart anti-aliasing on (the reference product does too —
 * fixtures/reference/ARTWORK.md — and it is what keeps the default output
 * economical). Its index-image majority pass is also a very effective impulse
 * remover, so on the speckled fixture the noise-removal controls have nothing
 * left to remove and cannot be observed at all. Checks that ask "does THIS
 * control do something" isolate it here; checks about the shipped configuration
 * use `S`.
 */
const RAW = { ...S, antiAliasing: 'off' };

const flat = await load('logo-flat-512.png');
const noisy = await load('logo-noisy-512.png');
const big = await load('logo-flat-1024.png');

/**
 * Distinct paint colours in a document, as `#rrggbb`.
 *
 * Notation-agnostic on purpose: REFERENCE D1 documents `rgb(r, g, b)` layer
 * fills (and the engine writes them), while the palette API speaks hex. An
 * assertion about *which colours* are in the picture must not quietly become an
 * assertion about spelling — a hex-only matcher would let "the removed colour is
 * gone" pass on a document where it is still there under another notation.
 */
const fillsIn = (svg) => {
  const set = new Set();
  for (const m of svg.matchAll(/fill="([^"]+)"/g)) {
    const hex = normalizeColor(m[1]);
    if (hex) set.add(hex);
  }
  return set;
};

const normalizeColor = (value) => {
  const v = String(value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (!rgb) return null;
  return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
};

/** True when `hex` is painted anywhere in the document, in either notation. */
const paints = (svg, hex) => fillsIn(svg).has(String(hex).toLowerCase());

test('vectorize is deterministic', async () => {
  const a = await engine.vectorize(flat, S);
  const b = await engine.vectorize(flat, S);
  assert.equal(a.svg, b.svg, 'same input must give a byte-identical SVG');
  const c = await engine.vectorize(noisy, S);
  const d = await engine.vectorize(noisy, S);
  assert.equal(c.svg, d.svg);
});

test('vectorize returns a standalone SVG with the source viewBox', async () => {
  const r = await engine.vectorize(flat, S);
  assert.match(r.svg, /^<svg[\s>]/);
  assert.match(r.svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(r.svg, /viewBox="0 0 512 512"/);
  assert.ok(r.svg.endsWith('</svg>'));
  assert.equal(r.width, 512);
  assert.equal(r.height, 512);
  assert.equal(r.pathCount, (r.svg.match(/<path\b/g) ?? []).length);
});

test('vectorize rejects a raster whose buffer is too small', async () => {
  await assert.rejects(
    () => engine.vectorize({ width: 8, height: 8, data: new Uint8ClampedArray(16) }, S),
    /RGBA bytes/,
  );
});

test('progress reaches every phase and never goes backwards', async () => {
  const seen = [];
  let previous = -1;
  await engine.vectorize(flat, S, (p) => {
    seen.push(p.phase);
    assert.ok(p.progress >= previous, `progress went backwards at ${p.phase}`);
    previous = p.progress;
  });
  for (const phase of ['preprocess', 'quantize', 'simplify', 'trace', 'serialize', 'done']) {
    assert.ok(seen.includes(phase), `missing phase ${phase}`);
  }
});

test('a broken progress callback cannot fail a vectorization', async () => {
  const r = await engine.vectorize(flat, S, () => {
    throw new Error('boom');
  });
  assert.match(r.svg, /<path/);
});

test('a 1024x1024 image vectorizes well under the 10s budget', async () => {
  const started = Date.now();
  await engine.vectorize(big, S);
  assert.ok(Date.now() - started < 10_000);
});

test('each setting observably changes the output', async () => {
  // Necessary but NOT sufficient: a byte difference can be a geometry change no
  // pixel can see. tests/engine/rendered.test.mjs rasterizes both sides and
  // requires the picture itself to move.
  //
  // Measured with the OTHER cleanups off (`RAW`), because a control can only be
  // observed where it has something to do: Smart anti-aliasing is on by default
  // and its index-image majority pass already removes single-pixel impulses, so
  // on the speckled fixture the despeckle slider was being asked to remove
  // specks that no longer existed. That is a fact about the default bundle, not
  // about the control — `[B4] anti-aliasing suppresses near-duplicate halo
  // layers` is where the default's own effect is asserted.
  const cases = [
    ['colorCount', 8, 3],
    ['detail', 60, 5],
    ['smoothing', 50, 100],
    ['despeckle', 20, 90],
  ];
  for (const [key, from, to] of cases) {
    const a = await engine.vectorize(noisy, { ...RAW, [key]: from });
    const b = await engine.vectorize(noisy, { ...RAW, [key]: to });
    assert.notEqual(a.svg, b.svg, `${key} ${from} -> ${to} left the SVG unchanged`);
  }
});

test('colorCount bounds the number of distinct fills', async () => {
  for (const colorCount of [2, 3, 6]) {
    const r = await engine.vectorize(flat, { ...S, colorCount });
    assert.ok(
      fillsIn(r.svg).size <= colorCount,
      `colorCount ${colorCount} produced ${fillsIn(r.svg).size} fills`,
    );
    assert.ok(r.palette.length <= colorCount);
  }
});

test('settings are clamped rather than trusted', async () => {
  const r = await engine.vectorize(flat, {
    ...S,
    colorCount: 999,
    detail: -50,
    smoothing: 900,
    despeckle: Number.NaN,
  });
  assert.match(r.svg, /<svg/);
  assert.ok(r.palette.length <= 64);
});

test('the computed palette is ordered by descending coverage', async () => {
  const r = await engine.vectorize(flat, S);
  assert.ok(r.palette.length >= 2);
  // The flat fixture is drawn without antialiasing from exactly six colours,
  // and paper is the most common of them.
  assert.equal(r.palette.length, 6);
  assert.equal(engine.hexOf(r.palette[0]), '#f2efe6');
  for (const c of r.palette) {
    assert.match(engine.hexOf(c), /^#[0-9a-f]{6}$/);
  }
});

test('computePalette agrees with what vectorize used', async () => {
  const palette = await engine.computePalette(flat, 8);
  const r = await engine.vectorize(flat, S);
  assert.deepEqual(palette.map(engine.hexOf), r.palette.map(engine.hexOf));
});

test('palette override: changing a colour repaints its region', async () => {
  const base = await engine.vectorize(flat, S);
  const palette = base.palette.map((c, i) => (i === 0 ? { r: 255, g: 0, b: 255 } : c));
  const r = await engine.vectorize(flat, { ...S, palette });
  assert.ok(paints(r.svg, '#ff00ff'), 'the new colour must appear in the output');
  assert.equal(r.palette.length, base.palette.length, 'palette length must be stable');
  assert.equal(engine.hexOf(r.palette[0]), '#ff00ff');
});

test('palette override: removing a colour drops it from the output', async () => {
  const base = await engine.vectorize(flat, S);
  const removed = engine.hexOf(base.palette[1]);
  const palette = base.palette.filter((_, i) => i !== 1);
  const r = await engine.vectorize(flat, { ...S, palette });
  assert.equal(r.palette.length, base.palette.length - 1);
  assert.ok(!paints(r.svg, removed), `removed colour ${removed} still appears in the SVG`);
});

test('palette override: merging two colours collapses them', async () => {
  const base = await engine.vectorize(flat, S);
  const merged = engine.hexOf(base.palette[1]);
  // "Merge 1 into 0" is expressed as the palette without entry 1.
  const r = await engine.vectorize(flat, { ...S, palette: base.palette.filter((_, i) => i !== 1) });
  assert.equal(r.palette.length, base.palette.length - 1);
  assert.ok(!paints(r.svg, merged), `merged colour ${merged} still appears in the SVG`);
});

test('palette override ignores duplicates and malformed entries', async () => {
  const palette = [
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 300, g: -20, b: 12.6 },
    null,
  ];
  const r = await engine.vectorize(flat, { ...S, palette });
  assert.deepEqual(r.palette.map(engine.hexOf), ['#000000', '#ff000d']);
});

test('enhance denoises: same picture, simpler geometry', async () => {
  const off = await engine.vectorize(noisy, { ...S, enhance: false });
  const on = await engine.vectorize(noisy, { ...S, enhance: true });
  assert.notEqual(on.svg, off.svg);
  assert.ok(on.pathCount <= off.pathCount, 'denoising must not make the trace busier');
  assert.ok(on.svg.length < off.svg.length, 'denoising must not make the SVG bigger');
});

test('enhanceImage is pure and shape-preserving', async () => {
  const before = flat.data.slice(0, 64);
  const out = await engine.enhanceImage(flat);
  assert.equal(out.width, flat.width);
  assert.equal(out.height, flat.height);
  assert.equal(out.data.length, flat.data.length);
  assert.deepEqual(flat.data.slice(0, 64), before, 'the input must not be mutated');
});

test('EPS export is structurally valid PostScript', async () => {
  const r = await engine.vectorize(flat, S);
  const eps = engine.toEps(r);
  assert.match(eps, /^%!PS-Adobe-3\.0 EPSF-3\.0/);
  const bbox = /%%BoundingBox:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(eps);
  assert.ok(bbox, 'EPS must declare a %%BoundingBox');
  assert.equal(Number(bbox[3]) - Number(bbox[1]), 512);
  assert.equal(Number(bbox[4]) - Number(bbox[2]), 512);
  assert.match(eps, /\beofill\b/);
  assert.ok((eps.match(/\bmoveto\b/g) ?? []).length > 0);
  assert.match(eps, /%%EOF/);
  // Deterministic: no timestamps, no run-dependent content.
  assert.equal(eps, engine.toEps(await engine.vectorize(flat, S)));
});

test('DXF export is a well-formed drawing in both curve variants', async () => {
  // The reference product offers "DXF (splines)" and "DXF (lines)" as separate
  // downloads (fixtures/reference/ARTWORK.md), and they are different
  // dialects: SPLINE is an R13+ entity, so the spline variant declares R2000
  // (AC1015) and carries handles, while the lines variant stays pure R12
  // (AC1009) for readers — old CAD, cutters — that only implement POLYLINE.
  const r = await engine.vectorize(flat, S);
  const variants = [
    { name: 'splines (default)', dxf: engine.toDxf(r), version: 'AC1015' },
    { name: 'lines', dxf: engine.toDxf(r, { curves: 'lines' }), version: 'AC1009' },
  ];
  assert.notEqual(variants[0].dxf, variants[1].dxf, 'the two variants must differ');

  for (const { name, dxf, version } of variants) {
    for (const token of ['SECTION', 'HEADER', '$EXTMIN', '$EXTMAX', 'ENTITIES', 'ENDSEC']) {
      assert.ok(dxf.includes(token), `${name}: DXF is missing ${token}`);
    }
    assert.ok(dxf.trimEnd().endsWith('EOF'), `${name}: DXF must end with EOF`);
    assert.match(dxf, new RegExp(`\\b${version}\\b`), `${name}: wrong $ACADVER`);
    // The flat fixture is drawn from rectangles as well as discs, so a
    // rectilinear POLYLINE has to survive whatever the curve variant is —
    // nothing straight may be re-described as a curve.
    assert.ok((dxf.match(/\bPOLYLINE\b/g) ?? []).length > 0, `${name}: no POLYLINE`);

    // Group codes and values must pair up, and every code must be an integer.
    const lines = dxf.split('\n').slice(0, -1);
    assert.equal(lines.length % 2, 0, `${name}: group codes and values must pair up`);
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i], /^-?\d+$/, `${name}: bad group code at line ${i + 1}: ${lines[i]}`);
    }

    // Extents must describe the artwork, not sit at the origin.
    const extmax = /\$EXTMAX\n10\n(-?[\d.]+)\n20\n(-?[\d.]+)/.exec(dxf);
    assert.ok(extmax, `${name}: $EXTMAX must carry x/y`);
    assert.ok(Number(extmax[1]) > 0 && Number(extmax[2]) > 0);
    assert.ok(Number(extmax[1]) <= 512 && Number(extmax[2]) <= 512);
  }

  // Every SPLINE has to be internally consistent: degree 3, and the knot count
  // the format demands (control points + degree + 1). A reader that checks will
  // reject the file otherwise, and one that does not will draw nonsense.
  // Walk group-code pairs rather than pattern-matching text: a *value* of "0"
  // looks exactly like the entity-start code 0 to a regular expression.
  const pairs = [];
  const all = variants[0].dxf.split('\n').slice(0, -1);
  for (let i = 0; i < all.length; i += 2) pairs.push([Number(all[i]), all[i + 1]]);
  const entities = [];
  for (const [code, value] of pairs) {
    if (code === 0) entities.push({ type: value, codes: [] });
    else entities[entities.length - 1]?.codes.push([code, value]);
  }
  const splines = entities.filter((e) => e.type === 'SPLINE');
  assert.ok(splines.length > 0, 'the spline variant must carry SPLINE entities');
  for (const entity of splines) {
    const first = (c) => Number(entity.codes.find(([code]) => code === c)?.[1]);
    const count = (c) => entity.codes.filter(([code]) => code === c).length;
    assert.equal(first(71), 3, 'splines must be degree 3');
    assert.equal(first(72), count(40), 'declared knot count must match the knots present');
    assert.equal(first(73), count(10), 'declared control count must match the points present');
    assert.equal(count(40), count(10) + 4, 'knots must be controls + degree + 1');
  }
});

test('PDF export is a well-formed one-page vector document', async () => {
  const r = await engine.vectorize(flat, S);
  const pdf = engine.toPdf(r);
  assert.match(pdf, /^%PDF-1\.\d/);
  assert.ok(pdf.includes('/Type /Catalog'));
  assert.ok(pdf.includes('/MediaBox [0 0 512 512]'));
  assert.match(pdf, /\bf\*|\bB\*/);
  assert.ok((pdf.match(/^[-\d.]+ [-\d.]+ m$/gm) ?? []).length > 0);
  assert.ok(pdf.trimEnd().endsWith('%%EOF'));

  // The xref offset has to be a byte offset into this very file.
  const startxref = /startxref\s+(\d+)/.exec(pdf);
  assert.ok(startxref, 'PDF must declare startxref');
  assert.equal(Buffer.from(pdf, 'utf8').slice(Number(startxref[1]), Number(startxref[1]) + 4).toString(), 'xref');
  // ...and each object offset must land on that object's header.
  const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((offset, i) => {
    assert.match(pdf.slice(offset, offset + 8), new RegExp(`^${i + 1} 0 obj`));
  });

  // Deterministic: no wall-clock timestamp leaks into the output.
  assert.equal(pdf, engine.toPdf(await engine.vectorize(flat, S)));
});

test('serialize dispatches to the right writer', async () => {
  const r = await engine.vectorize(flat, S);
  assert.equal(engine.serialize(r, 'svg'), r.svg);
  assert.equal(engine.serialize(r, 'eps'), engine.toEps(r));
  assert.equal(engine.serialize(r, 'dxf'), engine.toDxf(r));
  assert.equal(engine.serialize(r, 'pdf'), engine.toPdf(r));
  // PNG is a raster: the engine has no renderer, so it is not serializable here
  // (the app rasterizes the SVG instead — src/renderer/lib/raster.ts).
  assert.throws(() => engine.serialize(r, 'png'), /Unknown export format/);
  assert.throws(() => engine.serialize(r, 'stl'), /Unknown export format/);
});

test('the SVG groups paths into one <g fill> layer per colour', async () => {
  const r = await engine.vectorize(flat, S);
  // Notation-agnostic: REFERENCE D1 documents `rgb(r,g,b)` layer fills and
  // tests/engine/parity.test.mjs asserts that form; the grouping rule below
  // holds either way.
  const groups = [...r.svg.matchAll(/<g[^>]*\bfill="(#[0-9a-f]{6}|rgb\([^)]*\))"/g)].map(
    (m) => m[1],
  );
  assert.ok(groups.length > 1, 'expected several colour layers');
  assert.equal(new Set(groups).size, groups.length, 'each colour gets exactly one group');
  assert.ok(!/<path[^>]*\bfill="/.test(r.svg), 'paths inherit their fill from the group');
  // Grouping must not change what the converters see.
  assert.ok((engine.toEps(r).match(/\bsetrgbcolor\b/g) ?? []).length >= groups.length);
});

test('input support check accepts the documented formats only', () => {
  for (const ok of ['a.png', 'B.JPG', 'c.jpeg', 'd.bmp', 'image/png', 'image/bmp']) {
    assert.ok(engine.isSupportedInput(ok), `${ok} should be supported`);
  }
  for (const bad of ['a.gif', 'notes.txt', 'image/gif', 'x.webp', 'y.svg']) {
    assert.ok(!engine.isSupportedInput(bad), `${bad} should be rejected`);
  }
});

test('a single-colour palette override still paints every pixel', async () => {
  const r = await engine.vectorize(flat, { ...S, palette: [{ r: 10, g: 20, b: 30 }] });
  assert.deepEqual(r.palette.map(engine.hexOf), ['#0a141e']);
  assert.deepEqual([...fillsIn(r.svg)], ['#0a141e']);
});

// --- the pre-fit boundary low-pass -----------------------------------------

const fit = require(join(root, 'dist/engine/fit.js'));

test('the boundary low-pass removes a sawtooth without moving the boundary far', () => {
  /**
   * `lowPassClosed` is what takes the wobble out of a colour seam before the
   * curve fitter is allowed to reproduce it (src/engine/fit.ts). Two properties
   * make it safe to run on artwork rather than on a test pattern, and both are
   * asserted here on a 200x40 bar whose long edges carry a ±2px sawtooth:
   *   1. the sawtooth's amplitude collapses,
   *   2. no vertex moves further than `maxShift`, whatever the kernel wants —
   *      which is what lets callers scale the licence down by a thin shape's
   *      own thickness instead of trusting the filter.
   */
  const ring = [];
  for (let x = 0; x < 200; x++) ring.push({ x, y: (x % 4 < 2 ? 0 : 2) });
  for (let y = 0; y <= 40; y++) ring.push({ x: 200, y });
  for (let x = 200; x >= 0; x--) ring.push({ x, y: 40 + (x % 4 < 2 ? 0 : 2) });
  for (let y = 40; y >= 0; y--) ring.push({ x: 0, y });

  const smoothed = fit.lowPassClosed(ring, null, 6, 1.5);
  const swing = (pts) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 20; i < 180; i++) {
      lo = Math.min(lo, pts[i].y);
      hi = Math.max(hi, pts[i].y);
    }
    return hi - lo;
  };
  assert.ok(
    swing(smoothed) < swing(ring) * 0.4,
    `the sawtooth still swings ${swing(smoothed).toFixed(2)}px of the original ` +
      `${swing(ring).toFixed(2)}px — the low-pass is tracking it, not removing it`,
  );
  let worst = 0;
  for (let i = 0; i < ring.length; i++) {
    worst = Math.max(worst, Math.hypot(smoothed[i].x - ring[i].x, smoothed[i].y - ring[i].y));
  }
  assert.ok(worst <= 1.5 + 1e-9, `a vertex moved ${worst.toFixed(3)}px against a 1.5px cap`);
});

test('the boundary low-pass leaves a pinned corner exactly where it was', () => {
  // Corners are detected first and pinned, so the filter may never round one
  // off — and its window is clipped at a pin, so the edges meeting there stay
  // straight instead of being dragged across the corner.
  const ring = [];
  for (let x = 0; x < 60; x++) ring.push({ x, y: 0 });
  for (let y = 0; y < 60; y++) ring.push({ x: 60, y });
  for (let x = 60; x > 0; x--) ring.push({ x, y: 60 });
  for (let y = 60; y > 0; y--) ring.push({ x: 0, y });
  const pinned = new Uint8Array(ring.length);
  for (let i = 0; i < ring.length; i++) {
    if ((ring[i].x === 0 || ring[i].x === 60) && (ring[i].y === 0 || ring[i].y === 60)) pinned[i] = 1;
  }
  const smoothed = fit.lowPassClosed(ring, pinned, 8, 2);
  for (let i = 0; i < ring.length; i++) {
    if (pinned[i]) {
      assert.deepEqual(smoothed[i], ring[i], 'a pinned corner moved');
    }
    assert.ok(
      Math.hypot(smoothed[i].x - ring[i].x, smoothed[i].y - ring[i].y) < 1e-9,
      `a straight edge of a square moved at vertex ${i} — the square is being rounded`,
    );
  }
});
