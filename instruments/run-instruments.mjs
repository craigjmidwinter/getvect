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
 *      boundary compactness, foreign-colour leak inside the salient regions,
 *      palette shortfall, path AND sub-path counts, speck
 *      ratio, curve-command ratio, near-duplicate colour layers, SVG byte size
 *      and wall-clock ms,
 *   5. compares each against the fixture's thresholds (fixtures/manifest.json,
 *      derived from REFERENCE.md "Quality bar"), including ratios against a
 *      reference product exemplar when the fixture declares one.
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
 *   artifacts/local/...             the same four for a LOCAL fixture (see
 *                                   docs/HARNESS.md "Local fixtures"): artwork we
 *                                   may measure against but never redistribute
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
// exemplars exactly the way the instruments do — see the note there about
// registering an exemplar against the source.
import { rasterizeExemplarContent, rasterizeSvg } from './lib/render.mjs';
import {
  alphaMask,
  boundarySmoothness,
  colorPresenceProfile,
  cropRegion,
  featureCornerAngles,
  foreignColorRatio,
  parseColor,
  inkComponentRatio,
  inkCoverageProfile,
  inkRecall,
  layerCompactness,
  maskedMeanColorError,
  meanColorError,
  perColorCoverageDelta,
  pixelMismatchRatio,
  psnr,
  rmsColorError,
  seamSlivers,
  shadingBandQuality,
  sharpFeatureSurvival,
  ssim,
  strictInkRecall,
  strokeWidthProfile,
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
  /**
   * A region may also NAME A COLOUR (`color`, optionally `colorTolerance`), and
   * then every side of the comparison is additionally asked whether that colour
   * survived into it (metrics.mjs `colorPresenceProfile`). The eyes of a mascot
   * are the case: a hue-distinct feature small enough that losing its palette
   * slot entirely moves no other number in this file.
   */
  const withColor = (r, i) => {
    const region = { name: r.name ?? `region${i + 1}`, ...r };
    if (r.color) {
      const parse = (value, field) => {
        const parsed = parseColor(value);
        if (!parsed) {
          throw new Error(
            `fixture ${fixture.id}: region "${region.name}" has an unparseable ${field} "${value}"`,
          );
        }
        return parsed;
      };
      region.colorTarget = parse(r.color, 'color');
      region.colorOpts = r.colorTolerance != null ? { tolerance: r.colorTolerance } : {};
      /**
       * The exemplar may draw the same feature a DIFFERENT colour, and then
       * measuring it against ours is a lie in both directions.
       *
       * The reference product's Enhance is a generative re-illustration, so it does
       * not preserve the source's colours — it repaints them. On the mascot it
       * repaints the source's olive eyes, rgb(187,161,80), as a saturated green,
       * rgb(121,176,89), and gives that green its own output layer. Scored
       * against the source's olive the exemplar keeps 1.9 % of it and we keep
       * 0.6 %, which reads as a photo finish and is the opposite of what the two
       * pictures show: theirs has green eyes and ours has none. Each side is
       * measured against the colour it actually uses; the comparison is then
       * "how much of a distinct eye colour did each drawing deliver".
       */
      region.exemplarColorTarget = r.exemplarColor
        ? parse(r.exemplarColor, 'exemplarColor')
        : region.colorTarget;
    }
    return region;
  };
  if (Array.isArray(fixture.salientRegions)) return fixture.salientRegions.map(withColor);
  if (fixture.salientRegion) return [withColor(fixture.salientRegion, 0)];
  return [];
}

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(root, 'fixtures');
const localDir = join(fixturesDir, 'local');

/**
 * The LOCAL FIXTURE OVERLAY.
 *
 * Some of the artwork this engine most needs to be measured against cannot be
 * redistributed — the repo is public, and the best *shaded* test subject we ever
 * had was purged from the tree and from git history for licensing. Purging it
 * also deleted the only measurement of a whole class of failure, and a class of
 * failure nothing measures is a class of failure that rots.
 *
 * So: `fixtures/local/` is git-ignored in its entirety (see .gitignore — nothing
 * under it is tracked, not even a .gitkeep), and if it contains a
 * `manifest.local.json` its `fixtures[]` are appended to the tracked set at
 * instruments runtime. Entries mirror the tracked manifest's schema exactly,
 * with every path (`file`, `exemplar`, `compareTo`) relative to
 * `fixtures/local/`.
 *
 * Two properties this must have, and they are the whole design:
 *
 *  - **Absence is never a failure.** No directory, no manifest, unreadable
 *    manifest, missing image — all of them log at most one line and run the
 *    tracked set exactly as before. A fresh clone and CI see zero difference.
 *  - **`npm run fixtures` cannot leak it.** The merge happens *here*, in the
 *    consumer, not in the generator, so nothing local can ever be written into
 *    the tracked `fixtures/manifest.json`.
 *
 * Local rows print with a `[local]` marker so nobody mistakes one of these
 * numbers for something a reviewer can reproduce, and their artifacts land under
 * `artifacts/local/` rather than beside the tracked ones.
 */
async function loadFixtures() {
  const manifest = JSON.parse(await fs.readFile(join(fixturesDir, 'manifest.json'), 'utf8'));
  const tracked = manifest.fixtures.map((f) => ({ ...f, local: false, baseDir: fixturesDir }));

  let localManifest;
  try {
    localManifest = JSON.parse(await fs.readFile(join(localDir, 'manifest.local.json'), 'utf8'));
  } catch (err) {
    // ENOENT is the normal case (a clone with no overlay). Anything else is a
    // broken overlay, which is still not allowed to fail the tracked run.
    if (err.code !== 'ENOENT') {
      console.log(`  [local] fixtures/local/manifest.local.json unreadable — ${err.message}`);
    }
    return { manifest, fixtures: tracked };
  }
  const local = (localManifest.fixtures ?? []).map((f) => ({
    ...f,
    local: true,
    baseDir: localDir,
  }));
  if (local.length) {
    console.log(
      `  [local] overlaying ${local.length} fixture${local.length === 1 ? '' : 's'} from ` +
        `fixtures/local/manifest.local.json (never committed — docs/HARNESS.md)`,
    );
  }
  return { manifest, fixtures: [...tracked, ...local] };
}

/** Where a fixture's `id` writes its side outputs — local rows stay segregated. */
const outDirOf = (fixture, sub) =>
  fixture.local ? join(artifactsDir, 'local', sub) : join(artifactsDir, sub);

/** How a fixture names itself in stdout. */
const labelOf = (fixture) => (fixture.local ? `[local] ${fixture.id}` : fixture.id);

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
  // Colour LEAK, not colour distance: the share of a crop painted a hue the
  // source crop does not contain at all. Teal specks inside a cream face move
  // MAE by hundredths and SSIM by nothing, and are the first thing a person
  // names (metrics.mjs `foreignColorRatio`).
  ['maxRegionForeignColorRatio', 'regionForeignColorRatio', 'max', (v) => `${(v * 100).toFixed(2)}%`],
  ['minRegionSsim', 'regionSsim', 'min', (v) => v.toFixed(4)],
  // Did the small sharp features survive as separate, still-pointed shapes, and
  // did a crack open between two layers? (metrics.mjs `sharpFeatureSurvival`,
  // `featureCornerAngles`, `seamSlivers`.) Every other number in this file
  // reports health for a picture whose claws have welded into a black chain and
  // whose outlines carry a white hairline: the ink is all present, the colours
  // are right, the shape count barely moves.
  ['minFeatureComponentRatio', 'featureComponentRatio', 'min', (v) => `${v.toFixed(2)}x`],
  ['minSpikeCornerAngle', 'minCornerAngle', 'min', (v) => `${v.toFixed(0)}°`],
  ['maxSliverRatio', 'sliverRatio', 'max', (v) => `${(v * 100).toFixed(3)}%`],
  ['minRegionFeatureComponentRatio', 'regionFeatureComponentRatio', 'min', (v) => `${v.toFixed(2)}x`],
  // Ink SPEND in the worst crop (metrics.mjs `inkCoverageProfile`). Every other
  // ink number here rewards a stroke that filled in; this is the one that can
  // see a thin outline with a notch arrive as a solid black wedge.
  ['maxRegionInkCoverageRatio', 'regionInkCoverageRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxRegionSliverRatio', 'regionSliverRatio', 'max', (v) => `${(v * 100).toFixed(3)}%`],
  ['minRegionSpikeCornerAngle', 'regionMinCornerAngle', 'min', (v) => `${v.toFixed(0)}°`],
  // Continuity, not just survival. `inkRecall` accepts anything darker than 128,
  // so a contour thinned to a grey smear or broken into dashes still scores ~1;
  // `strictInkRecall` demands the source's ink come back as ink.
  ['minStrictInkRecall', 'strictInkRecall', 'min', (v) => v.toFixed(4)],
  ['minRegionStrictInkRecall', 'regionStrictInkRecall', 'min', (v) => v.toFixed(4)],
  // ...and the same question asked against the reference product instead of against
  // an invented constant: < 1 means its outlines are more solid than ours in the
  // region where we are worst. A whole-frame absolute bar cannot be used here —
  // the exemplar itself scores 0.859 globally because it drops antialiased
  // skirts, while inside the paw it scores 0.984 to our 0.943.
  ['minRegionStrictInkRecallRatio', 'regionStrictInkRecallRatio', 'min', (v) => `${v.toFixed(3)}x`],
  // Stroke-width UNIFORMITY, the one thing that decided REFERENCE's blind A/B
  // and that every other ink metric here read backwards (metrics.mjs
  // `strokeWidthProfile`): a line that thickens, thins and breaks recalls MORE
  // ink and joins MORE components than an even one, so `strictInkRecall` scored
  // us 0.967 against the reference product's 0.755 for a mouth arc that tapered to a
  // spindle and detached from both fangs. Gated as a ratio to the exemplar's own
  // cv on the same crop, and paired with how much fatter our line is than its.
  ['maxStrokeWidthCvRatio', 'strokeWidthCvRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxStrokeWidthOverExemplar', 'strokeWidthOverExemplar', 'max', (v) => `${v.toFixed(2)}x`],
  // Soft-shading banding (metrics.mjs `shadingBandQuality`): is each band the
  // colour of what it covers, and how visible is the seam between two of them?
  // The only question in this file that is not about an edge, and the only one
  // that can see a smooth warm face quantized into cream + muddy grey with a
  // hard seam drawn across it — every edge metric reports health for that
  // picture, because its outline is fine.
  ['maxRegionBandFit', 'regionBandFit', 'max', (v) => v.toFixed(2)],
  ['maxRegionBandStep', 'regionBandStep', 'max', (v) => v.toFixed(1)],
  ['maxRegionBandStepExcess', 'regionBandStepExcess', 'max', (v) => v.toFixed(1)],
  ['maxShadingBandFitRatio', 'shadingBandFitRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxShadingBandStepRatio', 'shadingBandStepRatio', 'max', (v) => `${v.toFixed(2)}x`],
  // Boundary raggedness of the colour layers (metrics.mjs `layerCompactness`):
  // the sawtooth-vs-sweep difference between clipart and a posterized photo.
  ['maxLayerCompactness', 'layerCompactness', 'max', (v) => v.toFixed(2)],
  ['maxLayerCompactnessRatio', 'layerCompactnessRatio', 'max', (v) => `${v.toFixed(2)}x`],
  // The LOCAL form of the same question (metrics.mjs `layerBoundaryWobble`):
  // turning per unit boundary length. Compactness is a global perimeter/area
  // ratio and cannot tell an intricate shape from a smooth one traced onto a
  // noisy threshold; this walks both boundaries at the same step and asks how
  // much the heading changes per unit travelled.
  ['maxLayerWobble', 'layerWobble', 'max', (v) => v.toFixed(1)],
  ['maxLayerWobbleRatio', 'layerWobbleRatio', 'max', (v) => `${v.toFixed(2)}x`],
  // The same question asked where the answer is a FACT (metrics.mjs
  // `boundarySmoothness`): on a fixture whose arcs the generator drew from an
  // equation, how far does the fitted boundary sit from the circle it is
  // tracing? Every other geometry bar here compares us with a smoothed copy of
  // ourselves or with the reference product, and neither knows what the shape
  // was supposed to be.
  ['maxArcResidualRms', 'arcResidualRms', 'max', (v) => `${v.toFixed(3)}px`],
  ['maxArcResidualMax', 'arcResidualMax', 'max', (v) => `${v.toFixed(3)}px`],
  // ...and the same question with no equation required (metrics.mjs
  // `staircaseIndex`): how much of this boundary's turning CANCELS at pixel
  // scale? `Local` is the one-off notch, `Sustained` is the repeating stair.
  // A corner reads zero in both, which is the whole point of the measure.
  // Needs no judgement: the canvas size is a fact about the input. A fitted
  // curve outside it is geometry the boundary never had.
  ['maxCanvasOverflow', 'canvasOverflow', 'max', (v) => `${v.toFixed(2)}px`],
  ['maxStaircaseLocal', 'staircaseLocal', 'max', (v) => v.toFixed(4)],
  ['maxStaircaseSustained', 'staircaseSustained', 'max', (v) => v.toFixed(4)],
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

/**
 * Gates a fixture may hang on ONE named region instead of on the worst one.
 *
 * The aggregate `maxRegionMeanColorError` reads the worst crop, which is the
 * right default (adding a box can only tighten a fixture) and the wrong tool
 * when two crops deserve different numbers: on the gold standard at
 * DEFAULT_SETTINGS the paw-pad bar is 22 because the reference product's own
 * six-colour output scores 21.89 there, while the face has to be held at the
 * exemplar's 19.13 and at ~0 colour leak. One aggregate number cannot say both,
 * and the old way to say the stricter one — raise the aggregate — would have
 * failed the paw for the face's sake and taught nobody anything.
 */
const REGION_GATES = [
  ['maxMeanColorError', 'meanColorError', 'max', (v) => v.toFixed(2)],
  ['minSsim', 'ssim', 'min', (v) => v.toFixed(4)],
  ['minInkRecall', 'inkRecall', 'min', (v) => v.toFixed(4)],
  ['minStrictInkRecall', 'strictInkRecall', 'min', (v) => v.toFixed(4)],
  ['maxInkComponentRatio', 'inkComponentRatio', 'max', (v) => `${v.toFixed(2)}x`],
  // "All of the source's ink, and no more" — the second half of that sentence,
  // which `inkRecall` / `strictInkRecall` / `inkComponentRatio` all read as a
  // win (metrics.mjs `inkCoverageProfile`).
  ['maxInkCoverageRatio', 'inkCoverageRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['minInkCoverageRatio', 'inkCoverageRatio', 'min', (v) => `${v.toFixed(2)}x`],
  ['maxForeignColorRatio', 'foreignColorRatio', 'max', (v) => `${(v * 100).toFixed(2)}%`],
  // Did the colour this crop is ABOUT survive (metrics.mjs
  // `colorPresenceProfile`)? Against the source's own share of it, and against
  // the reference product's trace of the same pixels.
  ['minColorPresenceRatio', 'colorPresenceRatio', 'min', (v) => `${(v * 100).toFixed(1)}% of source`],
  ['minColorPresenceOverExemplar', 'colorPresenceOverExemplar', 'min', (v) => `${v.toFixed(2)}x`],
  ['minColorPresence', 'colorPresence', 'min', (v) => `${(v * 100).toFixed(2)}% of crop`],
  ['maxStrokeWidthCvRatio', 'strokeWidthCvRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['maxBandFit', 'bandFit', 'max', (v) => v.toFixed(2)],
  ['maxBandStep', 'bandStep', 'max', (v) => v.toFixed(1)],
  ['maxBandStepExcess', 'bandStepExcess', 'max', (v) => v.toFixed(1)],
  ['maxBandFitRatio', 'bandFitRatio', 'max', (v) => `${v.toFixed(2)}x`],
  ['minFeatureComponentRatio', 'featureComponentRatio', 'min', (v) => `${v.toFixed(2)}x`],
  ['minSpikeCornerAngle', 'minCornerAngle', 'min', (v) => `${v.toFixed(0)}°`],
  ['maxSliverRatio', 'sliverRatio', 'max', (v) => `${(v * 100).toFixed(3)}%`],
];

/**
 * Thresholds that are declared but can never fire, because the metric they name
 * is not being produced for this fixture.
 *
 * `checkThresholds` skips a null metric, which is the right behaviour for a bar
 * that simply does not apply — and the wrong behaviour for a bar that USED to
 * apply and quietly stopped. When the vendored exemplars were removed, every
 * `*OverExemplar` and `*Ratio`-against-the-exemplar gate in the manifest became
 * a line of JSON that looks like a promise and checks nothing. This project has
 * shipped a gate that was never wired to anything once already; this is how it
 * finds out the second time.
 */
function deadGates(m, t, gates = GATES) {
  if (!t) return [];
  const dead = [];
  const known = new Map(gates.map(([key, metric]) => [key, metric]));
  for (const key of Object.keys(t)) {
    if (!known.has(key)) {
      dead.push(`${key} (no such gate)`);
      continue;
    }
    const metric = known.get(key);
    const value = m[metric];
    if (value == null || !Number.isFinite(value)) dead.push(`${key} -> ${metric} is not measured`);
  }
  return dead;
}

function checkThresholds(m, t, gates = GATES) {
  if (!t) return [];
  const failures = [];
  for (const [key, metric, dir, fmtV] of gates) {
    const limit = t[key];
    const value = m[metric];
    if (limit == null || value == null || !Number.isFinite(value)) continue;
    if (dir === 'max' ? value > limit : value < limit) {
      // The limit goes through the metric's own formatter too, so a ratio bar
      // reads "0.50% > 0.05%" rather than "0.50% > 0.0005".
      failures.push(`${metric} ${fmtV(value)} ${dir === 'max' ? '>' : '<'} ${fmtV(limit)}`);
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
    ['fixture', (r) => r.label ?? r.id, 28],
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
    // Turning per unit boundary length: a smooth arc through a shading gradient
    // is small, a sawtooth through the same gradient is large. The number the
    // belly seam and the paw pad are lost on.
    ['wobble', (r) => fmt(r.metrics?.layerWobble, 1), 7],
    // Worst region's foreign-colour leak, as a percentage of the crop: a
    // colour the source crop does not contain, painted into it.
    [
      'leak%',
      (r) =>
        fmt(
          r.metrics?.regionForeignColorRatio != null
            ? r.metrics.regionForeignColorRatio * 100
            : null,
          2,
        ),
      6,
    ],
    ['SVG KB', (r) => fmt(r.metrics ? r.metrics.svgBytes / 1024 : null, 1), 8],
    ['ms', (r) => fmt(r.metrics?.wallClockMs, 0), 6],
  ];
  const head = cols.map(([h, , w]) => h.padEnd(w)).join(' ');
  const sep = cols.map(([, , w]) => '-'.repeat(w)).join(' ');
  const body = rows.map((r) => cols.map(([, get, w]) => String(get(r)).padEnd(w)).join(' '));
  return [head, sep, ...body].join('\n');
}

async function main() {
  const { fixtures } = await loadFixtures();
  const engine = await loadEngine();

  for (const sub of ['vector', 'raster', 'diff', 'region']) {
    await fs.mkdir(join(artifactsDir, sub), { recursive: true });
    if (fixtures.some((f) => f.local)) {
      await fs.mkdir(join(artifactsDir, 'local', sub), { recursive: true });
    }
  }

  const baseSettings = { ...engine.DEFAULT_SETTINGS };
  const results = [];
  let notImplemented = 0;
  let failed = 0;
  /** Cache of measured exemplar SVGs, keyed by file. */
  const exemplarCache = new Map();

  /**
   * Measure a gold-standard exemplar (reference product output shipped in
   * fixtures/reference/) the same way we measure ours, so the comparison
   * REFERENCE lines 80-83 asks for is a number instead of an eyeball.
   */
  async function measureExemplar(relPath, source, regions, baseDir = fixturesDir) {
    const cacheKey = `${baseDir}::${relPath}::${JSON.stringify(regions ?? [])}`;
    if (exemplarCache.has(cacheKey)) return exemplarCache.get(cacheKey);
    let measured = null;
    try {
      const svg = await fs.readFile(join(baseDir, relPath), 'utf8');
      // Straight viewBox rasterization, kept for context only — it is what the
      // gate used to be scored on and it is meaningless for an exemplar whose
      // artwork does not fill its declared viewBox.
      const asDeclared = flattenOnWhite(
        (await rasterizeSvg(svg, source.width, source.height)).image,
      );
      // The source itself, so the registration is chosen by measuring both
      // candidate alignments rather than by guessing from the declared size
      // (see render.mjs).
      const fair = await rasterizeExemplarContent(svg, source.width, source.height, source);
      const traced = fair.image;
      measured = {
        file: relPath,
        ...svgStructure(svg),
        contentBox: fair.contentBox,
        registration: fair.registration,
        registrationError: fair.registrationError,
        registrationRejected: fair.registrationRejected,
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
            ...inkCoverageProfile(a, b),
            meanColorError: meanColorError(a, b),
            foreignColorRatio: foreignColorRatio(a, b),
            // Did the region's named colour survive into the REFERENCE PRODUCT's
            // output? This is the half of the eyes question that makes ours a
            // finding rather than an opinion.
            ...(region.exemplarColorTarget
              ? colorPresenceProfile(a, b, region.exemplarColorTarget, region.colorOpts)
              : {}),
            ...(strokeWidthProfile(a, b) ?? {}),
            // Soft-shading banding: where the gradient got cut and what colour
            // each side was painted (metrics.mjs `shadingBandQuality`).
            ...(shadingBandQuality(a, b) ?? {}),
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

  for (const fixture of fixtures) {
    if (!fixture.supported) {
      results.push({
        id: fixture.id,
        label: labelOf(fixture),
        local: fixture.local,
        file: fixture.file,
        kind: fixture.kind,
        status: 'skipped/unsupported',
        metrics: null,
        failures: [],
      });
      continue;
    }

    const baseDir = fixture.baseDir ?? fixturesDir;
    const filePath = join(baseDir, fixture.file);
    // A local fixture that has gone missing is a local problem: say so and move
    // on. It must never turn a tracked run red.
    if (fixture.local && !(await fs.stat(filePath).catch(() => null))) {
      console.log(`  ${labelOf(fixture)}: ${fixture.file} missing — skipped`);
      results.push({
        id: fixture.id,
        label: labelOf(fixture),
        local: true,
        file: fixture.file,
        kind: fixture.kind,
        status: 'skipped/missing',
        metrics: null,
        failures: [],
      });
      continue;
    }
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
        : flattenOnWhite(await decodeImageFile(join(baseDir, referenceFile)));
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
        label: labelOf(fixture),
        local: fixture.local,
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
        label: labelOf(fixture),
        local: fixture.local,
        file: fixture.file,
        kind: fixture.kind,
        status: 'engine-error',
        error: 'vectorize() did not return { svg: string }',
        metrics: null,
        failures: [],
      });
      continue;
    }

    await fs.writeFile(join(outDirOf(fixture, 'vector'), `${fixture.id}.svg`), result.svg);

    let rendered;
    try {
      rendered = await rasterizeSvg(result.svg, source.width, source.height);
    } catch (err) {
      failed++;
      results.push({
        id: fixture.id,
        label: labelOf(fixture),
        local: fixture.local,
        file: fixture.file,
        kind: fixture.kind,
        status: 'unrasterizable-svg',
        error: err.message,
        metrics: null,
        failures: [],
      });
      continue;
    }
    await fs.writeFile(join(outDirOf(fixture, 'raster'), `${fixture.id}.png`), rendered.png);
    const traced = flattenOnWhite(rendered.image);
    await writeDiff(reference, traced, join(outDirOf(fixture, 'diff'), `${fixture.id}.png`));

    const structure = svgStructure(result.svg);
    const arcSmoothness = boundarySmoothness(result.svg, fixture.arcs);
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
      // Small sharp features, and the cracks between layers. Two defects a
      // person names on sight and no averaging metric here can see: welding two
      // outlines 4px apart into one chain, and a white hairline drawn along a
      // boundary the source draws solid (metrics.mjs `sharpFeatureSurvival`,
      // `seamSlivers`).
      ...sharpFeatureSurvival(reference, traced),
      ...seamSlivers(reference, traced),
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
      layerWobble: structure.layerWobble,
      // The drawing must stay on its own canvas (metrics.mjs `canvasOverflow`).
      canvasOverflow: structure.canvasOverflow,
      // ...and the reversal `layerWobble` is blind to by construction, which is
      // the one that reads as a staircase at 4x zoom. Unlike `arcResidualRms`
      // below, this needs no equation and so works on ANY artwork.
      staircaseLocal: structure.staircaseLocal,
      staircaseSustained: structure.staircaseSustained,
      staircaseWorstSite: structure.staircaseWorstSite,
      // Only for a fixture that declares `arcs` — a shape we know the equation
      // of, so "did the pixel grid survive into the geometry" has an answer.
      arcResidualRms: arcSmoothness?.rms ?? null,
      arcResidualMax: arcSmoothness?.max ?? null,
      arcs: arcSmoothness?.arcs ?? null,
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
          // ...and the question all three of those read backwards: is there
          // MORE ink here than the source has? A stroke filled in to a blob
          // scores 1.0 on every recall number in this file (metrics.mjs
          // `inkCoverageProfile`).
          ...inkCoverageProfile(refRegion, outRegion),
          meanColorError: meanColorError(refRegion, outRegion),
          ssim: ssim(refRegion, outRegion),
          // "Is there a colour in here that is not in the picture?" — see the
          // GATES note on maxRegionForeignColorRatio.
          foreignColorRatio: foreignColorRatio(refRegion, outRegion),
          // "Is the colour that makes this feature a feature still in here?" —
          // see metrics.mjs `colorPresenceProfile`. Only for regions that name
          // one, because the question is meaningless without a target.
          ...(region.colorTarget
            ? colorPresenceProfile(refRegion, outRegion, region.colorTarget, region.colorOpts)
            : {}),
          // "Are the small sharp features still there, still separate, and still
          // sharp?" and "did a crack open between two layers?". The corner
          // angles are read off the fitted geometry inside this box, so a crop
          // is the natural unit for them too.
          ...sharpFeatureSurvival(refRegion, outRegion),
          ...seamSlivers(refRegion, outRegion),
          ...featureCornerAngles(result.svg, region),
          // "Is it still a STROKE?" — see metrics.mjs `strokeWidthProfile`.
          ...(strokeWidthProfile(refRegion, outRegion) ?? {}),
          // "Where did the soft gradient get cut, and is each side the colour of
          // what it covers?" — see metrics.mjs `shadingBandQuality`. The one
          // question this harness could not ask, and the one that decides
          // shaded artwork.
          ...(shadingBandQuality(refRegion, outRegion) ?? {}),
        });
        const crop = join(
          outDirOf(fixture, 'region'),
          i === 0 ? `${fixture.id}.png` : `${fixture.id}-${region.name}.png`,
        );
        await sharp(
          Buffer.from(outRegion.data.buffer, outRegion.data.byteOffset, outRegion.data.byteLength),
          { raw: { width: outRegion.width, height: outRegion.height, channels: 4 } },
        )
          .png()
          .toFile(crop);
      }
      /**
       * Gates read the WORST region: a fixture that names two crops is asking
       * that BOTH survive, so adding one can only ever tighten the fixture.
       *
       * ...unless the crop declares `aggregate: false`, which means "judge me on
       * my own thresholds and do not let me redefine the shared ones". That is
       * not an escape hatch, it is the same argument that gave regions their own
       * thresholds in the first place: an aggregate is only meaningful across
       * crops that are asking the same question. The mascot's nose box is 64x38
       * of almost nothing but outline, so a fifth of it is ink and its mean
       * colour error is 15 in the REFERENCE PRODUCT's trace; folded into the
       * whole-face aggregate it would not tighten `maxRegionMeanColorError`, it
       * would force that bar up from 8 to 18 and quietly loosen the face and the
       * chest with it. A crop that opts out must carry its own bars — the ones
       * below are checked against it alone, and nothing goes unmeasured.
       */
      const aggregated = metrics.regions.filter((_, i) => regions[i]?.aggregate !== false);
      const worst = (key, dir) => {
        const vals = aggregated.map((r) => r[key]).filter((v) => v != null);
        if (!vals.length) return null;
        return dir === 'min' ? Math.min(...vals) : Math.max(...vals);
      };
      metrics.salientRegion = metrics.regions[0].box;
      metrics.regionInkRecall = worst('inkRecall', 'min');
      metrics.regionStrictInkRecall = worst('strictInkRecall', 'min');
      metrics.regionInkComponentRatio = worst('inkComponentRatio', 'max');
      metrics.regionMeanColorError = worst('meanColorError', 'max');
      metrics.regionSsim = worst('ssim', 'min');
      metrics.regionForeignColorRatio = worst('foreignColorRatio', 'max');
      metrics.regionStrokeWidthCv = worst('strokeWidthCv', 'max');
      // Worst crop's band placement and worst crop's most visible seam.
      metrics.regionBandFit = worst('bandFit', 'max');
      metrics.regionBandStep = worst('bandStep', 'max');
      // The half of the seam we invented: the step we paint minus the step the
      // source has between the same two regions. A real colour edge scores ~0
      // however large it is; a seam drawn across a soft ramp scores its whole
      // contrast.
      metrics.regionBandStepExcess = worst('bandStepExcess', 'max');
      metrics.regionStrokeWidthRatio = worst('strokeWidthRatio', 'max');
      metrics.regionFeatureComponentRatio = worst('featureComponentRatio', 'min');
      metrics.regionSliverRatio = worst('sliverRatio', 'max');
      // Worst crop's ink SPEND, not its ink recall: the crop that fattened its
      // outlines the most relative to the source's own ink.
      metrics.regionInkCoverageRatio = worst('inkCoverageRatio', 'max');
      metrics.regionMinCornerAngle = worst('minCornerAngle', 'min');
    }

    /**
     * Whole-frame corner sharpness, only for fixtures that ask for it.
     *
     * `featureCornerAngles` walks every small contour in the document, which is
     * cheap on a 384px test pattern and pointless on a photo, so it is computed
     * where it is gated rather than everywhere.
     */
    if (fixture.thresholds?.minSpikeCornerAngle != null) {
      Object.assign(
        metrics,
        featureCornerAngles(result.svg, {
          x: 0,
          y: 0,
          width: source.width,
          height: source.height,
        }),
      );
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
      exemplar = await measureExemplar(fixture.exemplar, source, regions, baseDir);
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
        metrics.exemplarLayerWobble = exemplar.layerWobble;
        if (metrics.layerWobble != null && exemplar.layerWobble) {
          metrics.layerWobbleRatio = metrics.layerWobble / exemplar.layerWobble;
        }
        if (metrics.regions && exemplar.regions?.length) {
          for (const [i, r] of metrics.regions.entries()) {
            const e = exemplar.regions[i];
            if (!e) continue;
            r.exemplarInkRecall = e.inkRecall;
            r.exemplarStrictInkRecall = e.strictInkRecall;
            // How much ink the reference product spends on the same crop. The bar
            // for a blob is not "1.0" — its own trace fattens a little too —
            // so the honest reading of ours is beside its number.
            r.exemplarInkCoverageRatio = e.inkCoverageRatio;
            r.exemplarMeanColorError = e.meanColorError;
            r.exemplarForeignColorRatio = e.foreignColorRatio;
            // The named colour, A/B'd. The reference product keeping a hue we fold
            // away is the whole finding; if it folds the colour too, the defect
            // is the artwork's and not ours.
            r.exemplarColorPresence = e.colorPresence;
            r.exemplarColorPresenceTarget = e.colorPresenceTarget;
            if (r.colorPresence != null && e.colorPresence > 0) {
              r.colorPresenceOverExemplar = r.colorPresence / e.colorPresence;
            }
            r.inkRecallRatio = r.inkRecall / Math.max(0.01, e.inkRecall);
            r.strictInkRecallRatio = r.strictInkRecall / Math.max(0.01, e.strictInkRecall);
            r.exemplarBandFit = e.bandFit;
            r.exemplarBandStep = e.bandStep;
            r.exemplarBandStepExcess = e.bandStepExcess;
            if (r.bandFit != null && e.bandFit != null) {
              r.bandFitRatio = r.bandFit / Math.max(0.01, e.bandFit);
            }
            if (r.bandStep != null && e.bandStep) r.bandStepRatio = r.bandStep / e.bandStep;
            r.exemplarStrokeWidth = e.strokeWidth;
            r.exemplarStrokeWidthCv = e.strokeWidthCv;
            if (r.strokeWidthCv != null && e.strokeWidthCv) {
              r.strokeWidthCvRatio = r.strokeWidthCv / e.strokeWidthCv;
            }
            if (r.strokeWidthRatio != null && e.strokeWidthRatio) {
              r.strokeWidthOverExemplar = r.strokeWidthRatio / e.strokeWidthRatio;
            }
          }
          // The A/B on stroke geometry, in the region where we are worst: how
          // much less even our line is than the reference product's, and how much
          // fatter. Both are ratios because the absolute numbers belong to the
          // artwork — a drawn line genuinely varies — while "less even than the
          // reference product's trace of the same line" belongs to us.
          //
          // Same aggregation rule as the absolute region gates above: a crop
          // that declared `aggregate: false` carries its own bars and does not
          // redefine the shared ones.
          const inAggregate = metrics.regions.filter((_, i) => regions[i]?.aggregate !== false);
          const cvRatios = inAggregate
            .filter((r) => r.strokeWidthCvRatio != null)
            .map((r) => r.strokeWidthCvRatio);
          metrics.strokeWidthCvRatio = cvRatios.length ? Math.max(...cvRatios) : null;
          const fitRatios = inAggregate
            .filter((r) => r.bandFitRatio != null)
            .map((r) => r.bandFitRatio);
          metrics.shadingBandFitRatio = fitRatios.length ? Math.max(...fitRatios) : null;
          const stepRatios = inAggregate
            .filter((r) => r.bandStepRatio != null)
            .map((r) => r.bandStepRatio);
          metrics.shadingBandStepRatio = stepRatios.length ? Math.max(...stepRatios) : null;
          const fatRatios = inAggregate
            .filter((r) => r.strokeWidthOverExemplar != null)
            .map((r) => r.strokeWidthOverExemplar);
          metrics.strokeWidthOverExemplar = fatRatios.length ? Math.max(...fatRatios) : null;
          // < 1 means the reference product renders the salient region better than
          // we do — the blind A/B, as one number, in the region where we are
          // worst relative to it.
          metrics.exemplarRegionInkRecall = exemplar.regions[0].inkRecall;
          metrics.regionInkRecallRatio = Math.min(
            ...inAggregate.filter((r) => r.inkRecallRatio != null).map((r) => r.inkRecallRatio),
          );
          const strict = inAggregate
            .filter((r) => r.strictInkRecallRatio != null)
            .map((r) => r.strictInkRecallRatio);
          metrics.regionStrictInkRecallRatio = strict.length ? Math.min(...strict) : null;
        }
      }
    }

    const failures = checkThresholds(metrics, fixture.thresholds);
    // ...plus whatever a single named crop pins for itself (REGION_GATES).
    for (const [i, region] of (metrics.regions ?? []).entries()) {
      const own = regions[i]?.thresholds;
      if (!own) continue;
      for (const f of checkThresholds(region, own, REGION_GATES)) {
        failures.push(`region "${region.name}" ${f}`);
      }
    }

    /**
     * ASPIRATIONS — the same gates, evaluated and printed, but never red.
     *
     * A bar the engine does not meet today has two honest homes: a ratchet at
     * today's number with the target in a comment, or a `TODO` nobody runs. Both
     * lose the same thing — the distance to the target stops being *measured*,
     * so it can drift either way unnoticed and the day it is finally met, nobody
     * finds out.
     *
     * `aspirations` is the third option: declare the number to aim at, in the
     * same syntax as `thresholds`, and have every run print how far off it is.
     * It cannot fail a build, so it can be set at the RIGHT value rather than at
     * a survivable one. The mascot's eye colour is why this exists — the real
     * product keeps a hue-distinct feature's palette slot and we fold it away,
     * which is a known engine gap with an open issue, not a regression to gate.
     */
    const aspirations = checkThresholds(metrics, fixture.aspirations);
    for (const [i, region] of (metrics.regions ?? []).entries()) {
      const own = regions[i]?.aspirations;
      if (!own) continue;
      for (const a of checkThresholds(region, own, REGION_GATES)) {
        aspirations.push(`region "${region.name}" ${a}`);
      }
    }

    // A declared bar that cannot fire is a lie in the manifest, not a pass.
    const dead = deadGates(metrics, fixture.thresholds);
    for (const [i, region] of (metrics.regions ?? []).entries()) {
      const own = regions[i]?.thresholds;
      if (!own) continue;
      for (const d of deadGates(region, own, REGION_GATES)) {
        dead.push(`region "${region.name}" ${d}`);
      }
    }
    for (const d of dead) failures.push(`DEAD GATE: ${d}`);

    if (failures.length) failed++;
    results.push({
      id: fixture.id,
      label: labelOf(fixture),
      local: fixture.local,
      file: fixture.file,
      kind: fixture.kind,
      status: failures.length ? 'FAIL' : 'pass',
      settings,
      metrics,
      exemplar,
      thresholds: fixture.thresholds ?? null,
      failures,
      // Reported, never gated — see the note where these are computed.
      aspirations,
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
      skipped: results.filter((r) => r.status.startsWith('skipped/')).length,
      // Fixtures with at least one declared-but-unmet aspiration. Never part of
      // the exit code.
      aspirationsUnmet: results.filter((r) => r.aspirations?.length).length,
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
        `  ${r.label ?? r.id}: vs exemplar ${e.file} — bytes ${fmt(r.metrics.exemplarBytesRatio)}x, ` +
          `subpaths ${fmt(r.metrics.exemplarSubPathRatio)}x (${r.metrics.subPathCount} vs ${e.subPathCount}), ` +
          `paths ${fmt(r.metrics.exemplarPathRatio)}x (${r.metrics.pathCount} vs ${e.pathCount}), ` +
          `curve ratio ${fmt(r.metrics.curveCommandRatio, 3)} vs ${fmt(e.curveCommandRatio, 3)}, ` +
          `MAE ${fmt(r.metrics.meanColorError)} vs ${fmt(e.meanColorError)}, ` +
          `layer compactness ${fmt(r.metrics.layerCompactness)} vs ${fmt(e.layerCompactness)} ` +
          `(${fmt(r.metrics.layerCompactnessRatio)}x), ` +
          `boundary wobble ${fmt(r.metrics.layerWobble, 1)} vs ${fmt(e.layerWobble, 1)} ` +
          `(${fmt(r.metrics.layerWobbleRatio)}x) ` +
          `(exemplar registered by ${e.registration}` +
          (e.registrationError != null ? ` at MAE ${fmt(e.registrationError)}` : '') +
          (e.registrationRejected?.length
            ? `, rejected ${e.registrationRejected.map((r) => `${r.registration} at ${fmt(r.meanColorError)}`).join(' / ')}`
            : '') +
          `, content ${e.contentBox?.width}x${e.contentBox?.height})`,
      );
    }
    for (const region of r.metrics?.regions ?? []) {
      const box = region.box;
      console.log(
        `  ${r.label ?? r.id}: region "${region.name}" ${box.width}x${box.height}@${box.x},${box.y} — ` +
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
          `, SSIM ${fmt(region.ssim, 4)}, ink components ${fmt(region.inkComponentRatio, 2)}x source` +
          `, ink spend ${fmt(region.inkCoverageRatio, 2)}x source` +
          (region.exemplarInkCoverageRatio != null
            ? ` (reference product ${fmt(region.exemplarInkCoverageRatio, 2)}x)`
            : '') +
          `, foreign colour ${fmt((region.foreignColorRatio ?? 0) * 100, 2)}%` +
          (region.exemplarForeignColorRatio != null
            ? ` vs ${fmt(region.exemplarForeignColorRatio * 100, 2)}%`
            : '') +
          // The named colour, if this crop names one: how much of it the source
          // has, how much we kept, and how much the reference product kept.
          (region.colorPresenceTarget != null
            ? `, ${region.colorPresenceTarget} ${fmt((region.colorPresence ?? 0) * 100, 2)}% of crop ` +
              `vs source ${fmt((region.sourceColorPresence ?? 0) * 100, 2)}% ` +
              `(kept ${fmt((region.colorPresenceRatio ?? 0) * 100, 1)}%)` +
              (region.exemplarColorPresence != null
                ? `, reference product ${region.exemplarColorPresenceTarget ?? region.colorPresenceTarget} ` +
                  `${fmt(region.exemplarColorPresence * 100, 2)}% of crop ` +
                  `(ours ${fmt(region.colorPresenceOverExemplar, 3)}x theirs)`
                : '')
            : '') +
          (region.bandFit != null
            ? `, bands ${region.bandCount} fit ${fmt(region.bandFit)}` +
              (region.exemplarBandFit != null
                ? ` vs ${fmt(region.exemplarBandFit)} (${fmt(region.bandFitRatio)}x)`
                : '') +
              ` step ${fmt(region.bandStep, 1)} (excess ${fmt(region.bandStepExcess, 1)}` +
              (region.exemplarBandStepExcess != null
                ? ` vs ${fmt(region.exemplarBandStepExcess, 1)}`
                : '') +
              `)` +
              ` spread ${fmt(region.bandSpread)}`
            : ''),
      );
    }
    if (r.metrics?.paletteShortfall > 0) {
      console.log(
        `  ${r.label ?? r.id}: palette — ${r.metrics.paletteSize} delivered of ${r.settings.colorCount} ` +
          `requested (${r.metrics.sourceColors} found in the image); our folds merged ` +
          `${r.metrics.paletteShortfall} away`,
      );
    }
    if (r.metrics?.dxfBytes != null) {
      console.log(
        `  ${r.label ?? r.id}: exports — DXF ${fmt(r.metrics.dxfBytes / 1024, 1)} KB ` +
          `(${r.metrics.dxfSplineCount} SPLINE, ${r.metrics.dxfVertexCount} VERTEX) vs ` +
          `EPS ${fmt(r.metrics.epsBytes / 1024, 1)} KB (${r.metrics.epsCurveCount} curveto) — ` +
          `${fmt(r.metrics.dxfEpsBytesRatio)}x`,
      );
    }
    if (r.metrics?.sourceTransparentRatio > 0) {
      console.log(
        `  ${r.label ?? r.id}: source is ${(r.metrics.sourceTransparentRatio * 100).toFixed(1)}% transparent — ` +
          `backdrop ${r.metrics.backdropFill ?? 'none'}, ` +
          `colour painted over the transparent area ${fmt(r.metrics.transparentAreaColorError)}/255`,
      );
    }
    if (r.exemplar?.error) console.log(`  ${r.label ?? r.id}: exemplar unreadable — ${r.exemplar.error}`);
    if (r.failures?.length) console.log(`  ${r.label ?? r.id}: ${r.failures.join('; ')}`);
    // Missed aspirations are printed every run and fail nothing: the point is
    // that the distance to a known-unmet target stays measured.
    if (r.aspirations?.length) {
      console.log(`  ${r.label ?? r.id}: aspiration (not gated) — ${r.aspirations.join('; ')}`);
    }
    if (r.error) console.log(`  ${r.label ?? r.id}: ${r.error.split('\n')[0]}`);
  }
  console.log(
    `\n${report.summary.passed} pass · ${report.summary.failed} fail · ` +
      `${report.summary.notImplemented} not-implemented · ${report.summary.skipped} skipped` +
      (report.summary.aspirationsUnmet
        ? ` · ${report.summary.aspirationsUnmet} with an unmet aspiration (not gated)`
        : ''),
  );
  console.log(`wrote ${metricsPath}`);

  if (notImplemented > 0 && failed === 0 && report.summary.passed === 0) process.exit(2);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
