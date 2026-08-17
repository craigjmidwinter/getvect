/**
 * The decode contract, end to end.
 *
 * Two failures hid behind each other for a whole lap:
 *
 *  1. the renderer's canvas ingest hands the engine `(0,0,0,0)` for every
 *     transparent pixel and the engine reads only RGB, so any sticker/decal PNG
 *     — REFERENCE's headline use case — is traced with an opaque black
 *     background that also steals the dominant palette slot; and
 *  2. the instruments could not see it, because they fed `vectorize()` a
 *     white-flattened image the UI can never produce. Every economy number the
 *     loop steered on described a document no user could obtain.
 *
 * So the app-level assertions here are paired with a parity assertion: what the
 * app exports must be what `engine.vectorize()` produces headlessly from the
 * same file at the same settings. Once that holds, an instrument reading is a
 * statement about the product again.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE,
  REPO_ROOT,
  TESTIDS,
  countSubPaths,
  exportAs,
  expect,
  layerFills,
  loadViaPicker,
  setEnhanceMode,
  setSlider,
  test,
  waitForReady,
} from './helpers';

const requireCjs = createRequire(__filename);
const engine = requireCjs(join(REPO_ROOT, 'dist/engine/index.js'));
const sharp = requireCjs('sharp');
const { Resvg } = requireCjs('@resvg/resvg-js');

/** Decode a file the way the renderer's canvas does (see instruments/lib/decode.mjs). */
async function canvasPixels(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i + 3] = a;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      const pre = Math.round((data[i + c] * a) / 255);
      out[i + c] = Math.round((pre * 255) / a);
    }
  }
  return { width: info.width, height: info.height, data: out };
}

/** Fraction of the source that is transparent, and the mask of those pixels. */
async function alphaStats(file: string) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  return { ratio: transparent / (info.width * info.height), width: info.width, height: info.height };
}

test('[quality-bar] a transparent PNG does not export with an invented background', async ({
  page,
  exportDir,
}) => {
  const { ratio } = await alphaStats(FIXTURE.fox);
  expect(
    ratio,
    'fixture precondition: the gold-standard source is ~3/4 transparent',
  ).toBeGreaterThan(0.5);

  await loadViaPicker(page, FIXTURE.fox);
  await waitForReady(page);
  const svg = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');

  // A full-bleed rect in a colour the artwork does not contain is the signature:
  // the reference product's output for this file has a white/transparent background.
  const backdrop = /<g[^>]*\bfill="([^"]+)"[^>]*>\s*<rect\b[^>]*width="1024"[^>]*height="1024"/.exec(
    svg,
  );
  expect(
    backdrop?.[1] ?? 'none',
    'the transparent background was traced as an opaque layer',
  ).toMatch(/^(none|rgb\(255, ?255, ?255\)|#ffffff)$/i);
  // ...and the corners have to come back as paper, not as ink. The first `<g>`
  // in our output is deliberately the drawn SILHOUETTE painted in the outline
  // colour (`tests/engine/rendered.test.mjs`, "the linework is one silhouette"),
  // so "the bottom layer is black" is the design here and not the bug. The bug
  // is that black covering the CANVAS, which is what this measures: rasterized
  // over white, a transparent corner is paper and an invented backdrop is not.
  const raster = new Resvg(svg, {
    fitTo: { mode: 'width', value: 64 },
    background: 'white',
    font: { loadSystemFonts: false },
  }).render();
  const px = raster.pixels;
  const corners = [
    [1, 1],
    [62, 1],
    [1, 62],
    [62, 62],
  ].map(([x, y]) => {
    const i = (y * raster.width + x) * 4;
    return `rgb(${px[i]},${px[i + 1]},${px[i + 2]})`;
  });
  expect(
    corners.filter((c) => c === 'rgb(255,255,255)').length,
    `the transparent corners of a ${Math.round(ratio * 100)}%-transparent source came back ` +
      `${corners.join(' / ')} — an opaque backdrop was invented for them`,
  ).toBe(4);
});

test('[quality-bar] the app exports exactly what the engine produces headlessly', async ({
  page,
  exportDir,
}) => {
  // Byte-for-byte on an opaque fixture at untouched defaults: if this drifts,
  // no instrument reading describes the product any more.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const exported = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');

  const headless = await engine.vectorize(await canvasPixels(FIXTURE.flat512), {
    ...engine.DEFAULT_SETTINGS,
  });
  expect(
    exported.length,
    `app export ${exported.length} B vs headless ${headless.svg.length} B — the renderer and ` +
      'the instruments are not feeding the engine the same pixels',
  ).toBe(headless.svg.length);
  expect(exported).toBe(headless.svg);
});

test('[quality-bar] the gold-standard settings agree between app and instruments', async ({
  page,
  exportDir,
}) => {
  // REFERENCE lines 73-83 are graded at Clipart / 8 colours / Enhance on — the
  // settings the checked-in exemplar was captured at (ARTWORK.md). The
  // instruments report this fixture's economy; the app has to be the thing they
  // are reporting on. Structural (not byte) equality: Chromium's PNG decode may
  // round a colour-managed sample differently from sharp's.
  await loadViaPicker(page, FIXTURE.fox);
  await waitForReady(page);
  await setSlider(page, TESTIDS.settingColorCount, 8);
  await waitForReady(page);
  await setEnhanceMode(page, 'local');
  await waitForReady(page);

  const exported = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');
  const headless = await engine.vectorize(await canvasPixels(FIXTURE.fox), {
    ...engine.DEFAULT_SETTINGS,
    colorCount: 8,
    enhance: true,
  });

  const ours = countSubPaths(exported);
  const theirs = countSubPaths(headless.svg);
  expect(
    Math.abs(ours - theirs) / Math.max(1, theirs),
    `the UI produced ${ours} sub-paths / ${exported.length} B where the headless engine produced ` +
      `${theirs} / ${headless.svg.length} B at the same settings — artifacts/metrics.json is ` +
      'measuring a document the user cannot obtain',
  ).toBeLessThan(0.1);
  expect(
    Math.abs(exported.length - headless.svg.length) / headless.svg.length,
    'app and headless SVG sizes have diverged for the fixture REFERENCE grades us on',
  ).toBeLessThan(0.1);
  // Layer *count* — not the exact fills, which can differ by a rounded sample
  // between Chromium's PNG decode and sharp's.
  expect(layerFills(exported).length).toBe(layerFills(headless.svg).length);
});
