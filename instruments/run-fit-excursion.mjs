#!/usr/bin/env node
/**
 * `node instruments/run-fit-excursion.mjs` — did the curve fitter invent
 * geometry its input polygon does not have?
 *
 * WHY THIS EXISTS. The frankie demo asset ships a cubic
 * (`c -2.56 4.81 -19.69 7.58 -9.03 15.97`, white layer, chin/bib notch at
 * ~(475,511)) whose control point sits 10.7px outside its endpoint span and
 * whose curve deviates 5.93px from its chord. Read as "a one-pixel mask step
 * became six pixels of curve", that is a fitter defect. But chord deviation is
 * the wrong instrument for that claim: a segment spanning a J-hook (a chin
 * edge that descends past the segment chord and doubles back to a 1px tongue
 * tip pinned as the only corner) legitimately leaves its endpoint span — the
 * deviation is the *feature's* depth, not the fitter's contribution.
 *
 * The defect-shaped measurement is two-sided, per fitted contour, against the
 * EXACT ring the fitter was handed (before its own low-pass/smoothing):
 *
 *   invented — max distance from the fitted curve to the input ring: how much
 *              geometry the output has that the mask does not.
 *   omitted  — max distance from the input ring to the fitted curve: how much
 *              mask geometry the output dropped (rounded-off corners, dropped
 *              tongues).
 *
 * Both are absolute pixels on the source grid. The fitter's whole licence is
 * its tolerance (≤0.89px at default Detail, scaled DOWN for thin shapes) plus
 * the boundary low-pass's clamp (≤2px, likewise scaled down); `invented`
 * beyond ~3px anywhere would be the "5.93px swoop from a 1px feature"
 * mechanism, real. The BALLOON column counts fitted contours whose invented
 * deviation exceeds 3px.
 *
 * Zero-state: on `arcs-560x256` — mathematically exact circles, so the right
 * answer comes from x²+y²=r², not an opinion — both directions must sit at
 * the quantization scale of the ring itself (≤ ~0.6px), and every synthetic
 * fixture must show 0 balloons.
 *
 * WINDOW. One trace per fixture at its manifest-declared settings (plus one
 * extra row, `frankie-demo-asset`, at the shipped demo settings of
 * scripts/regenerate-derived-assets.mjs — 8 colours, smart AA, no Enhance —
 * because that is the trace the notch was reported on). Curves are sampled at
 * 32 points per segment; distances are exact point-to-segment, capped at 32px.
 * Circle-detected contours (REFERENCE B5) are measured like any other output.
 *
 * Needs the compiled engine: `npm run build:node` first.
 *
 * Outputs: a table on stdout and artifacts/fit-excursion.json.
 * Exit codes: 0 measured, 1 a synthetic fixture ballooned (invented > 3px).
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canvasIngest, decodeImageFile } from './lib/decode.mjs';
import { maxPolylineDeviation } from './lib/metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

/** Invented deviation, in px, past which a fitted contour counts as a balloon. */
const BALLOON_PX = 3;
/** Curve sampling density per fitted segment. */
const CURVE_SAMPLES = 32;

/** Sample a SubPath (engine dist shape: {x, y, closed, segments}) densely. */
function sampleSubPath(subpath) {
  const out = [];
  let x = subpath.x;
  let y = subpath.y;
  out.push({ x, y });
  for (const s of subpath.segments) {
    if (s.t === 'L') {
      for (let k = 1; k <= 4; k++) out.push({ x: x + ((s.x - x) * k) / 4, y: y + ((s.y - y) * k) / 4 });
    } else if (s.t === 'Q') {
      for (let k = 1; k <= CURVE_SAMPLES; k++) {
        const t = k / CURVE_SAMPLES;
        const mt = 1 - t;
        out.push({
          x: mt * mt * x + 2 * mt * t * s.cx + t * t * s.x,
          y: mt * mt * y + 2 * mt * t * s.cy + t * t * s.y,
        });
      }
    } else {
      for (let k = 1; k <= CURVE_SAMPLES; k++) {
        const t = k / CURVE_SAMPLES;
        const mt = 1 - t;
        out.push({
          x: mt * mt * mt * x + 3 * mt * mt * t * s.c1x + 3 * mt * t * t * s.c2x + t * t * t * s.x,
          y: mt * mt * mt * y + 3 * mt * mt * t * s.c1y + 3 * mt * t * t * s.c2y + t * t * t * s.y,
        });
      }
    }
    x = s.x;
    y = s.y;
  }
  return out;
}

async function main() {
  const fit = require(join(root, 'dist/engine/fit.js'));
  const engine = require(join(root, 'dist/engine/index.js'));

  const manifest = JSON.parse(await fs.readFile(join(root, 'fixtures/manifest.json'), 'utf8'));
  const rows = manifest.fixtures
    .filter((f) => f.supported)
    .map((f) => ({ id: f.id, file: join(root, 'fixtures', f.file), settings: f.settings ?? {}, provenance: f.provenance }));
  // The trace the notch was reported on: the shipped demo asset's settings
  // (scripts/regenerate-derived-assets.mjs DEMO_SETTINGS — no Enhance).
  rows.push({
    id: 'frankie-demo-asset',
    file: join(root, 'fixtures/reference/frankie-sticker.png'),
    settings: { colorCount: 8, antiAliasing: 'smart', minArea: 5 },
    provenance: 'in-house',
  });

  const results = [];
  let captures = null;
  const orig = fit.fitClosedPolygon;
  // Hook the fitter: dist is CommonJS and trace.js calls through the module
  // object, so swapping the export intercepts every contour of every layer.
  fit.fitClosedPolygon = function (points, options) {
    const out = orig.call(this, points, options);
    if (captures && out && out.subpath) captures.push({ ring: points, subpath: out.subpath, tolerance: options.tolerance });
    return out;
  };

  try {
    for (const row of rows) {
      const src = canvasIngest(await decodeImageFile(row.file));
      captures = [];
      await engine.vectorize(src, row.settings, () => {});
      const contours = captures;
      captures = null;

      let invented = { max: 0, at: null };
      let omitted = { max: 0, at: null };
      let balloons = 0;
      let worstTolerance = 0;
      for (const c of contours) {
        const curve = sampleSubPath(c.subpath);
        const inv = maxPolylineDeviation(curve, c.ring, { closed: true });
        const omi = maxPolylineDeviation(c.ring, curve, { closed: true });
        if (inv.max > invented.max) {
          invented = inv;
          worstTolerance = c.tolerance;
        }
        if (omi.max > omitted.max) omitted = omi;
        if (inv.max > BALLOON_PX) balloons++;
      }
      const at = (w) => (w.at ? `(${w.at.x.toFixed(1)},${w.at.y.toFixed(1)})` : '-');
      results.push({
        id: row.id,
        provenance: row.provenance,
        contours: contours.length,
        inventedMax: +invented.max.toFixed(3),
        inventedAt: invented.at,
        inventedTolerance: worstTolerance,
        omittedMax: +omitted.max.toFixed(3),
        omittedAt: omitted.at,
        balloons,
      });
      console.log(
        `${row.id.padEnd(24)} contours ${String(contours.length).padStart(4)}  ` +
          `invented ${invented.max.toFixed(2).padStart(6)}px @ ${at(invented).padEnd(16)} ` +
          `omitted ${omitted.max.toFixed(2).padStart(6)}px @ ${at(omitted).padEnd(16)} balloons ${balloons}`,
      );
    }
  } finally {
    fit.fitClosedPolygon = orig;
  }

  await fs.mkdir(join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(
    join(root, 'artifacts/fit-excursion.json'),
    JSON.stringify({ balloonPx: BALLOON_PX, curveSamples: CURVE_SAMPLES, results }, null, 2),
  );

  const syntheticBalloons = results.filter((r) => r.provenance === 'synthetic' && r.balloons > 0);
  if (syntheticBalloons.length > 0) {
    console.error(`FAIL: synthetic fixtures with invented deviation > ${BALLOON_PX}px: ${syntheticBalloons.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
}

await main();
