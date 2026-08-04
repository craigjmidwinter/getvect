#!/usr/bin/env node
/**
 * `npm run instruments` — the fidelity light meter.
 *
 * For every supported fixture it:
 *   1. decodes the source raster (sharp; BMP via instruments/lib/decode.mjs),
 *   2. calls the engine's pure `vectorize()` headlessly (dist/engine/index.js),
 *   3. rasterizes the produced SVG back to the SOURCE dimensions with resvg,
 *   4. measures mean/RMS colour error, SSIM, mismatch ratio, path count,
 *      SVG byte size and wall-clock ms,
 *   5. compares each against the fixture's thresholds (fixtures/manifest.json,
 *      derived from REFERENCE.md "Quality bar").
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
  countPaths,
  countShapes,
  meanColorError,
  pixelMismatchRatio,
  psnr,
  rmsColorError,
  ssim,
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

function checkThresholds(m, t) {
  if (!t) return [];
  const failures = [];
  if (t.meanColorError != null && m.meanColorError > t.meanColorError)
    failures.push(`meanColorError ${m.meanColorError.toFixed(2)} > ${t.meanColorError}`);
  if (t.ssim != null && m.ssim < t.ssim) failures.push(`ssim ${m.ssim.toFixed(4)} < ${t.ssim}`);
  if (t.maxPaths != null && m.pathCount > t.maxPaths)
    failures.push(`pathCount ${m.pathCount} > ${t.maxPaths}`);
  if (t.maxBytes != null && m.svgBytes > t.maxBytes)
    failures.push(`svgBytes ${m.svgBytes} > ${t.maxBytes}`);
  if (t.maxMs != null && m.wallClockMs > t.maxMs)
    failures.push(`wallClockMs ${m.wallClockMs.toFixed(0)} > ${t.maxMs}`);
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
    ['status', (r) => r.status, 20],
    ['MAE/255', (r) => fmt(r.metrics?.meanColorError), 8],
    ['SSIM', (r) => fmt(r.metrics?.ssim, 4), 8],
    ['PSNR', (r) => fmt(r.metrics?.psnrDb, 1), 7],
    ['paths', (r) => (r.metrics ? String(r.metrics.pathCount) : '—'), 7],
    ['SVG KB', (r) => fmt(r.metrics ? r.metrics.svgBytes / 1024 : null, 1), 8],
    ['ms', (r) => fmt(r.metrics?.wallClockMs, 0), 7],
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

  const settings = { ...engine.DEFAULT_SETTINGS };
  const results = [];
  let notImplemented = 0;
  let failed = 0;

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
    await writeDiff(source, traced, join(artifactsDir, 'diff', `${fixture.id}.png`));

    const metrics = {
      width: source.width,
      height: source.height,
      meanColorError: meanColorError(source, traced),
      rmsColorError: rmsColorError(source, traced),
      psnrDb: psnr(source, traced),
      ssim: ssim(source, traced),
      pixelMismatchRatio: pixelMismatchRatio(source, traced),
      pathCount: countPaths(result.svg),
      shapeCount: countShapes(result.svg),
      paletteSize: Array.isArray(result.palette) ? result.palette.length : null,
      reportedPathCount: typeof result.pathCount === 'number' ? result.pathCount : null,
      svgBytes: Buffer.byteLength(result.svg, 'utf8'),
      wallClockMs,
      engineReportedMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    };

    const failures = checkThresholds(metrics, fixture.thresholds);
    if (failures.length) failed++;
    results.push({
      id: fixture.id,
      file: fixture.file,
      kind: fixture.kind,
      status: failures.length ? 'FAIL' : 'pass',
      metrics,
      thresholds: fixture.thresholds ?? null,
      failures,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    settings,
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
