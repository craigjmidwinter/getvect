#!/usr/bin/env node
/**
 * `npm run instruments` — the fidelity light meter.
 *
 * For every supported fixture it:
 *   1. decodes the source raster (sharp; BMP via instruments/lib/decode.mjs)
 *      and passes it through `canvasIngest()` so the engine sees exactly the
 *      pixels the renderer's canvas ingest produces — including `(0,0,0,0)` for
 *      transparent ones. Fidelity is still judged against the source flattened
 *      on white (docs/HARNESS.md "One decode contract"),
 *   2. calls the engine's pure `vectorize()` headlessly (dist/engine/index.js),
 *   3. rasterizes the produced SVG back to the SOURCE dimensions with resvg,
 *   4. measures mean/RMS colour error, SSIM, mismatch ratio, per-colour area
 *      drift, ink recall (loose AND strict), ink-component continuity, per-layer
 *      boundary compactness, palette shortfall, path AND sub-path counts, speck
 *      ratio, curve-command ratio, near-duplicate colour layers, SVG byte size
 *      and wall-clock ms,
 *   5. compares each against the fixture's thresholds (fixtures/manifest.json,
 *      derived from REFERENCE.md "Quality bar"), including ratios against a
 *      real the reference product exemplar when the fixture declares one.
 *
 * Outputs:
 *   artifacts/metrics.json          machine-readable, one record per fixture
 *   artifacts/vector/<id>.svg       the engine's output
 *   artifacts/raster/<id>.png       that SVG re-rasterized at source size
 *   artifacts/diff/<id>.png         amplified absolute difference
 *   artifacts/region/<id>.png       the salient-region crop of the re-raster,
 *                                   for fixtures that declare `salientRegion` /
 *                                   `salientRegions` (further boxes land in
 *                                   artifacts/region/<id>-<name>.png)
 *   stdout                          human-readable table
 *
 * Exit codes: 0 all measured fixtures pass · 1 a measured fixture missed a
 * threshold · 2 the engine is not implemented yet (nothing could be measured).
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { canvasIngest, decodeImageFile, flattenOnWhite, transparentRatio } from './lib/decode.mjs';
// Rasterization lives in lib/render.mjs so `npm run test:engine` measures
// exemplars exactly the way the instruments do — see the note there about the
// content box.
import { rasterizeExemplarContent, rasterizeSvg } from './lib/render.mjs';
import {
  alphaMask,
  cropRegion,
  inkComponentRatio,
  inkRecall,
  layerCompactness,
  maskedMeanColorError,
  meanColorError,
  perColorCoverageDelta,
  pixelMismatchRatio,
  psnr,
  rmsColorError,
  ssim,
  strictInkRecall,
  svgStructure,
} from './lib/metrics.mjs';

/**
 * A fixture's salient regions, normalized.
 *
 * `salientRegion` (one box) is the original spelling and still works;
 * `salientRegions` is a list of named boxes, because one crop is not enough on
 * the gold standard: the face is where line art is lost and the paw pad is
 * where a whole colour family is lost, and a fixture that can only name one of
 * them measures the other with nothing. Region gates are applied to the WORST
 * region, so adding a box can only tighten a fixture, never loosen it.
 */
function salientRegions(fixture) {
  if (Array.isArray(fixture.salientRegions)) {
    return fixture.salientRegions.map((r, i) => ({ name: r.name ?? `region${i + 1}`, ...r }));
  }
  if (fixture.salientRegion) return [{ name: 'salient', ...fixture.salientRegion }];
  return [];
}

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(root, 'fixtures');

const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/** `--tag=selftest` writes images under artifacts/selftest/ instead of artifacts/. */
const tag = argOf('tag', '');
const artifactsDir = tag ? join(root, 'artifacts', tag) : join(root, 'artifacts');
const metricsPath = join(root, argOf('out', 'artifacts/metrics.json'));

/**
 * Which engine to measure. Defaults to the app's compiled engine; pass
 * `--engine=instruments/reference-engine.mjs` to measure the naive reference
 * tracer instead (that is `npm run instruments:selftest`, which proves the
 * measurement chain works even while the real engine is a stub).
 */
async function loadEngine() {
  const arg = process.argv.find((a) => a.startsWith('--engine='));
  const target = arg ? arg.slice('--engine='.length) : 'dist/engine/index.js';
  const abs = join(root, target);
  try {
    return target.endsWith('.mjs') ? await import(pathToFileURL(abs).href) : require(abs);
  } catch (err) {
    throw new Error(`Could not load engine ${target} — run \`npm run build:node\` first.\n${err.message}`);
  }
}

async function writeDiff(a, b, file, amplify = 4) {
  const out = Buffer.alloc(a.width * a.height * 3);
  for (let i = 0, o = 0; i < a.data.length; i += 4, o += 3) {
    for (let c = 0; c < 3; c++) {
      out[o + c] = Math.min(255, Math.abs(a.data[i + c] - b.data[i + c]) * amplify);
    }
  }
  await sharp(out, { raw: { width: a.width, height: a.height, channels: 3 } })
    .png()
    .toFile(file);
}

/**
 * Every gate the instruments enforce, as `[threshold key, metric key, direction,
 * formatter]`. `max*` keys fail when the metric is above the threshold, `min*`
 * when it is below.
 */
const GATES = [
  ['meanColorError', 'meanColorError', 'max', (v) => v.toFixed(2)],
  ['ssim', 'ssim', 'min', (v) => v.toFixed(4)],
  ['minInkRecall', 'inkRecall', 'min', (v) => v.toFixed(4)],
  ['maxPaths', 'pathCount', 'max', String],
  // pathCount is not a shape count — one compound path per colour layer hides
  // thousands of specks inside a single element, so the economy bar is only
  // real when sub-paths are counted too (REFERENCE "Economy").
  ['maxSubPaths', 'subPathCount', 'max', String],
  ['maxTinySubPathRatio', 'tinySubPathRatio', 'max', (v) => v.toFixed(4)],
  ['minCurveCommandRatio', 'curveCommandRatio', 'min', (v) => v.toFixed(3)],
  ['maxNearDuplicateFills', 'nearDuplicateFillPairs', 'max', String],
  ['maxPerColorCoverageDelta', 'perColorCoverageDelta', 'max', (v) => v.toFixed(4)],
  // What the user sees through a transparent source pixel. A trace that paints
  // the alpha-0 background opaque (the black-rectangle blocker) scores ~255
  // here while MAE/SSIM over the whole frame can still look survivable.
  ['maxTransparentAreaColorError', 'transparentAreaColorError', 'max', (v) => v.toFixed(2)],
  // The salient regions (fixture `salientRegion` / `salientRegions`). Whole-frame
  // scores are area-weighted and cannot see a destroyed face; these are the same
  // numbers computed inside the crops that carry the meaning, aggregated to the
  // WORST region so adding a box can only tighten a fixture.
  ['minRegionInkRecall', 'regionInkRecall', 'min', (v) => v.toFixed(4)],
  ['maxRegionMeanColorError', 'regionMeanColorError', 'max', (v) => v.toFixed(2)],
  ['minRegionSsim', 'regionSsim', 'min', (v) => v.toFixed(4)],
  // Continuity, not just survival. `inkRecall` accepts anything darker than 128,
  // so a contour thinned to a grey smear or broken into dashes still scores ~1;
  // `strictInkRecall` demands the source's ink come back as ink.
  ['minStrictInkRecall', 'strictInkRecall', 'min', (v) => v.toFixed(4)],
  ['minRegionStrictInkRecall', 'regionStrictInkRecall', 'min', (v) => v.toFixed(4)],
  // ...and the same question asked against the real product instead of against
  // an invented constant: < 1 means its outlines are more solid than ours in the
  // region where we are worst. A whole-frame absolute bar cannot be used here —
  // the exemplar itself scores 0.859 globally because it drops antialiased
  // skirts, while inside the paw it scores 0.984 to our 0.943.
  ['minRegionStrictInkRecallRatio', 'regionStrictInkRecallRatio', 'min', (v) => `${v.toFixed(3)}x`],
  // Boundary raggedness of the colour layers (metrics.mjs `layerCompactness`):
  // the sawtooth-vs-sweep difference between clipart and a posterized photo.
  ['maxLayerCompactness', 'layerCompactness', 'max', (v) => v.toFixed(2)],
  ['maxLayerCompactnessRatio', 'layerCompactnessRatio', 'max', (v) => `${v.toFixed(2)}x`],
  // B3: how many of the colours the user asked for — and the image actually has
  // — our own folds merged away before the palette was returned.
  ['maxPaletteShortfall', 'paletteShortfall', 'max', String],
  // D3: the DXF must carry the curves the SVG paid for, and must not balloon
  // past the EPS of the same drawing by flattening them into vertex runs.
  ['minDxfSplines', 'dxfSplineCount', 'min', String],
  ['maxDxfEpsBytesRatio', 'dxfEpsBytesRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxBytes', 'svgBytes', 'max', String],
  ['maxMs', 'wallClockMs', 'max', (v) => v.toFixed(0)],
  // Relative to the gold-standard exemplar (REFERENCE lines 80-83).
  ['maxBytesRatio', 'exemplarBytesRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxSubPathRatio', 'exemplarSubPathRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxPathRatio', 'exemplarPathRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxMeanColorErrorRatio', 'exemplarMeanColorErrorRatio', 'max', (v) => `${v.toFixed(2)}x`],
];

function checkThresholds(m, t) {
  if (!t) return [];
  const failures = [];
  for (const [key, metric, dir, fmtV] of GATES) {
    const limit = t[key];
    const value = m[metric];
    if (limit == null || value == null || !Number.isFinite(value)) continue;
    if (dir === 'max' ? value > limit : value < limit) {
      failures.push(`${metric} ${fmtV(value)} ${dir === 'max' ? '>' : '<'} ${limit}`);
    }
  }
  return failures;
}

function fmt(v, digits = 2) {
  if (v == null) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '—';
  return v.toFixed(digits);
}

function table(rows) {
  const cols = [
    ['fixture', (r) => r.id, 20],
    ['status', (r) => r.status, 19],
    ['MAE/255', (r) => fmt(r.metrics?.meanColorError), 8],
    ['SSIM', (r) => fmt(r.metrics?.ssim, 4), 8],
    ['paths', (r) => (r.metrics ? String(r.metrics.pathCount) : '—'), 6],
    ['subpaths', (r) => (r.metrics ? String(r.metrics.subPathCount) : '—'), 9],
    ['tiny%', (r) => fmt(r.metrics ? r.metrics.tinySubPathRatio * 100 : null, 1), 6],
    ['curve', (r) => fmt(r.metrics?.curveCommandRatio, 3), 6],
    ['ink', (r) => fmt(r.metrics?.inkRecall, 3), 6],
    // Ink recall inside the fixture's salient region(s), when it declares any —
    // the number that catches a destroyed face behind a green whole-frame score.
    ['rgnInk', (r) => fmt(r.metrics?.regionInkRecall, 3), 6],
    // Strict ink recall (ink must come back as ink) in the worst region, and the
    // mean boundary raggedness of the colour layers.
    ['sInk', (r) => fmt(r.metrics?.regionStrictInkRecall ?? r.metrics?.strictInkRecall, 3), 6],
    ['cmpct', (r) => fmt(r.metrics?.layerCompactness, 2), 6],
    ['SVG KB', (r) => fmt(r.metrics ? r.metrics.svgBytes / 1024 : null, 1), 8],
    ['ms', (r) => fmt(r.metrics?.wallClockMs, 0), 6],
  ];
  const head = cols.map(([h, , w]) => h.padEnd(w)).join(' ');
  const sep = cols.map(([, , w]) => '-'.repeat(w)).join(' ');
  const body = rows.map((r) => cols.map(([, get, w]) => String(get(r)).padEnd(w)).join(' '));
  return [head, sep, ...body].join('\n');
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(join(fixturesDir, 'manifest.json'), 'utf8'));
  const engine = await loadEngine();

  for (const sub of ['vector', 'raster', 'diff', 'region']) {
    await fs.mkdir(join(artifactsDir, sub), { recursive: true });
  }

  const baseSettings = { ...engine.DEFAULT_SETTINGS };
  const results = [];
  let notImplemented = 0;
  let failed = 0;
  /** Cache of measured exemplar SVGs, keyed by file. */
  const exemplarCache = new Map();

  /**
   * Measure a gold-standard exemplar (real the reference product output shipped in
   * fixtures/reference/) the same way we measure ours, so the comparison
   * REFERENCE lines 80-83 asks for is a number instead of an eyeball.
   */
  async function measureExemplar(relPath, source, regions) {
    const cacheKey = `${relPath}::${JSON.stringify(regions ?? [])}`;
    if (exemplarCache.has(cacheKey)) return exemplarCache.get(cacheKey);
    let measured = null;
    try {
      const svg = await fs.readFile(join(fixturesDir, relPath), 'utf8');
      // Straight viewBox rasterization, kept for context only — it is what the
      // gate used to be scored on and it is meaningless for an exemplar whose
      // artwork does not fill its declared viewBox.
      const asDeclared = flattenOnWhite(
        (await rasterizeSvg(svg, source.width, source.height)).image,
      );
      const fair = await rasterizeExemplarContent(svg, source.width, source.height);
      const traced = fair.image;
      measured = {
        file: relPath,
        ...svgStructure(svg),
        contentBox: fair.contentBox,
        meanColorError: meanColorError(source, traced),
        ssim: ssim(source, traced),
        inkRecall: inkRecall(source, traced),
        strictInkRecall: strictInkRecall(source, traced),
        meanColorErrorAsDeclared: meanColorError(source, asDeclared),
        regions: (regions ?? []).map((region) => {
          const a = cropRegion(source, region);
          const b = cropRegion(traced, region);
          return {
            name: region.name,
            inkRecall: inkRecall(a, b),
            strictInkRecall: strictInkRecall(a, b),
            meanColorError: meanColorError(a, b),
          };
        }),
      };
      // The first region keeps the old field name so nothing that reads
      // `exemplar.regionInkRecall` from an older metrics.json breaks.
      measured.regionInkRecall = measured.regions[0]?.inkRecall ?? null;
    } catch (err) {
      measured = { file: relPath, error: err.message };
    }
    exemplarCache.set(cacheKey, measured);
    return measured;
  }

  for (const fixture of manifest.fixtures) {
    if (!fixture.supported) {
      results.push({
        id: fixture.id,
        file: fixture.file,
        kind: fixture.kind,
        status: 'skipped/unsupported',
        metrics: null,
        failures: [],
      });
      continue;
    }

    const filePath = join(fixturesDir, fixture.file);
    const decoded = await decodeImageFile(filePath);
    /**
     * ONE DECODE CONTRACT. `source` is what fidelity is judged against (opaque,
     * flattened on white); `ingested` is what the engine is handed — the same
     * pixels `src/renderer/lib/decode.ts` produces from a canvas, so a number
     * measured here is a number a user can reproduce from the UI. Feeding
     * vectorize() the flattened image instead hid a blocker for a whole lap:
     * every transparent PNG traced with an opaque black backdrop in the app
     * while the instruments reported a clean white one.
     */
    const source = flattenOnWhite(decoded);
    const ingested = canvasIngest(decoded);
    const sourceTransparentRatio = transparentRatio(decoded);
    const transparentPixels = sourceTransparentRatio > 0 ? alphaMask(decoded) : null;
    /**
     * What fidelity is judged against.
     *
     * Normally the source itself. A fixture may name a different image with
     * `compareTo`, and exactly one kind of fixture needs to: a *noisy* one.
     * Speckle removal is a feature (REFERENCE B5 Minimum Area, B4 Noise
     * Reduction, the despeckle slider), and SSIM's variance term punishes it
     * hard — the clean artwork scores 0.35 against the speckled version of
     * itself, so measuring a denoised trace against the noise rewards
     * reproducing every speck and calls recovering the drawing a failure.
     * Pointing the noisy fixture at the clean original asks the question the
     * fixture exists to ask: did the artwork come back?
     */
    const referenceFile = fixture.compareTo ?? fixture.file;
    const reference =
      referenceFile === fixture.file
        ? source
        : flattenOnWhite(await decodeImageFile(join(fixturesDir, referenceFile)));
    // A fixture may pin the settings it is judged at (the reference exemplar
    // was produced at ~16 colours, so measuring it at the 8-colour default
    // would compare two different pictures).
    const settings = { ...baseSettings, ...(fixture.settings ?? {}) };

    let result;
    const t0 = performance.now();
    try {
      result = await engine.vectorize(ingested, settings, () => {});
    } catch (err) {
      const status = err?.name === 'EngineNotImplementedError' ? 'not-implemented' : 'engine-error';
      if (status === 'not-implemented') notImplemented++;
      else failed++;
      results.push({
        id: fixture.id,
        file: fixture.file,
        kind: fixture.kind,
        status,
        error: err?.message ?? String(err),
        metrics: null,
        failures: [],
      });
      continue;
    }
    const wallClockMs = performance.now() - t0;

    if (typeof result?.svg !== 'string') {
      failed++;
      results.push({
        id: fixture.id,
        file: fixture.file,
        kind: fixture.kind,
        status: 'engine-error',
        error: 'vectorize() did not return { svg: string }',
        metrics: null,
        failures: [],
      });
      continue;
    }

    await fs.writeFile(join(artifactsDir, 'vector', `${fixture.id}.svg`), result.svg);

    let rendered;
    try {
      rendered = await rasterizeSvg(result.svg, source.width, source.height);
    } catch (err) {
      failed++;
      results.push({
        id: fixture.id,
        file: fixture.file,
        kind: fixture.kind,
        status: 'unrasterizable-svg',
        error: err.message,
        metrics: null,
        failures: [],
      });
      continue;
    }
    await fs.writeFile(join(artifactsDir, 'raster', `${fixture.id}.png`), rendered.png);
    const traced = flattenOnWhite(rendered.image);
    await writeDiff(reference, traced, join(artifactsDir, 'diff', `${fixture.id}.png`));

    const structure = svgStructure(result.svg);
    const metrics = {
      width: source.width,
      height: source.height,
      comparedTo: referenceFile,
      meanColorError: meanColorError(reference, traced),
      rmsColorError: rmsColorError(reference, traced),
      psnrDb: psnr(reference, traced),
      ssim: ssim(reference, traced),
      pixelMismatchRatio: pixelMismatchRatio(reference, traced),
      // Area-weighted scores cannot see a deleted hairline; this can.
      inkRecall: inkRecall(reference, traced),
      // ...and this can see a hairline that came back as a grey smear or a row
      // of dashes, which `inkRecall`'s luma-128 "kept" test forgives.
      strictInkRecall: strictInkRecall(reference, traced),
      inkComponentRatio: inkComponentRatio(reference, traced),
      // How much each palette colour's area drifted between source and trace:
      // catches half-pixel erosion of hairlines that MAE/SSIM average away.
      perColorCoverageDelta: Array.isArray(result.palette)
        ? perColorCoverageDelta(reference, traced, result.palette)
        : null,
      // Transparency contract: what the trace paints where the source is
      // transparent (white = left alone, because resvg composites on white).
      sourceTransparentRatio,
      transparentAreaColorError: transparentPixels
        ? maskedMeanColorError(source, traced, transparentPixels)
        : null,
      backdropFill: structure.backdropFill,
      pathCount: structure.pathCount,
      shapeCount: structure.shapeCount,
      subPathCount: structure.subPathCount,
      tinySubPathRatio: structure.tinySubPathRatio,
      curveCommandRatio: structure.curveCommandRatio,
      cubicCount: structure.cubicCount,
      layerCount: structure.layerCount,
      layerCompactness: structure.layerCompactness,
      nearDuplicateFillPairs: structure.nearDuplicateFillPairs,
      paletteSize: Array.isArray(result.palette) ? result.palette.length : null,
      sourceColors: typeof result.sourceColors === 'number' ? result.sourceColors : null,
      /**
       * B3: colours asked for, minus colours delivered — capped by what the
       * image actually had. The engine reports `sourceColors` (the palette
       * BEFORE our own folds), so this separates "the image ran out" from "our
       * cleanup merged them": 16 requested, 16 found, 8 delivered is a
       * shortfall of 8 and nothing to do with the picture.
       */
      paletteShortfall:
        Array.isArray(result.palette) && typeof result.sourceColors === 'number'
          ? Math.max(
              0,
              Math.min(settings.colorCount, result.sourceColors) - result.palette.length,
            )
          : null,
      reportedPathCount: typeof result.pathCount === 'number' ? result.pathCount : null,
      svgBytes: structure.bytes,
      wallClockMs,
      engineReportedMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    };

    /**
     * The salient region. REFERENCE's blind A/B is lost or won on the part of
     * the picture a person looks at, and every whole-frame number here is
     * area-weighted: the gold-standard face is 8 % of the canvas, so losing the
     * mouth and both fangs moved `inkRecall` by 0.03 and MAE by 1.5 while every
     * gate stayed green. Same metrics, computed inside the crop.
     */
    const regions = salientRegions(fixture);
    if (regions.length) {
      metrics.regions = [];
      for (const [i, region] of regions.entries()) {
        const refRegion = cropRegion(reference, region);
        const outRegion = cropRegion(traced, region);
        metrics.regions.push({
          name: region.name,
          box: { x: region.x, y: region.y, width: region.width, height: region.height },
          inkRecall: inkRecall(refRegion, outRegion),
          strictInkRecall: strictInkRecall(refRegion, outRegion),
          inkComponentRatio: inkComponentRatio(refRegion, outRegion),
          meanColorError: meanColorError(refRegion, outRegion),
          ssim: ssim(refRegion, outRegion),
        });
        const crop = join(
          artifactsDir,
          'region',
          i === 0 ? `${fixture.id}.png` : `${fixture.id}-${region.name}.png`,
        );
        await sharp(
          Buffer.from(outRegion.data.buffer, outRegion.data.byteOffset, outRegion.data.byteLength),
          { raw: { width: outRegion.width, height: outRegion.height, channels: 4 } },
        )
          .png()
          .toFile(crop);
      }
      // Gates read the WORST region: a fixture that names two crops is asking
      // that BOTH survive, so adding one can only ever tighten the fixture.
      const worst = (key, dir) => {
        const vals = metrics.regions.map((r) => r[key]).filter((v) => v != null);
        if (!vals.length) return null;
        return dir === 'min' ? Math.min(...vals) : Math.max(...vals);
      };
      metrics.salientRegion = metrics.regions[0].box;
      metrics.regionInkRecall = worst('inkRecall', 'min');
      metrics.regionStrictInkRecall = worst('strictInkRecall', 'min');
      metrics.regionInkComponentRatio = worst('inkComponentRatio', 'max');
      metrics.regionMeanColorError = worst('meanColorError', 'max');
      metrics.regionSsim = worst('ssim', 'min');
    }

    /**
     * D3/D2 structure. Computed only for fixtures that gate it, because the
     * converters serialize the whole drawing and the photo fixture's DXF is
     * tens of megabytes of geometry nobody reads.
     */
    const gatesExports =
      fixture.thresholds?.minDxfSplines != null || fixture.thresholds?.maxDxfEpsBytesRatio != null;
    if (gatesExports && typeof engine.toDxf === 'function' && typeof engine.toEps === 'function') {
      try {
        const dxf = engine.toDxf(result);
        const eps = engine.toEps(result);
        metrics.dxfBytes = Buffer.byteLength(dxf, 'utf8');
        metrics.epsBytes = Buffer.byteLength(eps, 'utf8');
        metrics.dxfSplineCount = (dxf.match(/\n\s*0\nSPLINE\b/g) ?? []).length;
        metrics.dxfVertexCount = (dxf.match(/\n\s*0\nVERTEX\b/g) ?? []).length;
        metrics.epsCurveCount = (eps.match(/\bcurveto\b/g) ?? []).length;
        metrics.dxfEpsBytesRatio = metrics.dxfBytes / Math.max(1, metrics.epsBytes);
      } catch (err) {
        metrics.exportError = err.message;
      }
    }

    let exemplar = null;
    if (fixture.exemplar) {
      exemplar = await measureExemplar(fixture.exemplar, source, regions);
      if (!exemplar.error) {
        metrics.exemplarBytesRatio = metrics.svgBytes / exemplar.bytes;
        metrics.exemplarSubPathRatio = metrics.subPathCount / Math.max(1, exemplar.subPathCount);
        metrics.exemplarPathRatio = metrics.pathCount / Math.max(1, exemplar.pathCount);
        metrics.exemplarMeanColorErrorRatio =
          metrics.meanColorError / Math.max(0.01, exemplar.meanColorError);
        metrics.exemplarCurveCommandRatio = exemplar.curveCommandRatio;
        metrics.exemplarInkRecall = exemplar.inkRecall;
        metrics.exemplarStrictInkRecall = exemplar.strictInkRecall;
        metrics.exemplarLayerCompactness = exemplar.layerCompactness;
        if (metrics.layerCompactness != null && exemplar.layerCompactness) {
          metrics.layerCompactnessRatio = metrics.layerCompactness / exemplar.layerCompactness;
        }
        if (metrics.regions && exemplar.regions?.length) {
          for (const [i, r] of metrics.regions.entries()) {
            const e = exemplar.regions[i];
            if (!e) continue;
            r.exemplarInkRecall = e.inkRecall;
            r.exemplarStrictInkRecall = e.strictInkRecall;
            r.exemplarMeanColorError = e.meanColorError;
            r.inkRecallRatio = r.inkRecall / Math.max(0.01, e.inkRecall);
            r.strictInkRecallRatio = r.strictInkRecall / Math.max(0.01, e.strictInkRecall);
          }
          // < 1 means the real product renders the salient region better than
          // we do — the blind A/B, as one number, in the region where we are
          // worst relative to it.
          metrics.exemplarRegionInkRecall = exemplar.regions[0].inkRecall;
          metrics.regionInkRecallRatio = Math.min(
            ...metrics.regions.filter((r) => r.inkRecallRatio != null).map((r) => r.inkRecallRatio),
          );
          const strict = metrics.regions
            .filter((r) => r.strictInkRecallRatio != null)
            .map((r) => r.strictInkRecallRatio);
          metrics.regionStrictInkRecallRatio = strict.length ? Math.min(...strict) : null;
        }
      }
    }

    const failures = checkThresholds(metrics, fixture.thresholds);
    if (failures.length) failed++;
    results.push({
      id: fixture.id,
      file: fixture.file,
      kind: fixture.kind,
      status: failures.length ? 'FAIL' : 'pass',
      settings,
      metrics,
      exemplar,
      thresholds: fixture.thresholds ?? null,
      failures,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    settings: baseSettings,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'pass').length,
      failed,
      notImplemented,
      skipped: results.filter((r) => r.status === 'skipped/unsupported').length,
    },
    results,
  };

  await fs.mkdir(dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, JSON.stringify(report, null, 2) + '\n');

  console.log(table(results));
  console.log('');
  for (const r of results) {
    if (r.exemplar && !r.exemplar.error) {
      const e = r.exemplar;
      console.log(
        `  ${r.id}: vs exemplar ${e.file} — bytes ${fmt(r.metrics.exemplarBytesRatio)}x, ` +
          `subpaths ${fmt(r.metrics.exemplarSubPathRatio)}x (${r.metrics.subPathCount} vs ${e.subPathCount}), ` +
          `paths ${fmt(r.metrics.exemplarPathRatio)}x (${r.metrics.pathCount} vs ${e.pathCount}), ` +
          `curve ratio ${fmt(r.metrics.curveCommandRatio, 3)} vs ${fmt(e.curveCommandRatio, 3)}, ` +
          `MAE ${fmt(r.metrics.meanColorError)} vs ${fmt(e.meanColorError)}, ` +
          `layer compactness ${fmt(r.metrics.layerCompactness)} vs ${fmt(e.layerCompactness)} ` +
          `(${fmt(r.metrics.layerCompactnessRatio)}x) ` +
          `(exemplar rasterized from its ${e.contentBox?.width}x${e.contentBox?.height} content box)`,
      );
    }
    for (const region of r.metrics?.regions ?? []) {
      const box = region.box;
      console.log(
        `  ${r.id}: region "${region.name}" ${box.width}x${box.height}@${box.x},${box.y} — ` +
          `ink ${fmt(region.inkRecall, 4)}` +
          (region.exemplarInkRecall != null
            ? ` vs exemplar ${fmt(region.exemplarInkRecall, 4)} (${fmt(region.inkRecallRatio)}x)`
            : '') +
          `, strict ink ${fmt(region.strictInkRecall, 4)}` +
          (region.exemplarStrictInkRecall != null
            ? ` vs ${fmt(region.exemplarStrictInkRecall, 4)} (${fmt(region.strictInkRecallRatio)}x)`
            : '') +
          `, MAE ${fmt(region.meanColorError)}` +
          (region.exemplarMeanColorError != null
            ? ` vs ${fmt(region.exemplarMeanColorError)}`
            : '') +
          `, SSIM ${fmt(region.ssim, 4)}, ink components ${fmt(region.inkComponentRatio, 2)}x source`,
      );
    }
    if (r.metrics?.paletteShortfall > 0) {
      console.log(
        `  ${r.id}: palette — ${r.metrics.paletteSize} delivered of ${r.settings.colorCount} ` +
          `requested (${r.metrics.sourceColors} found in the image); our folds merged ` +
          `${r.metrics.paletteShortfall} away`,
      );
    }
    if (r.metrics?.dxfBytes != null) {
      console.log(
        `  ${r.id}: exports — DXF ${fmt(r.metrics.dxfBytes / 1024, 1)} KB ` +
          `(${r.metrics.dxfSplineCount} SPLINE, ${r.metrics.dxfVertexCount} VERTEX) vs ` +
          `EPS ${fmt(r.metrics.epsBytes / 1024, 1)} KB (${r.metrics.epsCurveCount} curveto) — ` +
          `${fmt(r.metrics.dxfEpsBytesRatio)}x`,
      );
    }
    if (r.metrics?.sourceTransparentRatio > 0) {
      console.log(
        `  ${r.id}: source is ${(r.metrics.sourceTransparentRatio * 100).toFixed(1)}% transparent — ` +
          `backdrop ${r.metrics.backdropFill ?? 'none'}, ` +
          `colour painted over the transparent area ${fmt(r.metrics.transparentAreaColorError)}/255`,
      );
    }
    if (r.exemplar?.error) console.log(`  ${r.id}: exemplar unreadable — ${r.exemplar.error}`);
    if (r.failures?.length) console.log(`  ${r.id}: ${r.failures.join('; ')}`);
    if (r.error) console.log(`  ${r.id}: ${r.error.split('\n')[0]}`);
  }
  console.log(
    `\n${report.summary.passed} pass · ${report.summary.failed} fail · ` +
      `${report.summary.notImplemented} not-implemented · ${report.summary.skipped} skipped`,
  );
  console.log(`wrote ${metricsPath}`);

  if (notImplemented > 0 && failed === 0 && report.summary.passed === 0) process.exit(2);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
