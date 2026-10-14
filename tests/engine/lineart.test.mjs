/**
 * Line-art auto-detection contract — `npm run test:engine`.
 *
 * A clean line drawing must be traced as a drawing without the user choosing a
 * mode: Smart anti-aliasing snaps ramp pixels toward ink, which fattens strokes
 * and fills in small enclosed cells, and Enhance shreds thin strokes. The
 * picture here is synthetic — drawn from equations, so what the right answer
 * is was fixed before we traced it: a ring of known stroke width containing a
 * grid of small enclosed cells separated by thin lines.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { enclosedLightComponents } from '../../instruments/lib/metrics.mjs';
import { rasterizeSvg } from '../../instruments/lib/render.mjs';
import { decodeImageFile, canvasIngest } from '../../instruments/lib/decode.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const engine = require(join(root, 'dist/engine/index.js'));

const W = 400;
const H = 300;

/** Paper with antialiased black strokes: a 6px ring and a 5x4 grid of 3px lines inside it. */
function drawing() {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const coverage = (d, half) => Math.max(0, Math.min(1, half + 0.5 - d));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x - 200, y - 150);
      let ink = coverage(Math.abs(r - 120), 3);
      const inside = r < 117;
      if (inside) {
        const gx = Math.abs(((x - 80) % 48) - 24 + 24) % 48;
        const gy = Math.abs(((y - 60) % 45) - 22.5 + 22.5) % 45;
        ink = Math.max(ink, coverage(Math.min(gx, 48 - gx), 1.5), coverage(Math.min(gy, 45 - gy), 1.5));
      }
      const v = Math.round(255 * (1 - ink));
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  }
  return { width: W, height: H, data };
}

const inkArea = (img) => {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) n++;
  return n;
};

test('[lineart] a clean drawing is detected and traced faithfully with default settings', async () => {
  const src = drawing();
  const result = await engine.vectorize(src, undefined, () => {});
  assert.equal(result.lineArtDetected, true, 'the synthetic drawing must be recognised as line art');
  const { image: out } = await rasterizeSvg(result.svg, W, H);
  const growth = inkArea(out) / inkArea(src);
  assert.ok(growth < 1.04, `ink area grew ${growth.toFixed(3)}x — strokes were fattened`);
  const cellsIn = enclosedLightComponents(src);
  assert.ok(cellsIn >= 10, `the fixture must contain enclosed cells to lose (found ${cellsIn})`);
  assert.equal(enclosedLightComponents(out), cellsIn, 'every enclosed cell of the source must survive');
});

test('[lineart] autoLineArt:false restores the generic pipeline — the gate can go red', async () => {
  const src = drawing();
  const off = await engine.vectorize(src, { autoLineArt: false }, () => {});
  const on = await engine.vectorize(src, undefined, () => {});
  assert.equal(off.lineArtDetected, false);
  assert.notEqual(off.svg, on.svg, 'detection must change the trace, or it is not doing anything');
  const { image: a } = await rasterizeSvg(off.svg, W, H);
  const { image: b } = await rasterizeSvg(on.svg, W, H);
  assert.ok(
    inkArea(a) > inkArea(b),
    'the generic pipeline must fatten this drawing more than the line-art path does',
  );
  assert.ok(
    enclosedLightComponents(a) <= enclosedLightComponents(b),
    'and must not keep more cells than the line-art path',
  );
});

test('[lineart] Enhance cannot shred a detected drawing', async () => {
  const src = drawing();
  const plain = await engine.vectorize(src, undefined, () => {});
  const enhanced = await engine.vectorize(src, { enhance: true }, () => {});
  assert.equal(enhanced.svg, plain.svg, 'Enhance stands down for line art');
});

test('[lineart] an explicit anti-aliasing choice is the user\'s and is respected', async () => {
  const src = drawing();
  const mid = await engine.vectorize(src, { antiAliasing: 'mid' }, () => {});
  const off = await engine.vectorize(src, { antiAliasing: 'off' }, () => {});
  assert.notEqual(mid.svg, off.svg);
});

test('[lineart] colour artwork and photographs are never taken for line art', async () => {
  for (const name of ['logo-flat-512.png', 'photo-gradient-512x384.jpg', 'sticker-alpha-256.png', 'arcs-560x256.png']) {
    const img = canvasIngest(await decodeImageFile(join(root, 'fixtures', name)));
    const r = await engine.vectorize(img, undefined, () => {});
    assert.equal(r.lineArtDetected, false, `${name} must not be detected as line art`);
  }
});
