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

const flat = await load('logo-flat-512.png');
const noisy = await load('logo-noisy-512.png');
const big = await load('logo-flat-1024.png');

const fillsIn = (svg) => {
  const set = new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  set.delete('none');
  return set;
};

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
  const cases = [
    ['colorCount', 8, 3],
    ['detail', 60, 5],
    ['smoothing', 50, 100],
    ['despeckle', 20, 90],
  ];
  for (const [key, from, to] of cases) {
    const a = await engine.vectorize(noisy, { ...S, [key]: from });
    const b = await engine.vectorize(noisy, { ...S, [key]: to });
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
  assert.ok(r.svg.toLowerCase().includes('#ff00ff'), 'the new colour must appear in the output');
  assert.equal(r.palette.length, base.palette.length, 'palette length must be stable');
  assert.equal(engine.hexOf(r.palette[0]), '#ff00ff');
});

test('palette override: removing a colour drops it from the output', async () => {
  const base = await engine.vectorize(flat, S);
  const removed = engine.hexOf(base.palette[1]);
  const palette = base.palette.filter((_, i) => i !== 1);
  const r = await engine.vectorize(flat, { ...S, palette });
  assert.equal(r.palette.length, base.palette.length - 1);
  assert.ok(
    !r.svg.toLowerCase().includes(removed),
    `removed colour ${removed} still appears in the SVG`,
  );
});

test('palette override: merging two colours collapses them', async () => {
  const base = await engine.vectorize(flat, S);
  const merged = engine.hexOf(base.palette[1]);
  // "Merge 1 into 0" is expressed as the palette without entry 1.
  const r = await engine.vectorize(flat, { ...S, palette: base.palette.filter((_, i) => i !== 1) });
  assert.equal(r.palette.length, base.palette.length - 1);
  assert.ok(!r.svg.toLowerCase().includes(merged));
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

test('DXF export is a well-formed R12 drawing', async () => {
  const r = await engine.vectorize(flat, S);
  const dxf = engine.toDxf(r);
  for (const token of ['SECTION', 'HEADER', '$EXTMIN', '$EXTMAX', 'ENTITIES', 'ENDSEC']) {
    assert.ok(dxf.includes(token), `DXF is missing ${token}`);
  }
  assert.ok(dxf.trimEnd().endsWith('EOF'));
  assert.match(dxf, /\bAC1009\b/);
  assert.ok((dxf.match(/\bPOLYLINE\b/g) ?? []).length > 0);

  // Group codes and values must pair up, and every code must be an integer.
  const lines = dxf.split('\n').slice(0, -1);
  assert.equal(lines.length % 2, 0, 'DXF group codes and values must pair up');
  for (let i = 0; i < lines.length; i += 2) {
    assert.match(lines[i], /^-?\d+$/, `bad group code at line ${i + 1}: ${lines[i]}`);
  }

  // Extents must describe the artwork, not sit at the origin.
  const extmax = /\$EXTMAX\n10\n(-?[\d.]+)\n20\n(-?[\d.]+)/.exec(dxf);
  assert.ok(extmax, '$EXTMAX must carry x/y');
  assert.ok(Number(extmax[1]) > 0 && Number(extmax[2]) > 0);
  assert.ok(Number(extmax[1]) <= 512 && Number(extmax[2]) <= 512);
});

test('serialize dispatches to the right writer', async () => {
  const r = await engine.vectorize(flat, S);
  assert.equal(engine.serialize(r, 'svg'), r.svg);
  assert.equal(engine.serialize(r, 'eps'), engine.toEps(r));
  assert.equal(engine.serialize(r, 'dxf'), engine.toDxf(r));
  assert.throws(() => engine.serialize(r, 'pdf'), /Unknown export format/);
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
