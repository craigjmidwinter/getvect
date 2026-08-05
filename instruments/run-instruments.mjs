#!/usr/bin/env node
/**
 * `npm run instruments` — the fidelity light meter.
 *
 * For every supported fixture it:
 *   1. decodes the source raster (sharp; BMP via instruments/lib/decode.mjs),
 *   2. calls the engine's pure `vectorize()` headlessly (dist/engine/index.js),
 *   3. rasterizes the produced SVG back to the SOURCE dimensions with resvg,
 *   4. measures mean/RMS colour error, SSIM, mismatch ratio, per-colour area
 *      drift, path AND sub-path counts, speck ratio, curve-command ratio,
 *      near-duplicate colour layers, SVG byte size and wall-clock ms,
 *   5. compares each against the fixture's thresholds (fixtures/manifest.json,
 *      derived from REFERENCE.md "Quality bar"), including ratios against a
 *      real the reference product exemplar when the fixture declares one.
 *
 * Outputs:
 *   artifacts/metrics.json          machine-readable, one record per fixture
 *   artifacts/vector/<id>.svg       the engine's output
 *   artifacts/raster/<id>.png       that SVG re-rasterized at source size
 *   artifacts/diff/<id>.png         amplified absolute difference
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
import { Resvg } from '@resvg/resvg-js';
import { decodeImageFile, flattenOnWhite } from './lib/decode.mjs';
import {
  inkRecall,
  meanColorError,
  perColorCoverageDelta,
  pixelMismatchRatio,
  psnr,
  rmsColorError,
  ssim,
  svgStructure,
} from './lib/metrics.mjs';

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

async function rasterizeSvg(svg, width, height) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'white',
    font: { loadSystemFonts: false },
  });
  const png = resvg.render().asPng();
  const { data, info } = await sharp(png)
    .resize(width, height, { fit: 'fill', kernel: 'nearest' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    png,
    image: {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    },
  };
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

  for (const sub of ['vector', 'raster', 'diff']) {
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
  async function measureExemplar(relPath, source) {
    if (exemplarCache.has(relPath)) return exemplarCache.get(relPath);
    let measured = null;
    try {
      const svg = await fs.readFile(join(fixturesDir, relPath), 'utf8');
      const rendered = await rasterizeSvg(svg, source.width, source.height);
      const traced = flattenOnWhite(rendered.image);
      measured = {
        file: relPath,
        ...svgStructure(svg),
        meanColorError: meanColorError(source, traced),
        ssim: ssim(source, traced),
      };
    } catch (err) {
      measured = { file: relPath, error: err.message };
    }
    exemplarCache.set(relPath, measured);
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
    const source = flattenOnWhite(await decodeImageFile(filePath));
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
      result = await engine.vectorize(source, settings, () => {});
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
      // How much each palette colour's area drifted between source and trace:
      // catches half-pixel erosion of hairlines that MAE/SSIM average away.
      perColorCoverageDelta: Array.isArray(result.palette)
        ? perColorCoverageDelta(reference, traced, result.palette)
        : null,
      pathCount: structure.pathCount,
      shapeCount: structure.shapeCount,
      subPathCount: structure.subPathCount,
      tinySubPathRatio: structure.tinySubPathRatio,
      curveCommandRatio: structure.curveCommandRatio,
      cubicCount: structure.cubicCount,
      layerCount: structure.layerCount,
      nearDuplicateFillPairs: structure.nearDuplicateFillPairs,
      paletteSize: Array.isArray(result.palette) ? result.palette.length : null,
      reportedPathCount: typeof result.pathCount === 'number' ? result.pathCount : null,
      svgBytes: structure.bytes,
      wallClockMs,
      engineReportedMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    };

    let exemplar = null;
    if (fixture.exemplar) {
      exemplar = await measureExemplar(fixture.exemplar, source);
      if (!exemplar.error) {
        metrics.exemplarBytesRatio = metrics.svgBytes / exemplar.bytes;
        metrics.exemplarSubPathRatio = metrics.subPathCount / Math.max(1, exemplar.subPathCount);
        metrics.exemplarPathRatio = metrics.pathCount / Math.max(1, exemplar.pathCount);
        metrics.exemplarMeanColorErrorRatio =
          metrics.meanColorError / Math.max(0.01, exemplar.meanColorError);
        metrics.exemplarCurveCommandRatio = exemplar.curveCommandRatio;
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
          `MAE ${fmt(r.metrics.meanColorError)} vs ${fmt(e.meanColorError)}`,
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
