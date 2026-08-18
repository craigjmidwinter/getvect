/**
 * SHARP CORNERS MUST STAY SHARP.
 *
 * This was a sentence in a plan file — "the failure mode of every de-staircasing
 * change is rounding the angular; Frankie's ear tip is where to look" — and it
 * got cited across several laps as though it were a check that runs. It was not.
 * Nothing in this repo measured it, so "the ear-tip canary still passes" was a
 * claim nobody could have verified. Folklore that guards a real failure mode is
 * worse than no guard, because it is believed.
 *
 * So it is a test now, and writing it down turned up two things the phrase had
 * wrong:
 *
 * 1. THE LEFT EAR IS NOT A CORNER. Its outline reads 175deg over a 4px window and
 *    135deg over 40px — a smooth curve whose measured "angle" is just a function
 *    of how far you look. Nothing there can be protected because nothing there
 *    is sharp. The feature worth guarding is the NOTCH on the right ear, where
 *    the ear meets the head: 83deg, and the same 83deg at every scale from 4px to
 *    40px. Scale-stability is what distinguishes a real corner from a curve, and
 *    it is why this test samples several spans instead of picking one.
 *
 * 2. "SHARPEST CORNER NEAR THE EAR" IS THE WRONG QUERY. Asked that way against
 *    the pre-fix asset it returned 19deg — the pointed END of a one-pixel sliver
 *    riding the silhouette, a defect wearing the costume of the feature. The
 *    query has to name the ink outline, which is what draws the ear.
 *
 * The bar is a ceiling on the angle, not a ratchet to today's number: 83deg may
 * drift, and the test fails when the notch has visibly rounded off.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasIngest, decodeImageFile } from '../../instruments/lib/decode.mjs';
import { fillLayerChunks, pathDataAttributes, subPathPolylines } from '../../instruments/lib/metrics.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { vectorize } = require(join(root, 'dist/engine/index.js'));

/** The demo trace — the same settings the published asset is generated at. */
const SETTINGS = { colorCount: 8, antiAliasing: 'smart', minArea: 5 };
const SOURCE = join(root, 'fixtures/reference/frankie-sticker.png');
const INK = 'rgb(4, 2, 1)';
const STEP = 0.5;

/** Where the ear meets the head on the right ear — the one real corner up there. */
const NOTCH = { x0: 560, x1: 660, y0: 120, y1: 220 };

/**
 * A corner has no single angle; it depends how far either side you look. A real
 * corner holds its angle as the window grows, a rounded one opens up.
 */
const SPANS_PX = [4, 8, 16, 24, 40];

/** Ceiling, not a ratchet. The notch measures 83deg; 100 fails only on real rounding. */
const MAX_NOTCH_ANGLE = 100;

function angleAt(poly, i, span) {
  const n = poly.length - 1;
  const at = (k) => poly[((k % n) + n) % n];
  const a = at(i - span), b = at(i), c = at(i + span);
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
  if (l1 < 1e-6 || l2 < 1e-6) return 180;
  const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Sharpest ink-outline angle inside `box`, at one window size. */
function sharpestInk(svg, box, spanPx) {
  const span = Math.max(2, Math.round(spanPx / STEP));
  let best = null;
  for (const chunk of fillLayerChunks(svg)) {
    if (chunk.fill !== INK) continue;
    for (const d of pathDataAttributes(chunk.body)) {
      for (const poly of subPathPolylines(d, { step: STEP })) {
        const n = poly.length - 1;
        if (n < span * 2 + 4) continue;
        for (let i = 0; i < n; i++) {
          const [x, y] = poly[i];
          if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
          const ang = angleAt(poly, i, span);
          if (!best || ang < best.angle) best = { angle: ang, x, y };
        }
      }
    }
  }
  return best;
}

const traced = await (async () => {
  const { svg } = await vectorize(canvasIngest(await decodeImageFile(SOURCE)), SETTINGS);
  return svg;
})();

test('the ear notch is still a corner, at every scale a viewer might see it', () => {
  const seen = [];
  for (const spanPx of SPANS_PX) {
    const hit = sharpestInk(traced, NOTCH, spanPx);
    assert.ok(hit, `no ink outline found in the ear-notch window at span ${spanPx}px`);
    seen.push(`${spanPx}px:${hit.angle.toFixed(0)}deg@(${hit.x.toFixed(0)},${hit.y.toFixed(0)})`);
    assert.ok(
      hit.angle <= MAX_NOTCH_ANGLE,
      `the ear notch has rounded off: ${hit.angle.toFixed(1)}deg over a ${spanPx}px window ` +
        `at (${hit.x.toFixed(0)},${hit.y.toFixed(0)}), ceiling ${MAX_NOTCH_ANGLE}deg. ` +
        `Profile: ${seen.join('  ')}`,
    );
  }
});

test('the notch holds its angle as the window grows — a corner, not a curve', () => {
  const angles = SPANS_PX.map((s) => sharpestInk(traced, NOTCH, s)?.angle ?? 180);
  const spread = Math.max(...angles) - Math.min(...angles);
  // A curve's measured angle marches with the window: the left ear moves 40deg
  // across this same range. A corner barely moves.
  assert.ok(
    spread <= 20,
    `the ear notch stopped behaving like a corner: its angle moved ${spread.toFixed(1)}deg ` +
      `across ${SPANS_PX[0]}-${SPANS_PX[SPANS_PX.length - 1]}px windows ` +
      `(${angles.map((a) => a.toFixed(0)).join(', ')}deg). A corner holds its angle; a curve does not.`,
  );
});

test('the sharpest thing near the ear is the ear, not a sliver riding the silhouette', () => {
  // Asked without naming the ink layer, this window used to return ~19deg: the
  // pointed end of a 1px ribbon of alpha-edge contamination. If that comes back,
  // the corner metric above is measuring a defect instead of the artwork.
  const EAR = { x0: 440, x1: 660, y0: 80, y1: 260 };
  let sharpestAnyLayer = null;
  for (const chunk of fillLayerChunks(traced)) {
    for (const d of pathDataAttributes(chunk.body)) {
      for (const poly of subPathPolylines(d, { step: STEP })) {
        const span = Math.max(2, Math.round(8 / STEP));
        const n = poly.length - 1;
        if (n < span * 2 + 4) continue;
        for (let i = 0; i < n; i++) {
          const [x, y] = poly[i];
          if (x < EAR.x0 || x > EAR.x1 || y < EAR.y0 || y > EAR.y1) continue;
          const ang = angleAt(poly, i, span);
          if (!sharpestAnyLayer || ang < sharpestAnyLayer.angle) {
            sharpestAnyLayer = { angle: ang, x, y, fill: chunk.fill };
          }
        }
      }
    }
  }
  assert.ok(sharpestAnyLayer, 'no geometry at all in the ear window');
  assert.ok(
    sharpestAnyLayer.angle >= 40,
    `a ${sharpestAnyLayer.angle.toFixed(1)}deg spike appeared at ` +
      `(${sharpestAnyLayer.x.toFixed(0)},${sharpestAnyLayer.y.toFixed(0)}) on ${sharpestAnyLayer.fill}. ` +
      `Nothing in this artwork is that pointed — this is the signature of a thin ribbon ` +
      `riding the silhouette (see snapAlphaFringe in src/engine/color.ts).`,
  );
});
