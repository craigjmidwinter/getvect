/**
 * Alpha-channel contract — `npm run test:engine`.
 *
 * REFERENCE's headline use cases (stickers, decals, t-shirt art, logos) arrive
 * as PNGs with a transparent background, and the app's ingest hands the engine
 * exactly what a 2D canvas returns for such a file: `(0,0,0,0)`. An engine that
 * reads only RGB therefore sees a solid black rectangle, spends its dominant
 * palette slot on it, paints a full-bleed black backdrop, and drags the
 * artwork's own black linework into that same slot.
 *
 * Every assertion here is on `vectorize()` alone: the pixels handed in are the
 * pixels `src/renderer/lib/decode.ts` produces, and the pixels compared against
 * are the source flattened on white — which is what any consumer (browser,
 * resvg, the preview) composites a transparent document onto. So both possible
 * fixes pass: leave the background out of the drawing, or flatten it to white.
 * Only inventing an opaque background fails.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Resvg } from '@resvg/resvg-js';

import { canvasIngest, decodeImageFile, flattenOnWhite } from '../../instruments/lib/decode.mjs';
import { alphaMask, backdropFill, maskedMeanColorError, meanColorError } from '../../instruments/lib/metrics.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const engine = require(join(root, 'dist/engine/index.js'));
const fixture = (name) => join(root, 'fixtures', name);
const S = engine.DEFAULT_SETTINGS;

/** Rasterize onto white, exactly as a viewer would composite the document. */
function render(svg, width, height) {
  const { pixels } = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'white',
    font: { loadSystemFonts: false },
  }).render();
  return { width, height, data: new Uint8ClampedArray(pixels) };
}

const luma = (c) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/** Load a fixture the way the app does (canvas pixels) and the way we judge it. */
async function loadPair(name) {
  const decoded = await decodeImageFile(fixture(name));
  return { ingested: canvasIngest(decoded), onWhite: flattenOnWhite(decoded), decoded };
}

test('[quality-bar] a transparent background is not traced as an opaque one', async () => {
  const { ingested, onWhite, decoded } = await loadPair('sticker-alpha-256.png');
  const r = await engine.vectorize(ingested, S);
  const traced = render(r.svg, r.width, r.height);

  const backdrop = backdropFill(r.svg);
  const overTransparent = maskedMeanColorError(onWhite, traced, alphaMask(decoded));
  assert.ok(
    overTransparent < 8,
    `the trace paints the see-through part of the sticker with colour error ` +
      `${overTransparent.toFixed(1)}/255 (backdrop ${backdrop?.fill ?? 'none'}) — ` +
      'the input alpha channel is being ignored',
  );
  assert.ok(
    meanColorError(onWhite, traced) < 8,
    'the sticker does not survive a round trip through the tracer',
  );
});

test('[quality-bar] transparent pixels do not win a palette slot', async () => {
  // A three-colour sticker whose darkest opaque colour has luma ~53: any entry
  // darker than that came from the transparent background, not the artwork,
  // and it costs the drawing one of the colours the user asked for.
  const { ingested } = await loadPair('sticker-alpha-256.png');
  const r = await engine.vectorize(ingested, { ...S, colorCount: 4 });
  const darkest = r.palette.reduce((m, c) => Math.min(m, luma(c)), 255);
  assert.ok(
    darkest > 30,
    `palette entry with luma ${darkest.toFixed(0)} — the transparent background has been ` +
      `quantized as black (palette ${JSON.stringify(r.palette)})`,
  );
});

test('[quality-bar] the gold-standard source keeps its transparent background', async () => {
  // REFERENCE lines 73-83: fixtures/reference/artwork.png is 33% transparent
  // and the real product's output for it has a white/transparent background.
  const { ingested, onWhite, decoded } = await loadPair('reference/artwork.png');
  const r = await engine.vectorize(ingested, { ...S, colorCount: 16, enhance: true });
  const traced = render(r.svg, r.width, r.height);
  const overTransparent = maskedMeanColorError(onWhite, traced, alphaMask(decoded));
  assert.ok(
    overTransparent < 8,
    `colour error ${overTransparent.toFixed(1)}/255 over the transparent third of the ` +
      `artwork (backdrop ${backdropFill(r.svg)?.fill ?? 'none'})`,
  );
});

test('[quality-bar] the exported EPS/PDF inherit the transparency decision', async () => {
  // The exporters recover geometry from the SVG, so a black page in the EPS is
  // the SVG's black backdrop wearing a different hat — assert it directly so a
  // fix that only patches the SVG writer cannot pass.
  const { ingested } = await loadPair('sticker-alpha-256.png');
  const r = await engine.vectorize(ingested, S);
  const eps = engine.toEps(r);
  const black = /\b0(?:\.0+)? 0(?:\.0+)? 0(?:\.0+)? setrgbcolor/.test(eps);
  assert.ok(
    !black,
    'the EPS paints pure black — the SVG backdrop invented for the transparent background ' +
      'is being exported as a black page',
  );
});
