/**
 * Colour analysis: histogram → palette (median cut + Lloyd refinement) →
 * indexed image → area-thresholded despeckle.
 *
 * Everything here is deterministic: no `Math.random`, no time, no iteration
 * over unordered structures without an explicit sort. Same input ⇒ same output.
 */

import type { RasterImage, RgbColor } from './types';

/** Packed 0xRRGGBB. */
export type PackedRgb = number;

/**
 * Alpha at or above which a source pixel counts as part of the drawing.
 *
 * Half coverage is the natural split: an antialiased sprite edge ramps from 0
 * to 255 across a pixel or two, and the silhouette a human sees is the 50 %
 * contour.
 */
export const OPAQUE_ALPHA = 128;

/**
 * Index reserved, in every index image the engine builds, for pixels the source
 * marks transparent.
 *
 * It is deliberately *not* a palette entry: transparent is the absence of ink,
 * so it must never win a colour slot, never become a layer, and never become
 * the full-bleed backdrop rect. 255 is safe because the palette is capped at 64.
 */
export const TRANSPARENT_INDEX = 255;

/**
 * 1 where the source pixel is opaque enough to draw, 0 where it is see-through.
 * `null` when the image has no transparency at all, which lets every caller
 * skip the alpha-aware code paths on ordinary opaque artwork.
 */
export function opacityMask(image: RasterImage): Uint8Array | null {
  const n = image.width * image.height;
  if (n <= 0 || image.data.length < n * 4) return null;
  const mask = new Uint8Array(n);
  let transparent = 0;
  for (let p = 0, i = 3; p < n; p++, i += 4) {
    if (image.data[i] >= OPAQUE_ALPHA) mask[p] = 1;
    else transparent++;
  }
  return transparent === 0 ? null : mask;
}

export const packRgb = (r: number, g: number, b: number): PackedRgb =>
  ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

export const unpackRgb = (v: PackedRgb): RgbColor => ({
  r: (v >> 16) & 255,
  g: (v >> 8) & 255,
  b: v & 255,
});

export function hexOf(c: RgbColor): string {
  const h = (v: number) => clamp255(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * `rgb(r, g, b)` — the notation REFERENCE D1 documents and the exemplars in
 * fixtures/reference use, so a diff against reference product output is about
 * geometry rather than syntax.
 */
export function rgbOf(c: RgbColor): string {
  return `rgb(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)})`;
}

/** Rec. 601 luma, 0..255. */
export const lumaOf = (c: RgbColor): number => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/** Hue angle in degrees, 0..360; 0 for greys. */
export function hueOf(c: RgbColor): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === c.r) h = ((c.g - c.b) / d) % 6;
  else if (max === c.g) h = (c.b - c.r) / d + 2;
  else h = (c.r - c.g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

export function parseHex(hex: string): RgbColor | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return unpackRgb(v);
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Distinct colours of an image with their pixel counts, sorted by packed value. */
export interface Histogram {
  colors: Uint32Array;
  counts: Uint32Array;
  distinct: number;
  total: number;
}

/**
 * `mask`, when given, is the opacity mask from `opacityMask()`: only pixels the
 * source draws are counted, so a transparent background cannot win a palette
 * slot (and `total` is the drawn area, which is what every coverage fraction
 * downstream should be a fraction of).
 */
export function buildHistogram(image: RasterImage, mask?: Uint8Array | null): Histogram {
  const { data } = image;
  const pixels = image.width * image.height;
  const map = new Map<number, number>();
  let counted = 0;
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    if (mask && !mask[p]) continue;
    counted++;
    const key = packRgb(data[i], data[i + 1], data[i + 2]);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  const distinct = map.size;
  const colors = new Uint32Array(distinct);
  const counts = new Uint32Array(distinct);
  let n = 0;
  for (const key of map.keys()) colors[n++] = key;
  // Sorting makes every downstream decision independent of insertion order.
  colors.sort();
  for (let k = 0; k < distinct; k++) counts[k] = map.get(colors[k]) as number;
  return { colors, counts, distinct, total: counted };
}

/** L1 (rectilinear) RGB distance — the metric imagetracerjs uses internally. */
const dist = (
  r: number,
  g: number,
  b: number,
  c: { r: number; g: number; b: number },
): number => Math.abs(c.r - r) + Math.abs(c.g - g) + Math.abs(c.b - b);

/**
 * How heavily a *hue* disagreement counts when a pixel is handed to a palette
 * slot, in units of the L1 RGB distance it is added to.
 *
 * This is the fix for the class of defect that puts teal in a cream face. Plain
 * RGB distance is blind to hue: the warm mid-brown skirt of the gold-standard
 * artwork's outline, rgb(79,66,58), sits 115 (L1) from the dark TEAL slot
 * rgb(38,90,108) and 160 from the near-black outline slot rgb(15,15,13), so
 * nearest-colour matching paints the inside of both fangs with a colour that
 * belongs to the character's belly on the other side of the picture. Nothing
 * downstream can undo that honestly — the fringe collapse can only merge a
 * *thin* band, and those blobs are 24-40px lumps four pixels thick.
 *
 * Adding the opponent-chroma difference (red-green and blue-yellow, the two
 * axes hue lives on) reorders that comparison and the skirt resolves onto the
 * outline, where a person would put it. Two alternatives were measured and
 * rejected on the fixtures rather than on taste: the redmean weighting still
 * prefers the teal, and full CIE Lab ΔE prefers it correctly but wrecks
 * everything dark (L* is so stretched near black that ink pixels leave the ink
 * slot — whole-frame ink recall 0.989 -> 0.677 on the gold standard).
 *
 * Half a unit is where the leak closes, measured on the gold standard: at 0.25
 * the muzzle keeps 0.07 % of its area teal and the paw pad 0.47 %, and at 1.0
 * the extra hue pressure starts splitting the near-neutral creams into ragged
 * layers (sub-paths 68 -> 127 at 16 colours + Enhance).
 */
const CHROMA_WEIGHT = 0.5;

/**
 * Colour distance for *assignment* decisions: which palette slot a pixel
 * belongs to.
 *
 * Deliberately NOT the same function as `dist`. `dist` answers "how far apart
 * are these two colours" for contrast thresholds tuned in L1 RGB units (the
 * despeckle noise filter, the halo fold, the Enhance floor), and moving those
 * goalposts would silently retune every one of them. This one answers "which of
 * these colours is the same *thing*", where a hue flip is a wrong answer
 * however short the RGB vector is.
 *
 * Ink is exempt, for the same reason `deAntialias` biases a ramp toward it
 * (INK_RAMP_BIAS, src/engine/preprocess.ts): the skirt of a drawn stroke
 * belongs to the stroke. A near-neutral ink slot has no hue for a warm pixel to
 * flip to, so charging it the chroma term only ever thins line art — measured
 * on the gold standard, exempting it puts the paw crop's strict ink recall back
 * to 0.99x of the reference product's from 0.97x.
 */
const assignDist = (
  r: number,
  g: number,
  b: number,
  c: { r: number; g: number; b: number },
): number => {
  const dr = c.r - r;
  const dg = c.g - g;
  const db = c.b - b;
  const l1 = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
  if (lumaOf(c) < INK_LUMA) return l1;
  return l1 + CHROMA_WEIGHT * (Math.abs(dr - dg) + Math.abs(db - dg));
};

/**
 * Luma below which a palette entry is the drawing's ink rather than one of its
 * colours — the same bar `reserveDarkest` spends a slot on and the engine's
 * cleanup passes protect (src/engine/index.ts).
 */
const INK_LUMA = 60;

/**
 * L1 separation the delivered palette aims for.
 *
 * 8 % of the 765-unit L1 range — deliberately the same window the output-group
 * fold (`mergeSimilarColors`) uses, because the two are the same statement made
 * twice: colours closer than this are the halo/gradient debris a soft edge
 * leaves behind, and shipping two of them costs a layer, a legend entry and a
 * print run while showing the user one colour. If the quantizer stops producing
 * them, the fold has nothing to take away, and the colour budget the user asked
 * for is the colour budget they get.
 *
 * Declared up here with the other distance constants because the chromatic
 * reservation (`reserveChromatic`) is built on it too, and a `const` used at
 * module load time cannot be declared further down the file.
 */
const MIN_SEPARATION = 61;

const l1 = (a: RgbColor, b: RgbColor): number =>
  Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

interface Box {
  lo: number;
  hi: number; // exclusive
  count: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function boxOf(order: Int32Array, colors: Uint32Array, counts: Uint32Array, lo: number, hi: number): Box {
  let count = 0;
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (let i = lo; i < hi; i++) {
    const c = colors[order[i]];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
    count += counts[order[i]];
  }
  return { lo, hi, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

const splittable = (b: Box) =>
  b.hi - b.lo > 1 && (b.rMax > b.rMin || b.gMax > b.gMin || b.bMax > b.bMin);

/**
 * Median cut over the exact colour histogram. Boxes holding a single distinct
 * colour are never split, so an image with fewer distinct colours than
 * `colorCount` yields those colours *exactly* — which is what makes the flat
 * fixtures reproduce pixel-perfectly.
 */
function medianCut(hist: Histogram, colorCount: number): Int32Array[] {
  const { colors, counts, distinct } = hist;
  const order = new Int32Array(distinct);
  for (let i = 0; i < distinct; i++) order[i] = i;

  let boxes: Box[] = [boxOf(order, colors, counts, 0, distinct)];

  while (boxes.length < colorCount) {
    // Split the heaviest splittable box; ties broken by position for determinism.
    let target = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!splittable(b)) continue;
      const volume = (b.rMax - b.rMin + 1) * (b.gMax - b.gMin + 1) * (b.bMax - b.bMin + 1);
      const score = b.count * Math.cbrt(volume);
      if (score > best) {
        best = score;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const rSpan = box.rMax - box.rMin;
    const gSpan = box.gMax - box.gMin;
    const bSpan = box.bMax - box.bMin;
    // Weight spans perceptually so we cut where the eye cares most.
    const rw = rSpan * 0.5;
    const gw = gSpan * 0.6;
    const bw = bSpan * 0.4;
    const shift = rw >= gw && rw >= bw ? 16 : gw >= bw ? 8 : 0;

    const slice = Array.from(order.subarray(box.lo, box.hi));
    slice.sort((a, b) => {
      const ka = (colors[a] >> shift) & 255;
      const kb = (colors[b] >> shift) & 255;
      return ka - kb || colors[a] - colors[b];
    });
    for (let i = 0; i < slice.length; i++) order[box.lo + i] = slice[i];

    const half = box.count / 2;
    let acc = 0;
    let cut = box.lo + 1;
    for (let i = box.lo; i < box.hi - 1; i++) {
      acc += counts[order[i]];
      cut = i + 1;
      if (acc >= half) break;
    }
    if (cut <= box.lo) cut = box.lo + 1;
    if (cut >= box.hi) cut = box.hi - 1;

    boxes.splice(
      target,
      1,
      boxOf(order, colors, counts, box.lo, cut),
      boxOf(order, colors, counts, cut, box.hi),
    );
  }

  boxes = boxes.filter((b) => b.hi > b.lo);
  return boxes.map((b) => order.slice(b.lo, b.hi));
}

function centroid(members: Int32Array, hist: Histogram): RgbColor {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < members.length; i++) {
    const idx = members[i];
    const c = hist.colors[idx];
    const w = hist.counts[idx];
    r += ((c >> 16) & 255) * w;
    g += ((c >> 8) & 255) * w;
    b += (c & 255) * w;
    n += w;
  }
  if (n === 0) return { r: 0, g: 0, b: 0 };
  return { r: clamp255(r / n), g: clamp255(g / n), b: clamp255(b / n) };
}

/**
 * Compute a palette of at most `colorCount` colours, ordered by descending
 * pixel coverage. Deterministic; identical input ⇒ identical output.
 */
export function computePaletteSync(
  image: RasterImage,
  colorCount: number,
  mask?: Uint8Array | null,
  /**
   * Whether to spend the budget on *distinguishable* colours (see `separate`).
   *
   * On for the palette the user is shown and the layers are cut from. Off for
   * the internal quantizations the cleanup passes run — those exist to flatten
   * noise, and there a least-squares fit tracks the picture more closely, which
   * is what keeps region boundaries from turning ragged.
   */
  separateSlots = true,
): RgbColor[] {
  const k = Math.max(1, Math.min(64, Math.round(colorCount)));
  const hist = buildHistogram(image, mask);
  if (hist.distinct === 0) return [{ r: 0, g: 0, b: 0 }];

  /*
   * The two ends of the tonal range get their slot before median cut runs, and
   * the rest of the budget is clustered on what is left over. See
   * `reserveExtremes`. Reserved centres come first in the array, the pinned one
   * (the highlight) first of all.
   */
  /*
   * Only when we are actually approximating. With no more distinct colours than
   * slots, median cut reproduces every one of them exactly — that is the branch
   * "enhance cannot introduce a colour absent from the source" depends on — and
   * a reserved centre there is an *invented* colour: on the flat fixture, whose
   * six colours include a navy rgb(27,58,92) and a near-black rgb(43,43,43),
   * reserving put their mean rgb(32,53,75) in the palette and folded two of the
   * artwork's own colours into one.
   */
  const approximating = hist.distinct > k;
  const { bands, pinned: tonal, inkReserved } = approximating
    ? reserveExtremes(hist, supportedHighlight(image, mask, hist.total), k, separateSlots)
    : { bands: [] as ReservedBand[], pinned: 0, inkReserved: false };
  /*
   * ...and the third reservation, which is about hue rather than tone. It has
   * to run after the other two because its question is "can the centres this
   * clustering is about to choose represent that region", and the reserved
   * bands are two of those centres. See `reserveChromatic`.
   *
   * Only for the delivered palette. Inside the cleanup passes `colorCount` is a
   * simplification strength rather than a promise (`SIMPLIFY_COLORS`,
   * src/engine/preprocess.ts) and a reservation there would be an extra centre
   * rather than a spent one — a free pass this guard has no way to price.
   */
  if (approximating && separateSlots) {
    const budget0 = k - bands.length;
    const seen = bands.length ? withoutBands(hist, bands) : hist;
    if (budget0 > 0 && seen.distinct > 0) {
      const families = distinguishable(
        seen,
        refine(seen, medianCut(seen, budget0).map((m) => centroid(m, seen)), 3),
      );
      /*
       * TWO WAYS OF ASKING WHAT THE PICTURE CAN SPARE, and the reservation gets
       * the smaller answer.
       *
       * The first is the floor every reservation in this file has:
       * `CHROMATIC_MIN_PICTURE_SLOTS` families keep their slots whatever else
       * happens. The second is sharper and is what makes this affordable at
       * all — `distinguishable` has just counted how many of the centres the
       * clustering picked are colours a user could tell apart, so the
       * difference is the number of slots it was **about to spend on
       * near-duplicates and lose to the fold anyway**. Taking one of those
       * costs the picture nothing.
       *
       * It is also the guard that stops this from robbing a small budget.
       * Measured on the fox at six colours: the free-slot count there is ZERO
       * (five centres, five families) and the floor alone would have allowed
       * one reservation, which took the eye cyan and left the delivered palette
       * with two pinks and no dark warm brown — the socks and the ear linings
       * with nothing to be painted with, which is exactly the contract
       * `[B4] the default pipeline keeps every colour family the image has`
       * exists to hold.
       */
      const room = Math.min(budget0 - CHROMATIC_MIN_PICTURE_SLOTS, budget0 - families.length);
      if (room > 0) {
        const offered = bands.map((b) => b.centre).concat(families);
        bands.push(...reserveChromatic(image, mask, hist, seen, offered, room));
      }
    }
  }
  const pinned = Math.max(tonal, bands.length);
  const rest = bands.length ? withoutBands(hist, bands) : hist;
  /*
   * A reserved slot comes out of the budget when the budget is a promise — the
   * user asked for k colours and gets k, one of which is the highlight. Inside
   * the cleanup passes `colorCount` is not a promise but a simplification
   * strength (`SIMPLIFY_COLORS`, src/engine/preprocess.ts), and spending one of
   * its sixteen on white costs the picture a colour family for no one's
   * benefit: on the gold standard it put the paw pad's region error from 10.0
   * to 21.7. There the highlight is an extra centre, not a spent one.
   */
  const budget = separateSlots ? k - bands.length : k;

  let palette = bands.map((band) => ({ ...band.centre }));
  if (budget > 0 && rest.distinct > 0) {
    palette = palette.concat(medianCut(rest, budget).map((m) => centroid(m, rest)));
  }

  /*
   * Lloyd refinement only matters when we are actually approximating, and the
   * reserved centres are held out of it.
   *
   * Lloyd is the same least-squares fit the reservation exists to overrule, and
   * left free it undoes both halves. The highlight slot walks straight back
   * down into the cream it was pulled out of — measured on the gold standard,
   * the reserved rgb(253,249,242) came back as rgb(245,240,233) and not one
   * output pixel was white. And withholding the ink band from median cut is not
   * enough on its own to keep the ink slot exclusive, because the band still
   * holds 4.5 % of that image's pixels against one centre: Lloyd answers the
   * error that leaves by dragging a neighbouring cluster down into it, and
   * rgb(27,48,54) — the cold teal that painted a fifth of the lower jaw — came
   * back every time. Pinning both makes the dark band a place only one centre
   * can be.
   */
  if (hist.distinct > palette.length) {
    palette = refine(hist, palette, 6, pinned);
    if (separateSlots) palette = separate(hist, palette, 8, pinned);
  }
  palette = reserveDarkest(hist, palette);
  /*
   * The backstop behind the ink reservation, and only where one was made: with
   * no reserved ink centre there is no claim that the dark end is one colour,
   * and folding anyway merges artwork. On `fixtures/logo-noisy-512.png` — whose
   * dark quarter is a navy AND a near-black, which is why it is not reserved at
   * all (`INK_MAX_COVERAGE`) — folding took those two colours down to one.
   */
  if (separateSlots && approximating && inkReserved) {
    palette = refillToBudget(hist, foldNearInk(palette), k, pinned);
  }

  return orderByCoverage(hist, palette);
}

/**
 * Luma at or above which a pixel is a *highlight* rather than one of the
 * drawing's light colours.
 *
 * Pure white is not a colour a coverage optimizer will ever spend a slot on. On
 * the gold-standard artwork the two fangs and the eye glints are 382 pixels —
 * 0.05 % of the drawn area — sitting inside a cream face, so median cut folds
 * them into the cream and Lloyd never pulls a centre back out. Measured on that
 * fixture, our 16-colour + Enhance output returned ZERO pixels above luma 230
 * where the source has 382 above 245, and the reference product returned 291: the
 * fangs came back as grey holes ringed by ink instead of white triangles.
 *
 * That is not a fidelity rounding error, it is the loss of a feature. REFERENCE's
 * own use cases — stickers, decals, tattoo templates — are exactly the artwork
 * where a white highlight is load-bearing, and white is also the one colour a
 * user cannot recover by editing the palette afterwards, because no slot holds
 * the pixels to repaint.
 */
const HIGHLIGHT_LUMA = 245;

/**
 * Share of the drawn area a band has to cover to be worth a slot.
 *
 * Ink is held to 0.5 % (`reserveDarkest`'s own bar) because a handful of stray
 * dark pixels is JPEG mosquito noise, not an outline. Highlights are held to
 * 0.02 %, two orders of magnitude lower, because that is the size a highlight
 * *is*: the gold standard's fangs and eye glints together are 0.05 % of the
 * drawn area and they are the first thing a person looks at.
 */
const INK_MIN_COVERAGE = 0.005;
const HIGHLIGHT_MIN_COVERAGE = 0.0002;

/**
 * Share of the drawn area above which the dark end is not ink at all.
 *
 * Ink is line art: a few per cent of the pixels and the whole picture. When a
 * quarter of the drawn area is dark, dark is one of the picture's *colours*,
 * there is no thin thing to protect, and a coverage optimizer is exactly the
 * right tool for it. Reserving anyway does real damage, because a picture that
 * dark usually has more than one dark colour and the reservation hands them one
 * slot between them: measured on `fixtures/logo-noisy-512.png` (25.6 % dark,
 * against the gold standard's 4.5 %) it merged the artwork's navy rgb(27,58,92)
 * and its near-black rgb(43,43,43) into rgb(31,49,70), and the two slots that
 * freed were re-spent on speckle — 13 sub-paths became 106.
 */
const INK_MAX_COVERAGE = 0.12;

/**
 * How many slots the drawing's own colour families keep before a highlight may
 * take one.
 *
 * A reserved slot is not a free slot — it is taken out of the budget the user
 * asked for — and at a small budget that trade goes the other way: on the gold
 * standard at six colours, spending one on the fangs cost the paw pads their
 * brown and put the region's mean colour error up from 18.1 to 29.8. The real
 * product draws the same line in the same place: its 16-colour capture of this
 * artwork carries rgb(254,254,254) as its own layer and its six-colour capture
 * stops at rgb(247,243,238) — no white at all.
 *
 * Ink is not held to this, because ink at two colours is still the drawing.
 */
const HIGHLIGHT_MIN_PICTURE_SLOTS = 5;

interface ReservedBand {
  centre: RgbColor;
  /** Whether a histogram colour belongs to the band. */
  holds: (c: RgbColor, luma: number) => boolean;
}

/**
 * Give the drawing's ink and its highlights a cluster centre each, before the
 * coverage optimizer gets to spend the budget.
 *
 * Median cut plus Lloyd is a least-squares fit, and both ends of the tonal
 * range are where least squares is systematically wrong about a *drawing*:
 *
 *  - **Ink** is a few per cent of the pixels and the whole picture.
 *    `reserveDarkest` already moved a slot onto it after the fact, but only
 *    when no slot had landed there at all — and at a large colour budget
 *    several do. On the gold standard at 16 colours the single source ink
 *    split into rgb(32,24,10) (warm brown) and rgb(28,47,53) (cold teal), 70
 *    L1 units apart, so `separate` left them alone and 21 % of the lower-jaw
 *    stroke came back teal: the outline visibly changed colour mid-line, and
 *    raising the colour count made the linework *worse*.
 *  - **Highlights** are too few pixels to win a slot at any budget
 *    (`HIGHLIGHT_LUMA`).
 *
 * Reserving is done by *withholding the band from the clustering* rather than
 * by patching the result afterwards. Both give the band a centre; only this one
 * also stops a second centre landing in it, which is the half that fixes the
 * split ink. The slots left over are spent on the colours that remain, so the
 * palette is still `k` entries — a reserved slot is not an extra slot.
 */
function reserveExtremes(
  hist: Histogram,
  /** The image's *drawn* highlights, or null if it has none — `supportedHighlight`. */
  light: { centre: RgbColor; share: number } | null,
  k: number,
  /**
   * Whether this is the palette the user is shown and the layers are cut from,
   * as opposed to one of the internal quantizations the cleanup passes run
   * (`separateSlots`). Only the INK half of the reservation is held back from
   * the cleanups, and the asymmetry is not arbitrary: withholding the sub-60
   * band takes mass out of the clustering, so inside Enhance's colour
   * simplification the outline's skirt joins the mid-tone above it instead and
   * the gold standard's paw pad went from 18.1 mean colour error to 29.5. The
   * highlight reservation only pins a centre on colours the image already has
   * at the far end of its range, and it MUST run in the cleanups too: at 16
   * colours Enhance hands the quantizer exactly 16 distinct colours, so the
   * simplification's palette IS the delivered one (see `SIMPLIFY_COLORS`,
   * src/engine/preprocess.ts) and a white the cleanup merged away can never
   * come back.
   */
  reserveInk: boolean,
): { bands: ReservedBand[]; pinned: number; inkReserved: boolean } {
  const bands: ReservedBand[] = [];
  let pinned = 0;
  let inkReserved = false;

  // The highlight goes first because `refine`/`separate` take a count of
  // leading entries to hold rather than a set.
  if (k - 1 >= HIGHLIGHT_MIN_PICTURE_SLOTS + 1 && light && light.share >= HIGHLIGHT_MIN_COVERAGE) {
    bands.push({ centre: light.centre, holds: (_c, l) => l >= HIGHLIGHT_LUMA });
    pinned = 1;
  }
  // Never spend the whole budget on the extremes: there has to be a slot left
  // for the picture between them.
  const ink = reserveInk ? bandMean(hist, (l) => l < INK_LUMA) : null;
  if (
    bands.length < k - 1 &&
    ink &&
    ink.share >= INK_MIN_COVERAGE &&
    ink.share <= INK_MAX_COVERAGE
  ) {
    bands.push({ centre: ink.centre, holds: (_c, l) => l < INK_LUMA });
    pinned = bands.length;
    inkReserved = true;
  }
  return { bands, pinned, inkReserved };
}

/**
 * How many of a pixel's eight neighbours a highlight needs to be a drawn one.
 *
 * The highlight bar is two orders of magnitude below the ink bar, because a
 * highlight really is that small — and a bar that low is a bar impulse noise
 * clears without trying. On `fixtures/logo-noisy-512.png` the seeded speckle
 * puts scattered pixels above luma 245 on paper that is rgb(242,239,230), and
 * a slot spent on them is a slot spent on grain: it took the RAW trace from 26
 * sub-paths to 31 and made "noise reduction: low" noisier than "off".
 *
 * Area cannot separate the two — the fangs and the speckle are the same number
 * of pixels — but shape can, and it is the same test `supportMap` uses one
 * module over (src/engine/preprocess.ts): an impulse stands alone, a drawn
 * feature has company. Half the neighbourhood is the bar; the interior of any
 * feature wider than a pixel clears it and no isolated pixel can.
 */
const HIGHLIGHT_SUPPORT_MIN = 4;

/**
 * The mean and drawn-area share of the image's *drawn* highlights: pixels above
 * `HIGHLIGHT_LUMA` that are part of a region rather than standing alone.
 */
function supportedHighlight(
  image: RasterImage,
  mask: Uint8Array | null | undefined,
  drawn: number,
): { centre: RgbColor; share: number } | null {
  const { width, height, data } = image;
  const bright = (x: number, y: number): boolean => {
    const p = y * width + x;
    if (mask && !mask[p]) return false;
    const i = p * 4;
    return lumaOf({ r: data[i], g: data[i + 1], b: data[i + 2] }) >= HIGHLIGHT_LUMA;
  };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!bright(x, y)) continue;
      let support = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          if (bright(nx, ny)) support++;
        }
      }
      if (support < HIGHLIGHT_SUPPORT_MIN) continue;
      const i = (y * width + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  if (n === 0) return null;
  return {
    centre: { r: clamp255(r / n), g: clamp255(g / n), b: clamp255(b / n) },
    share: n / Math.max(1, drawn),
  };
}

/**
 * The centres a clustering would actually SHIP, which is not the same list as
 * the centres it produces.
 *
 * Two entries closer than `MIN_SEPARATION` do not both reach the user: either
 * `separate` folds them here, or the near-duplicate fold does it downstream
 * (`mergeSimilarColors`, src/engine/index.ts `HALO_FOLD_PERCENT`). So a
 * question of the form "is any centre going to represent this region" has to be
 * asked of the survivors, and asking it of the raw list gets the answer wrong
 * in exactly the case that matters: on the mascot the raw list DOES hold a
 * salmon 29 units from the nose, and that salmon is the first thing the fold
 * takes.
 *
 * Greedy in descending coverage, which is the order the fold itself keeps in.
 */
function distinguishable(hist: Histogram, centres: RgbColor[]): RgbColor[] {
  if (centres.length < 2) return centres;
  const coverage = new Float64Array(centres.length);
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let j = 0; j < centres.length; j++) {
      const d = dist(r, g, b, centres[j]);
      if (d < bestD) {
        bestD = d;
        bestIdx = j;
      }
    }
    coverage[bestIdx] += hist.counts[i];
  }
  const order = centres.map((_, j) => j);
  order.sort(
    (a, b) =>
      coverage[b] - coverage[a] ||
      packRgb(centres[a].r, centres[a].g, centres[a].b) -
        packRgb(centres[b].r, centres[b].g, centres[b].b),
  );
  const kept: RgbColor[] = [];
  for (const j of order) {
    if (kept.every((c) => l1(c, centres[j]) > MIN_SEPARATION)) kept.push(centres[j]);
  }
  return kept;
}

/**
 * How far a colour has to sit from every centre the coverage optimizer would
 * otherwise ship — in `assignDist`, the hue-aware metric — before it counts
 * as chromatically ORPHANED.
 *
 * The bar is `MIN_SEPARATION`, the same 61 units the delivered palette already
 * promises between any two of its entries, and it is the same statement turned
 * around: if two colours that far apart are two colours a user can tell apart
 * and must therefore get a slot each, then a *region* that far from every slot
 * on offer is a region with no slot of its own. Measured in `assignDist` rather
 * than in plain L1 because that is the whole defect — the mascot's nose salmon
 * rgb(230,119,87) is 63 L1 units from the body orange it gets repainted as,
 * which is a difference plain RGB shrugs at and a person names instantly.
 */
const CHROMATIC_ORPHAN_DIST = MIN_SEPARATION;

/**
 * How wrong the repaint has to be, in the units the *rest* of this repo calls a
 * visible miss.
 *
 * 32 Euclidean RGB is `foreignColorRatio`'s window and
 * `nearDuplicateFillPairs`' window (instruments/lib/metrics.mjs): inside it two
 * colours are the same colour to the harness and to the eye, outside it they
 * are not. So a region only earns a slot of its own when losing it would land
 * its pixels further than that from their true colour — "the palette is a
 * colour short" is not a defect until somebody can see it.
 *
 * It is also what keeps this reservation from creating the defect it is meant
 * to fix: a reserved centre is by construction more than 32 Euclidean from
 * every centre the optimizer chose, which is exactly the bar
 * `maxNearDuplicateFills: 0` holds the delivered layers to.
 */
const CHROMATIC_MIN_MISS = 32;

/**
 * ...and how much of that miss has to be a HUE miss.
 *
 * The opponent-chroma disagreement — the red-green and blue-yellow term inside
 * `assignDist`, and the only part of a colour difference that is not tone.
 * Without this test the reservation reaches straight past what it is for and
 * starts pinning SHADING BANDS: a mid-tone of a soft gradient is a long way
 * from every centre a small budget can afford, entirely in lightness, and it is
 * a tone the coverage optimizer is the right tool for. Measured on the shaded
 * fixture at the default eight colours, reserving on distance alone pinned the
 * body blue's mid-band and the belly brown's — 1.0 % of the canvas each, both
 * of them the middle of a ramp whose ends already have slots — and the fold
 * that freed cost the picture its fit (whole-frame colour error 5.92 -> 6.76,
 * 167 sub-paths -> 175).
 *
 * The separation this draws is not a close-run thing. Chroma gap to the nearest
 * centre on offer, measured: the shaded fixture's blue band **1**, its brown
 * band **7** — against the mascot's nose salmon **51**, its eye olive **64**,
 * the fox's nose pink **78** and its eye cyan **133**. 32 is the same window
 * `CHROMATIC_MIN_MISS` uses and it sits in the middle of a gap an order of
 * magnitude wide.
 */
const CHROMATIC_MIN_HUE_GAP = 32;

/**
 * The opponent-chroma difference between two colours: `assignDist`'s hue term,
 * on its own. See `CHROMA_WEIGHT` for why these two axes are the ones hue lives
 * on.
 */
const chromaGap = (a: RgbColor, b: RgbColor): number => {
  const dr = b.r - a.r;
  const dg = b.g - a.g;
  const db = b.b - a.b;
  return Math.abs(dr - dg) + Math.abs(db - dg);
};

/**
 * Share of the counted area an orphaned region has to cover to be worth a slot.
 *
 * Between the ink bar (0.5 %) and the highlight bar (0.02 %), and for the
 * reason both of those are where they are: this is not line art and it is not a
 * glint, it is a FEATURE — a nose, an iris, an inner ear.
 *
 * Measured, on the two subjects that have one: the fox's eye cyan is 0.108 % of
 * its canvas and its nose pink is 0.084 %. A tenth of a per cent therefore
 * splits that pair, and splitting it is the worst available outcome — reserving
 * the eyes alone takes the slot the nose had been riding on, and the nose's
 * pale pink has NO warm neighbour to fall back to: its nearest survivor in
 * `assignDist` is the eye cyan itself (192 against the body orange's 266), so a
 * fox with rescued eyes came back with a **blue nose**. Both features or
 * neither. 0.05 % takes both, and is still 2.5x the highlight bar under which a
 * feature is a glint.
 */
const CHROMATIC_MIN_COVERAGE = 0.0005;

/**
 * How many of a pixel's eight neighbours share its band before it counts as
 * part of a region rather than a stray.
 *
 * The same half-neighbourhood test, and the same number, as
 * `HIGHLIGHT_SUPPORT_MIN` above, for the same reason: the interior of anything
 * wider than a pixel clears it and no isolated pixel can. It is doing more work
 * here than it does there, because the strays this has to reject are not noise
 * but ANTIALIASING — the one-pixel ribbon along a boundary between two regions
 * is genuinely far from both of their centres in hue, genuinely thousands of
 * pixels, and reserving a slot for it would ship the halo layer that Smart
 * anti-aliasing exists to remove. A ribbon one pixel wide has at most two
 * neighbours in its own band; a nose has eight.
 */
const CHROMATIC_SUPPORT_MIN = 4;

/**
 * How wide a reserved band is allowed to be, and the guard that stops it eating
 * the picture.
 *
 * A reserved band is *withheld from the clustering*, so its reach is not a
 * cosmetic choice: every colour it holds is a colour no other centre can be
 * spent on. `MIN_SEPARATION` alone is far too generous a radius for that — on
 * the mascot the nose salmon and the body orange are 63 L1 apart, so a 61-unit
 * ball around the nose swallows two thirds of the character and the delivered
 * palette came back with a salmon and NO body orange.
 *
 * So the band is a Voronoi cell rather than a ball: it holds the colours whose
 * nearest representative, in the hue-aware `assignDist`, is the reserved seed
 * rather than any centre already on offer. The radius stays as an outer bound,
 * because a cell is unbounded in the directions nothing else occupies and a
 * reservation has no business claiming a colour it merely happens to be closest
 * to from a long way off.
 */
const CHROMATIC_BAND_RADIUS = MIN_SEPARATION;

/**
 * How many slots the drawing's own colour families keep before a hue outlier
 * may take one.
 *
 * The same trade `HIGHLIGHT_MIN_PICTURE_SLOTS` makes and one notch tighter,
 * because there is no ceiling on how many hue outliers an image can contain: a
 * photograph is nothing but small chromatically isolated patches, and a
 * reservation per patch would hand an 8-colour request a palette of confetti.
 * Four families is the floor at which the mascot still gets its orange, its
 * stripe orange, its cream and its peach, and it caps the reservation at two
 * bands at the eight colours the demo is cut at.
 *
 * It is a floor, not the whole rule — see `computePaletteSync`, where the
 * budget the reservation actually gets is the smaller of this and the slots the
 * clustering was going to waste on near-duplicates.
 */
const CHROMATIC_MIN_PICTURE_SLOTS = 4;

/**
 * Give a small, coherent, chromatically isolated region a cluster centre of its
 * own — the third reservation, and the one that is about hue rather than tone.
 *
 * `reserveExtremes` withholds the two bands a *coverage* optimizer is
 * systematically wrong about at the ends of the tonal range. This is the same
 * argument made sideways. A mascot's nose, its inner ears, an iris: a couple of
 * thousand pixels carrying a hue nothing else in the drawing has, which is to
 * say a large share of the meaning and no share at all of the coverage
 * argument. Median cut never puts a box round them, Lloyd drags whatever centre
 * lands nearby back towards the big neighbouring region, and the near-duplicate
 * fold (`mergeSimilarColors`, src/engine/index.ts `HALO_FOLD_PERCENT`) then
 * reads the dragged centre as a halo of that neighbour and spends the slot.
 *
 * Measured on the mascot at the demo's eight colours: the quantizer DID find
 * the nose, at rgb(234,135,96) — but the true salmon is rgb(230,119,87), Lloyd
 * had pulled the centre 29 L1 units towards the body orange, and that put the
 * pair 54 units apart against the fold's 55.4. The nose came back orange
 * because its slot had been dragged to within a unit and a half of the fold
 * window. Pinning the centre where the pixels actually are puts the pair 63
 * apart and the layer survives — the reservation is not finding a colour the
 * clustering missed, it is stopping the clustering from walking off the one it
 * found.
 *
 * Four guards, in the order they are cheapest to fail:
 *
 *  1. **Orphaned** — further than `CHROMATIC_ORPHAN_DIST` in `assignDist` from
 *     every centre on offer, reserved ones included.
 *  2. **Visibly orphaned** — and further than `CHROMATIC_MIN_MISS` in plain
 *     Euclidean RGB, so the slot is only spent when losing it is something a
 *     person could point at.
 *  3. **Orphaned in HUE** — and `CHROMATIC_MIN_HUE_GAP` of that miss has to be
 *     hue rather than tone, which is what separates a nose from a shading band.
 *  4. **A region** — `CHROMATIC_SUPPORT_MIN` neighbours, which is what
 *     separates a nose from the antialiased ribbon along a boundary.
 *  5. **Big enough, and affordable** — `CHROMATIC_MIN_COVERAGE` of the counted
 *     area, and never so many that the picture's own families drop below
 *     `CHROMATIC_MIN_PICTURE_SLOTS`.
 */
function reserveChromatic(
  image: RasterImage,
  mask: Uint8Array | null | undefined,
  hist: Histogram,
  /** The histogram the clustering will actually see — ink/highlight removed. */
  rest: Histogram,
  /** Every centre already on offer: the reserved ones plus what median cut would pick. */
  offered: RgbColor[],
  /** How many more bands may be reserved before the picture runs short. */
  room: number,
): ReservedBand[] {
  if (room <= 0 || rest.distinct === 0 || offered.length === 0) return [];

  /** How far this colour is from the nearest centre already on offer. */
  const toOffered = (c: RgbColor): number => {
    let best = Infinity;
    for (const o of offered) {
      const d = assignDist(c.r, c.g, c.b, o);
      if (d < best) best = d;
    }
    return best;
  };
  /**
   * The band a seed claims: the colours it represents better than anything
   * already on offer does, out to `CHROMATIC_BAND_RADIUS`. See that constant —
   * a plain ball round the seed takes the neighbouring region with it.
   */
  const claims = (seed: RgbColor, c: RgbColor): boolean => {
    const d = assignDist(c.r, c.g, c.b, seed);
    return d <= CHROMATIC_BAND_RADIUS && d < toOffered(c);
  };

  // 1 + 2. Which of the histogram's colours no offered centre can represent —
  // not at all, not visibly, and not in hue.
  const orphans: number[] = [];
  for (let i = 0; i < rest.distinct; i++) {
    const c = rest.colors[i];
    const rgb = { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
    let plain = Infinity;
    let hue = Infinity;
    for (const o of offered) {
      const e = (o.r - rgb.r) ** 2 + (o.g - rgb.g) ** 2 + (o.b - rgb.b) ** 2;
      if (e < plain) plain = e;
      const h = chromaGap(rgb, o);
      if (h < hue) hue = h;
    }
    if (
      toOffered(rgb) > CHROMATIC_ORPHAN_DIST &&
      plain > CHROMATIC_MIN_MISS * CHROMATIC_MIN_MISS &&
      hue > CHROMATIC_MIN_HUE_GAP
    ) {
      orphans.push(i);
    }
  }
  if (orphans.length === 0) return [];

  // Group them into candidate regions, heaviest first so a band is seeded on
  // the colour a region actually is rather than on its darkest fringe pixel.
  orphans.sort((a, b) => rest.counts[b] - rest.counts[a] || rest.colors[a] - rest.colors[b]);
  const seeds: RgbColor[] = [];
  const member = new Map<PackedRgb, number>();
  for (const i of orphans) {
    const c = rest.colors[i];
    const rgb = { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
    let band = seeds.findIndex((s) => claims(s, rgb));
    if (band < 0) {
      // One candidate per slot there is room for, plus a little slack so a
      // region that fails the support test does not take the budget with it.
      if (seeds.length >= room + 2) continue;
      band = seeds.length;
      seeds.push(rgb);
    }
    member.set(c, band);
  }
  if (seeds.length === 0) return [];

  // 4. Which of those groups are REGIONS: pixels with company of their own kind.
  const { width, height, data } = image;
  const bandAt = new Int32Array(width * height).fill(-1);
  for (let p = 0; p < width * height; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    const b = member.get(packRgb(data[i], data[i + 1], data[i + 2]));
    if (b !== undefined) bandAt[p] = b;
  }
  const sumR = new Float64Array(seeds.length);
  const sumG = new Float64Array(seeds.length);
  const sumB = new Float64Array(seeds.length);
  const sumN = new Float64Array(seeds.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const b = bandAt[p];
      if (b < 0) continue;
      let support = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          if (bandAt[ny * width + nx] === b) support++;
        }
      }
      if (support < CHROMATIC_SUPPORT_MIN) continue;
      const i = p * 4;
      sumR[b] += data[i];
      sumG[b] += data[i + 1];
      sumB[b] += data[i + 2];
      sumN[b] += 1;
    }
  }

  // 5. Spend the room on the biggest regions that clear the area floor. Ties
  // broken by colour so the result cannot depend on scan order.
  const drawn = Math.max(1, hist.total);
  const ranked = seeds
    .map((_, b) => b)
    .filter((b) => sumN[b] / drawn >= CHROMATIC_MIN_COVERAGE)
    .sort((a, b) => sumN[b] - sumN[a] || packRgb(seeds[a].r, seeds[a].g, seeds[a].b) - packRgb(seeds[b].r, seeds[b].g, seeds[b].b))
    .slice(0, room);

  const out: ReservedBand[] = [];
  for (const b of ranked) {
    // The centre is the mean of the SUPPORTED pixels, not of the histogram
    // group: the fringe colours that joined the band are real members of it for
    // the purpose of keeping a second centre out, and are exactly what must not
    // be allowed to drag the centre off the region's own colour.
    const centre = {
      r: clamp255(sumR[b] / sumN[b]),
      g: clamp255(sumG[b] / sumN[b]),
      b: clamp255(sumB[b] / sumN[b]),
    };
    const seed = seeds[b];
    out.push({ centre, holds: (c) => claims(seed, c) });
  }
  return out;
}

/** Coverage-weighted mean of every histogram colour in a luma band. */
function bandMean(
  hist: Histogram,
  accept: (luma: number) => boolean,
): { centre: RgbColor; share: number } | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const cr = (c >> 16) & 255;
    const cg = (c >> 8) & 255;
    const cb = c & 255;
    if (!accept(lumaOf({ r: cr, g: cg, b: cb }))) continue;
    const w = hist.counts[i];
    r += cr * w;
    g += cg * w;
    b += cb * w;
    n += w;
  }
  if (n === 0) return null;
  return {
    centre: { r: clamp255(r / n), g: clamp255(g / n), b: clamp255(b / n) },
    share: n / Math.max(1, hist.total),
  };
}

/** The histogram with every reserved band's colours removed. */
function withoutBands(hist: Histogram, bands: ReservedBand[]): Histogram {
  const colors: number[] = [];
  const counts: number[] = [];
  let total = 0;
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const rgb = { r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 };
    const luma = lumaOf(rgb);
    if (bands.some((band) => band.holds(rgb, luma))) continue;
    colors.push(c);
    counts.push(hist.counts[i]);
    total += hist.counts[i];
  }
  return {
    colors: Uint32Array.from(colors),
    counts: Uint32Array.from(counts),
    distinct: colors.length,
    total,
  };
}

/**
 * One ink slot, at every k.
 *
 * The backstop behind `reserveExtremes`: withholding the ink band keeps median
 * cut out of it, but `refine` and `separate` are free to walk a centre back in
 * afterwards. A palette with two near-black entries paints one stroke in two
 * colours, which is a defect no amount of geometry accuracy makes up for, so
 * any entry that ends up under the ink bar other than the darkest one is folded
 * into it. (It costs a palette entry when it fires — that is the point: the
 * entry was a second name for a colour the drawing has once.)
 */
/**
 * Put back whatever `foldNearInk` took, somewhere the picture can use it.
 *
 * The fold is not allowed to cost the user a colour: `[B3] the colour budget is
 * spent on colours the user can tell apart` asks that a k-colour request come
 * back with k clusters, and "we merged your second near-black into your first"
 * is a reason to re-spend the slot, not to hand back k-1. So the freed slot is
 * split off the worst-fitting cluster — `separate`'s own move — and never off
 * the ink, which is the split this exists to undo.
 */
function refillToBudget(
  hist: Histogram,
  palette: RgbColor[],
  k: number,
  pinned: number,
): RgbColor[] {
  let current = palette;
  for (let round = 0; round < k && current.length < k; round++) {
    const { owner, error } = assign(hist, current);
    // Candidates in descending fit error, ink excluded — splitting the ink is
    // the move this exists to undo. The list is walked rather than just its
    // head because a split can settle back under the ink bar and be folded
    // again, and the answer to that is the next cluster, not giving up.
    const candidates = [];
    for (let j = pinned; j < current.length; j++) {
      if (lumaOf(current[j]) >= INK_LUMA) candidates.push(j);
    }
    candidates.sort((a, b) => error[b] - error[a]);
    let grew: RgbColor[] | null = null;
    for (const target of candidates) {
      const members: number[] = [];
      for (let i = 0; i < hist.distinct; i++) if (owner[i] === target) members.push(i);
      const halves = splitCluster(hist, members);
      if (!halves) continue;
      const next: RgbColor[] = [];
      for (let j = 0; j < current.length; j++) {
        if (j === target) next.push(halves[0], halves[1]);
        else next.push(current[j]);
      }
      const settled = foldNearInk(refine(hist, next, 3, pinned));
      if (settled.length > current.length) {
        grew = settled;
        break;
      }
    }
    if (!grew) break;
    current = grew;
  }
  return current;
}

function foldNearInk(palette: RgbColor[]): RgbColor[] {
  if (palette.length < 2) return palette;
  let darkest = -1;
  let bestLuma = INK_LUMA;
  for (let i = 0; i < palette.length; i++) {
    const l = lumaOf(palette[i]);
    if (l < bestLuma) {
      bestLuma = l;
      darkest = i;
    }
  }
  if (darkest < 0) return palette;
  const ink = palette[darkest];
  return palette.filter(
    (c, i) => i === darkest || lumaOf(c) >= INK_LUMA,
  );
}

/**
 * Keep the ink.
 *
 * Median cut plus Lloyd refinement is a *coverage* optimizer: it spends its
 * slots where the pixels are. On line art that is exactly wrong at a small
 * colour budget — the black outline is a few percent of the pixels but it is
 * the whole drawing, and averaging it into the nearest dark mid-tone turns a
 * character's outline into a dark teal smear (the failure REFERENCE's
 * gold-standard A/B exposes at 6 colours).
 *
 * So when the source really does contain a dark ink and no palette entry
 * landed on it, the entry that currently owns those dark pixels is moved onto
 * their centroid. The count is unchanged; only where one slot sits changes.
 */
function reserveDarkest(hist: Histogram, palette: RgbColor[]): RgbColor[] {
  if (palette.length < 2) return palette;
  if (palette.some((c) => lumaOf(c) < INK_LUMA)) return palette;

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const cr = (c >> 16) & 255;
    const cg = (c >> 8) & 255;
    const cb = c & 255;
    if (lumaOf({ r: cr, g: cg, b: cb }) >= INK_LUMA * 0.75) continue;
    const w = hist.counts[i];
    r += cr * w;
    g += cg * w;
    b += cb * w;
    n += w;
  }
  // A handful of stray dark pixels is not an outline; 0.5 % of the canvas is.
  if (n === 0 || n / hist.total < 0.005) return palette;
  const ink = { r: clamp255(r / n), g: clamp255(g / n), b: clamp255(b / n) };

  let owner = 0;
  let bestD = Infinity;
  for (let j = 0; j < palette.length; j++) {
    const d = dist(ink.r, ink.g, ink.b, palette[j]);
    if (d < bestD) {
      bestD = d;
      owner = j;
    }
  }
  const out = palette.map((c) => ({ ...c }));
  out[owner] = ink;
  return out;
}

function refine(
  hist: Histogram,
  palette: RgbColor[],
  iterations: number,
  /** Leading entries that keep their colour — see `reserveExtremes`. */
  pinned = 0,
): RgbColor[] {
  const k = palette.length;
  let current = palette.map((c) => ({ ...c }));
  for (let it = 0; it < iterations; it++) {
    const sumR = new Float64Array(k);
    const sumG = new Float64Array(k);
    const sumB = new Float64Array(k);
    const sumN = new Float64Array(k);
    for (let i = 0; i < hist.distinct; i++) {
      const c = hist.colors[i];
      const r = (c >> 16) & 255;
      const g = (c >> 8) & 255;
      const b = c & 255;
      let bestIdx = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = dist(r, g, b, current[j]);
        if (d < bestD) {
          bestD = d;
          bestIdx = j;
        }
      }
      const w = hist.counts[i];
      sumR[bestIdx] += r * w;
      sumG[bestIdx] += g * w;
      sumB[bestIdx] += b * w;
      sumN[bestIdx] += w;
    }
    let moved = false;
    const next = current.map((c, j) => {
      if (j < pinned || sumN[j] === 0) return c;
      const n = {
        r: clamp255(sumR[j] / sumN[j]),
        g: clamp255(sumG[j] / sumN[j]),
        b: clamp255(sumB[j] / sumN[j]),
      };
      if (n.r !== c.r || n.g !== c.g || n.b !== c.b) moved = true;
      return n;
    });
    current = next;
    if (!moved) break;
  }
  return current;
}

/**
 * The two closest palette entries `separate` is allowed to fold together.
 *
 * `pinned` leading entries are excluded: they are the reserved ink/highlight
 * centres, and folding one back into its neighbour is exactly the outcome the
 * reservation exists to prevent.
 */
function closestPair(palette: RgbColor[], pinned = 0): { i: number; j: number; d: number } {
  let bi = pinned;
  let bj = pinned + 1;
  let bd = Infinity;
  for (let i = pinned; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const d = l1(palette[i], palette[j]);
      if (d < bd) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }
  return { i: bi, j: bj, d: bd };
}

/** Weighted L1 quantization error of a palette over the whole histogram. */
function totalError(hist: Histogram, palette: RgbColor[]): number {
  let sum = 0;
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let bestD = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const d = dist(r, g, b, palette[j]);
      if (d < bestD) bestD = d;
    }
    sum += bestD * hist.counts[i];
  }
  return sum;
}

/** Nearest entry per distinct histogram colour, plus each entry's total error. */
function assign(hist: Histogram, palette: RgbColor[]): { owner: Int32Array; error: Float64Array } {
  const owner = new Int32Array(hist.distinct);
  const error = new Float64Array(palette.length);
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const d = dist(r, g, b, palette[j]);
      if (d < bestD) {
        bestD = d;
        bestIdx = j;
      }
    }
    owner[i] = bestIdx;
    error[bestIdx] += bestD * hist.counts[i];
  }
  return { owner, error };
}

/** Split one cluster's members in two at the weighted median of its widest axis. */
function splitCluster(hist: Histogram, members: number[]): [RgbColor, RgbColor] | null {
  if (members.length < 2) return null;
  const chan = (idx: number, shift: number) => (hist.colors[idx] >> shift) & 255;
  let shift = 16;
  let widest = -1;
  for (const s of [16, 8, 0]) {
    let lo = 255;
    let hi = 0;
    for (const m of members) {
      const v = chan(m, s);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Same perceptual weighting as the median cut above, so a split here and a
    // split there cut the same way.
    const w = (hi - lo) * (s === 16 ? 0.5 : s === 8 ? 0.6 : 0.4);
    if (w > widest) {
      widest = w;
      shift = s;
    }
  }
  if (widest <= 0) return null;
  const sorted = [...members].sort(
    (a, b) => chan(a, shift) - chan(b, shift) || hist.colors[a] - hist.colors[b],
  );
  let total = 0;
  for (const m of sorted) total += hist.counts[m];
  const half = total / 2;
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    acc += hist.counts[sorted[i]];
    cut = i + 1;
    if (acc >= half) break;
  }
  const lo = centroid(Int32Array.from(sorted.slice(0, cut)), hist);
  const hi = centroid(Int32Array.from(sorted.slice(cut)), hist);
  if (l1(lo, hi) === 0) return null;
  return [lo, hi];
}

/**
 * Spend every palette slot on a colour the user can tell apart from the others.
 *
 * Median cut plus Lloyd is a least-squares fit, and least-squares is happy to
 * park two slots a dozen units apart inside one big smooth region while a whole
 * smaller colour family goes unrepresented — the fit barely notices, and the
 * picture loses a hue. On the gold-standard artwork at eight colours it spent
 * three slots on creams (two of them 14 units apart) and none on the browns, so
 * the paw pads were repainted from the nearest survivor, a blue, and a warm
 * brown came back teal.
 *
 * So: while two entries sit closer than `MIN_SEPARATION`, fold that pair into
 * one and re-spend the freed slot on the cluster carrying the most error. Each
 * round is accepted only if it actually pushes the palette further apart, and
 * the best palette seen is what is returned, so this cannot oscillate and
 * cannot make the separation worse than what it was handed.
 */
function separate(
  hist: Histogram,
  palette: RgbColor[],
  rounds = 8,
  /** Leading entries that are neither folded away nor split — see `reserveExtremes`. */
  pinned = 0,
): RgbColor[] {
  if (palette.length < 3) return palette;
  let current = palette.map((c) => ({ ...c }));
  let best = current;
  let bestSep = closestPair(current, pinned).d;
  let bestErr = totalError(hist, current);
  for (let round = 0; round < rounds; round++) {
    const pair = closestPair(current, pinned);
    if (pair.d >= MIN_SEPARATION) break;
    const { owner, error } = assign(hist, current);
    // The slot to re-spend on: the worst-fitting cluster that is not one of the
    // two being folded together (folding and splitting the same region is a
    // no-op that would loop forever), and not a reserved one (splitting the ink
    // slot in two is the defect this whole reservation exists to stop).
    let target = -1;
    let worst = 0;
    for (let j = pinned; j < current.length; j++) {
      if (j === pair.i || j === pair.j) continue;
      if (error[j] > worst) {
        worst = error[j];
        target = j;
      }
    }
    if (target < 0) break;
    const members: number[] = [];
    for (let i = 0; i < hist.distinct; i++) if (owner[i] === target) members.push(i);
    const halves = splitCluster(hist, members);
    if (!halves) break;

    const merged = centroid(
      Int32Array.from(
        (() => {
          const m: number[] = [];
          for (let i = 0; i < hist.distinct; i++) if (owner[i] === pair.i || owner[i] === pair.j) m.push(i);
          return m;
        })(),
      ),
      hist,
    );
    const next: RgbColor[] = [];
    for (let j = 0; j < current.length; j++) {
      if (j === pair.j) continue;
      if (j === pair.i) next.push(merged);
      else if (j === target) next.push(halves[0], halves[1]);
      else next.push(current[j]);
    }
    current = refine(hist, next, 3, pinned);
    const sep = closestPair(current, pinned).d;
    const err = totalError(hist, current);
    // A round is kept only if it is better on BOTH counts: the palette is more
    // separated *and* it fits the picture at least as well. The second half is
    // what keeps this from spending a slot on speckle — on a noisy scan the
    // freed slot lands on a grain family, the fit gets worse, and the round is
    // thrown away.
    if (sep <= bestSep || err > bestErr) break;
    bestSep = sep;
    bestErr = err;
    best = current;
  }
  return best;
}

function orderByCoverage(hist: Histogram, palette: RgbColor[]): RgbColor[] {
  const k = palette.length;
  const coverage = new Float64Array(k);
  for (let i = 0; i < hist.distinct; i++) {
    const c = hist.colors[i];
    const r = (c >> 16) & 255;
    const g = (c >> 8) & 255;
    const b = c & 255;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const d = dist(r, g, b, palette[j]);
      if (d < bestD) {
        bestD = d;
        bestIdx = j;
      }
    }
    coverage[bestIdx] += hist.counts[i];
  }
  const idx = palette.map((_, j) => j);
  idx.sort((a, b) => coverage[b] - coverage[a] || packRgb(palette[a].r, palette[a].g, palette[a].b) - packRgb(palette[b].r, palette[b].g, palette[b].b));
  const out: RgbColor[] = [];
  const seen = new Set<number>();
  for (const j of idx) {
    if (coverage[j] <= 0) continue;
    const key = packRgb(palette[j].r, palette[j].g, palette[j].b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(palette[j]);
  }
  if (out.length === 0) out.push(palette[0] ?? { r: 0, g: 0, b: 0 });
  return out;
}

/**
 * Nearest-palette-entry index per pixel. Cached per distinct source colour.
 *
 * With an opacity `mask`, see-through pixels get `TRANSPARENT_INDEX` instead of
 * a colour: they are not part of any layer, so whatever RGB the decoder left
 * behind for them (a canvas hands back `(0,0,0,0)`) never reaches the output.
 */
export function mapToPalette(
  image: RasterImage,
  palette: RgbColor[],
  mask?: Uint8Array | null,
): Uint8Array {
  const pixels = image.width * image.height;
  const out = new Uint8Array(pixels);
  const { data } = image;
  const cache = new Map<number, number>();
  const k = palette.length;
  // Judged with `assignDist`, not `dist`: this is the one place a pixel is told
  // which colour family it belongs to, and a hue flip here is the defect a
  // person names instantly ("why is there blue in his mouth").
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    if (mask && !mask[p]) {
      out[p] = TRANSPARENT_INDEX;
      continue;
    }
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = packRgb(r, g, b);
    let hit = cache.get(key);
    if (hit === undefined) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = assignDist(r, g, b, palette[j]);
        if (d < bestD) {
          bestD = d;
          bestIdx = j;
        }
      }
      hit = bestIdx;
      cache.set(key, hit);
    }
    out[p] = hit;
  }
  return out;
}

/** Pixel coverage per palette entry. Transparent pixels count for nobody. */
export function coverageOf(indices: Uint8Array, paletteSize: number): Uint32Array {
  const counts = new Uint32Array(paletteSize);
  for (let i = 0; i < indices.length; i++) {
    const c = indices[i];
    if (c < paletteSize) counts[c]++;
  }
  return counts;
}

/**
 * Apply an index remap, leaving `TRANSPARENT_INDEX` alone.
 *
 * Every stage that renumbers the palette has to go through here: a bare
 * `indices[p] = map[indices[p]]` reads past the end of the map for a
 * transparent pixel, and `undefined` coerces to 0 — which silently repaints the
 * whole see-through background with palette entry 0.
 */
export function remapIndices(indices: Uint8Array, map: ArrayLike<number>): void {
  for (let p = 0; p < indices.length; p++) {
    const v = indices[p];
    if (v === TRANSPARENT_INDEX || v >= map.length) continue;
    indices[p] = map[v];
  }
}

/**
 * How far off "equidistant" a fringe band may be and still be handed to the
 * RARER of the two colours it separates, as a multiple of the nearer distance.
 *
 * The tiebreak exists because assigning a halo is not symmetric: paper has
 * pixels to spare and a two-pixel stroke has none, so a wrong call toward the
 * paper deletes information the picture cannot get back while a wrong call
 * toward the stroke costs a pixel of width. 1.15 was the window for a
 * one-pixel ramp, where a 50 %-coverage pixel really is equidistant by
 * construction. A *band* is not one pixel: its average colour sits wherever the
 * edge profile put it, several per cent off the midpoint, and at 1.15 the
 * fringe collapse then reliably rounded the gold standard's mouth and eyelids
 * toward the paper — Enhance cost the face 1.4 points of ink recall where the
 * same run without it lost none. 1.5 is wide enough to cover that skew and
 * still narrow enough that a band which genuinely belongs to the lighter side
 * (nearly twice as close to it) goes there.
 */
const FRINGE_TIE_WINDOW = 1.5;

/**
 * How far OFF the line joining two regions a thin band between them may sit and
 * still count as their ramp, as a fraction of the distance between them.
 *
 * The in-between test above (`isBlendOf`) asks whether a band's colour lies on
 * the SEGMENT between the two colours it separates, which is the right question
 * for a blend and the wrong one for a *halo*. Real artwork
 * arrives resampled, and a resampler with any sharpening in it leaves an
 * overshoot beside every hard edge: the mascot's eye is drawn with a black
 * outline directly against an olive iris, and the source carries a one-pixel rim
 * BRIGHTER than the iris along the inside of that outline. That rim is on the
 * ink→olive ramp and then some — it is the same ramp overshooting past its light
 * end — so the segment test rejects it as "a genuine third colour", the fringe
 * collapse leaves it alone, and at eight colours the nearest palette slot to it
 * is the muzzle CREAM. The trace then threads a cream ribbon between the outline
 * and the iris: a colour that belongs to neither side of that boundary, which is
 * exactly what the fringe rule exists to forbid.
 *
 * So the test becomes the corridor rather than the segment: perpendicular
 * distance from the band's colour to the LINE through the two, plus a bound on
 * how far past the ends it may sit. Measured on the mascot, the eye rim is 11 %
 * off the line at 28 % past the olive end, while the things that must not be
 * touched are nowhere near it — a necklace stripe between cream and body orange
 * is 58 % off their line, the white catchlight between pupil and iris is 52 %
 * off theirs, and every ink band between two lighter colours is more than 100 %
 * off. 0.2 and 0.45 sit in that gap with room on both sides.
 */
const FRINGE_CORRIDOR = 0.2;
/** How far past either end of the ramp an overshoot may sit, as a fraction. */
const FRINGE_OVERSHOOT = 0.45;
/**
 * Luma below which one side of the boundary counts as the stroke that made the
 * halo. The same number `preprocess.ts` calls `RAMP_INK_LUMA`, for the same
 * reason: it is where a colour stops being a shade of the drawing and starts
 * being its line art.
 */
const FRINGE_INK_LUMA = 60;
/**
 * How thick a HALO may be, in pixels — an absolute number, unlike the blend
 * band's `maxThickness`, which is a fraction of the picture.
 *
 * A blend band is as wide as the edge that made it, and a drawn edge scales with
 * the artwork (the same soft outline is 3 px on a 256px sticker and 12 on a
 * 1046px illustration), which is why `fringeThickness` is proportional. An
 * overshoot is not that: it is the ringing of a resampling kernel, and a kernel
 * is a couple of pixels wide whatever it is resampling. Measured, this is the
 * line between the two cases — the mascot's eye rim is 1.6 px thick, while the
 * shaded fixture's muzzle carries legitimate highlight bands 5 to 14 px thick
 * that are just as collinear with the ink and just as light, and eating those
 * cost its muzzle 1.9 points of ink recall.
 */
const HALO_MAX_THICKNESS = 3;

/**
 * How far OFF the line joining two regions a BLEND may sit, as a fraction of
 * the distance between them.
 *
 * A blend is a mixture: `α·a + (1-α)·b` is on the segment by construction, and
 * only quantization rounding takes it off. So this is tight, and much tighter
 * than the halo corridor above — a halo is an overshoot, which is off the line
 * by nature, while a band that is a *long way* off the line joining its two
 * neighbours is not made of them at all.
 *
 * It replaces a triangle test in L1 — `da + db <= span * 1.35` — which was not
 * measuring what it read as. L1 is additive along any monotone path between two
 * corners of the RGB cube, so with `a` black and `b` white the test is
 * satisfied by **every colour there is**, and with `a` any colour and `b` black
 * it is satisfied by every darker shade of `a`. That is not an edge case, it is
 * every drawing with an outline: measured, it deleted the mascot's three cheek
 * stripes (a darker orange on the body orange, meeting the face outline — 490,
 * 273 and 58 px, 45 % of the stripe-orange in that crop) and the fox's CYAN
 * EYES (1071 px down to 7), both of which read as "between" only because L1
 * says a saturated colour is between black and white.
 *
 * The number is bounded on both sides by the fixtures, and the window is
 * narrow enough to be worth writing down. Measured as area-weighted
 * perpendicular offset over every band this rule considers:
 *
 *  - **Below 4 %** — the fox's genuine blends (20,210 px) and the shaded
 *    illustration's (10,378 px). Everything here must still collapse.
 *  - **12.0 %** — the shaded illustration's dark outline skirt, `rgb(83,67,33)`
 *    against its ink. Must still collapse: sparing it keeps a near-ink layer
 *    the outline needs, and the paw crop's strict ink recall goes to 0.976x the
 *    reference product's against a 0.99x bar.
 *  - **15.2 %** — the mascot's biggest cheek stripe, 490 px. Must be spared.
 *  - **24.3 %** — the fox's eye cyan, 1,071 px down to 7. Must be spared.
 *
 * So the corridor has to sit inside (0.120, 0.152) and 0.13 is where it sits.
 * That is one part in a hundred of margin on the low side, which is thin, and
 * the two numbers bounding it are recorded above rather than rounded away so
 * that a future fixture landing between them is recognisable as what it is.
 */
const FRINGE_BLEND_CORRIDOR = 0.13;

/**
 * How far past either end of the ramp a blend may sit.
 *
 * Small, and for the opposite reason `FRINGE_OVERSHOOT` is large: overshoot is
 * the halo's signature, not the blend's, and the halo branch below is where an
 * overshoot belongs. It is not zero because the two ends are cluster centres
 * rather than the exact colours the edge ran between — measured on the fox, the
 * near-duplicate ink bands land at t = -0.05 and 1.05, and on the shaded
 * illustration the cream's own light rim at t = -0.11.
 *
 * 0.20 is too far: it readmits a 392 px band at t = 1.16, a *second* cream past
 * the light end of the cream→ink ramp, and the shaded illustration's face crop
 * loses strict ink recall (0.9651 against a 0.97 bar) to the layer it keeps.
 */
const FRINGE_BLEND_SLACK = 0.15;

/**
 * Is `c` a mixture of `a` and `b` — on the segment between them, within
 * `FRINGE_BLEND_CORRIDOR`?
 *
 * Euclidean, like `onRamp` and for the same reason: this is a projection onto a
 * line in RGB space, and "how far off the line" only means anything in the
 * metric the projection is taken in.
 */
function isBlendOf(c: RgbColor, a: RgbColor, b: RgbColor): boolean {
  const ux = b.r - a.r;
  const uy = b.g - a.g;
  const uz = b.b - a.b;
  const len2 = ux * ux + uy * uy + uz * uz;
  if (len2 <= 0) return false;
  const vx = c.r - a.r;
  const vy = c.g - a.g;
  const vz = c.b - a.b;
  const t = (vx * ux + vy * uy + vz * uz) / len2;
  if (t < -FRINGE_BLEND_SLACK || t > 1 + FRINGE_BLEND_SLACK) return false;
  const px = vx - t * ux;
  const py = vy - t * uy;
  const pz = vz - t * uz;
  return (
    px * px + py * py + pz * pz <=
    FRINGE_BLEND_CORRIDOR * FRINGE_BLEND_CORRIDOR * len2
  );
}

/**
 * Is `c` on the ramp between `a` and `b` — including past its ends?
 *
 * Distances are Euclidean here rather than L1: this is a projection onto a line
 * in RGB space, and "how far off the line" only means anything in the metric the
 * projection is taken in.
 */
function onRamp(c: RgbColor, a: RgbColor, b: RgbColor): boolean {
  /**
   * A halo is LIGHTER THAN BOTH sides. Anything else is a region.
   *
   * This is the same sentence the instrument that catches the defect is written
   * in (`seamSlivers`: a boundary pixel lighter than both of its neighbours
   * where the source has nothing that light), and it is what keeps the rule from
   * reaching past what it was built for. A resampler overshoots on the light
   * side of an edge and undershoots on the dark side, and on the dark side the
   * same geometry describes something else entirely: a thin band darker than the
   * regions either side of it is what an OUTLINE is. Measured on the soft-
   * outlined shaded fixture at the default settings, dropping this test cost its
   * muzzle 1.9 points of ink recall (0.997 -> 0.978) and 1.6 of strict recall,
   * because a soft outline's core sits inside the corridor of the mid-tones
   * either side of it.
   */
  const luma = (x: RgbColor): number => 0.299 * x.r + 0.587 * x.g + 0.114 * x.b;
  if (luma(c) <= Math.max(luma(a), luma(b))) return false;
  /**
   * ...and it has to be beside a STROKE.
   *
   * On shaded artwork every colour of a soft ramp is nearly collinear with every
   * other, so "on the line between its neighbours" is true of a legitimate
   * shading band as well — measured on the shaded fixture, the corridor test
   * without this line swallowed 861 pixels of the highlight along its muzzle
   * (region ink recall 0.997 -> 0.978). What the halo has that a shading band
   * does not is the hard edge that made it: a resampler only overshoots where
   * there is something to overshoot from, and the case this rule is for is a
   * light rim wedged between an outline and the region the outline is drawn on.
   * So one of the two sides must be ink, and then "lighter than both" and "on
   * their ramp" describe one thing only.
   */
  if (Math.min(luma(a), luma(b)) >= FRINGE_INK_LUMA) return false;
  const ux = b.r - a.r;
  const uy = b.g - a.g;
  const uz = b.b - a.b;
  const len2 = ux * ux + uy * uy + uz * uz;
  if (len2 <= 0) return false;
  const vx = c.r - a.r;
  const vy = c.g - a.g;
  const vz = c.b - a.b;
  const t = (vx * ux + vy * uy + vz * uz) / len2;
  if (t < -FRINGE_OVERSHOOT || t > 1 + FRINGE_OVERSHOOT) return false;
  const px = vx - t * ux;
  const py = vy - t * uy;
  const pz = vz - t * uz;
  return px * px + py * py + pz * pz <= len2 * FRINGE_CORRIDOR * FRINGE_CORRIDOR;
}

export interface DespeckleOptions {
  /** Regions with fewer pixels than this are candidates for removal. */
  minArea: number;
  /**
   * Palette the indices refer to. Required for `maxContrast`.
   */
  palette?: RgbColor[];
  /**
   * Maximum L1 colour distance (0..765) between a speck and the neighbour it
   * would be merged into. A tiny region that is *wildly* different from its
   * surroundings is a feature of the artwork (or genuine impulse noise the user
   * may want to keep visible); a tiny region that is barely different is a
   * quantization artefact of sensor/compression grain. Only the latter is
   * merged. `Infinity` merges regardless of contrast.
   */
  maxContrast?: number;
  /**
   * Exempt *strokes* from the area test.
   *
   * A speck and a hairline can have the same pixel count, and an area-only
   * filter cannot tell them apart: at the enhance floor (~85px² on the 1024px
   * reference artwork) a 2px-wide, 30px-long eyelid is 60px² and disappears,
   * which is what turned the reference artwork's mouth and eyes into dashes.
   * Elongation
   * separates them without a magic length: `maxDim² / area` is 1 for a disc,
   * ~1 for any compact blob, and grows with the aspect ratio of a stroke, so a
   * region longer than ~`elongation`× its own thickness is treated as line art
   * and kept.
   *
   * Off by default: REFERENCE B5's Minimum Area is a literal promise about the
   * document ("nothing under N px²"), so only the cleanup filters that claim to
   * remove *noise* turn it on.
   */
  keepElongated?: boolean;
  /** `maxDim² / area` at or above which a small region counts as a stroke. */
  elongation?: number;
  /**
   * Merge only *fringe* regions — the ones whose colour lies between the two
   * colours they separate (REFERENCE B4 anti-aliasing, at region scale).
   *
   * The pixel-level pass in preprocess.ts only sees a 3×3 window, so a fringe
   * two or three pixels wide is a local majority and survives it, and it can be
   * far too large for any speck threshold: the 40×3 grey band along the
   * reference artwork's mouth is 120px². What identifies it is not its size but
   * that it is thin AND in-between, which is exactly what this mode tests.
   */
  onlyFringe?: boolean;
  /**
   * Average thickness (area / longest side), in pixels, at or below which a
   * region counts as a thin band. Only used with `onlyFringe`.
   */
  maxThickness?: number;
  /**
   * Leave the see-through part of the picture alone.
   *
   * A transparent region is not a speck however small it is — it is a hole the
   * artwork asked for — so it is never merged into a colour. The reverse is
   * allowed: an opaque speck floating in transparency with nothing else to
   * merge into disappears, which is what a despeckle filter is for.
   */
  transparentIndex?: number;
  /**
   * Palette entries this filter is not allowed to merge away, one flag per
   * index.
   *
   * The Enhance floor's job is to flatten a busy *background*, and area alone
   * cannot tell a scrap of background pattern from a stroke of the drawing.
   * The ink is the one colour where being small is normal — a 2px eyelid, the
   * gap between two teeth — and where losing a region is not a simplification
   * but a hole in the picture. Marking it protected states that directly
   * instead of hoping the area/elongation/contrast tests happen to spare it.
   */
  protect?: Uint8Array;
}

/**
 * Drop connected regions smaller than `minArea`, merging each into the
 * neighbouring colour it shares the most border with (REFERENCE B2 despeckle).
 * Operates in place on the index image. 4-connectivity.
 *
 * Returns the number of regions merged away.
 */
export function despeckleIndices(
  indices: Uint8Array,
  width: number,
  height: number,
  options: DespeckleOptions,
): number {
  const minArea = options.minArea;
  const palette = options.palette;
  const maxContrast = options.maxContrast ?? Infinity;
  const keepElongated = options.keepElongated === true;
  const elongation = options.elongation ?? 6;
  const onlyFringe = options.onlyFringe === true;
  const maxThickness = options.maxThickness ?? 3;
  const transparentIndex = options.transparentIndex ?? -1;
  const protect = options.protect;
  if (minArea <= 1 && !onlyFringe) return 0;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const areas: number[] = [];
  /** Longest bounding-box side per label; only needed for `keepElongated`. */
  const maxDims: number[] = [];
  let labelCount = 0;

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1) continue;
    const color = indices[start];
    const label = labelCount++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let area = 0;
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;
    while (head < tail) {
      const p = queue[head++];
      area++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0) {
        const q = p - 1;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
      if (x + 1 < width) {
        const q = p + 1;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
      if (y > 0) {
        const q = p - width;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
      if (y + 1 < height) {
        const q = p + width;
        if (labels[q] === -1 && indices[q] === color) {
          labels[q] = label;
          queue[tail++] = q;
        }
      }
    }
    areas.push(area);
    maxDims.push(Math.max(x1 - x0, y1 - y0) + 1);
  }

  // Bucket pixels by label (counting sort) so each speck can be rewritten.
  const offsets = new Int32Array(labelCount + 1);
  for (let l = 0; l < labelCount; l++) offsets[l + 1] = offsets[l] + areas[l];
  const cursor = offsets.slice(0, labelCount);
  const members = new Int32Array(n);
  for (let p = 0; p < n; p++) members[cursor[labels[p]]++] = p;

  const small: number[] = [];
  for (let l = 0; l < labelCount; l++) {
    const own = indices[members[offsets[l]]];
    // Transparency is not speckle: a hole never merges into a colour.
    if (transparentIndex >= 0 && own === transparentIndex) continue;
    if (protect && protect[own]) continue;
    if (onlyFringe) {
      // Thin bands only — a fringe is by definition a couple of pixels wide.
      if (areas[l] / maxDims[l] <= maxThickness) small.push(l);
    } else if (areas[l] < minArea) {
      small.push(l);
    }
  }
  // Smallest first: specks inside specks collapse outward.
  small.sort((a, b) => areas[a] - areas[b] || a - b);

  const tally = new Int32Array(256);
  /** Global pixel count per index — the rarity tiebreak below needs it. */
  const coverage = new Int32Array(256);
  if (onlyFringe) for (let p = 0; p < n; p++) coverage[indices[p]]++;
  let merged = 0;

  for (const label of small) {
    const from = offsets[label];
    const to = offsets[label + 1];
    tally.fill(0);
    let touched = false;
    for (let m = from; m < to; m++) {
      const p = members[m];
      const x = p % width;
      const y = (p / width) | 0;
      if (x > 0 && labels[p - 1] !== label) {
        tally[indices[p - 1]]++;
        touched = true;
      }
      if (x + 1 < width && labels[p + 1] !== label) {
        tally[indices[p + 1]]++;
        touched = true;
      }
      if (y > 0 && labels[p - width] !== label) {
        tally[indices[p - width]]++;
        touched = true;
      }
      if (y + 1 < height && labels[p + width] !== label) {
        tally[indices[p + width]]++;
        touched = true;
      }
    }
    if (!touched) continue;
    let bestColor = -1;
    let bestScore = 0;
    for (let c = 0; c < 256; c++) {
      if (tally[c] > bestScore) {
        bestScore = tally[c];
        bestColor = c;
      }
    }
    const own = indices[members[from]];
    if (bestColor < 0) continue;
    const ownColor = palette ? palette[own] : undefined;

    /** Runner-up neighbour by border length — the other side of a fringe. */
    let secondColor = -1;
    let secondScore = 0;
    for (let c = 0; c < 256; c++) {
      if (c === bestColor) continue;
      if (tally[c] > secondScore) {
        secondScore = tally[c];
        secondColor = c;
      }
    }

    /**
     * Is this region an antialiasing fringe?
     *
     * A fringe is the one-pixel ramp between two flat colours, so its colour
     * lies *between* the two regions it separates. A piece of line art is an
     * extreme instead — the black of a stroke is not between the cream either
     * side of it. Same test `deAntialias` uses per pixel (src/engine/
     * preprocess.ts), applied to a whole region.
     */
    let fringe = false;
    /**
     * ...and the same question asked of the whole ramp rather than of the
     * segment: a band that OVERSHOOTS one end of it is still that boundary's
     * artefact and still may not keep a palette slot of its own (see
     * `FRINGE_CORRIDOR`). Kept separate from `fringe` on purpose — the strict
     * in-between test is also what buys a band out of the elongation exemption
     * in the *noise* filters below, and widening that would put line art back in
     * their reach. Only the `onlyFringe` collapse reads this one.
     */
    let rampBand = false;
    if (ownColor && palette && secondColor >= 0) {
      const a = palette[bestColor];
      const b = palette[secondColor];
      if (a && b) {
        const span = dist(a.r, a.g, a.b, b);
        const da = dist(ownColor.r, ownColor.g, ownColor.b, a);
        const db = dist(ownColor.r, ownColor.g, ownColor.b, b);
        const real = span >= 48 && da > 0 && db > 0;
        fringe = real && isBlendOf(ownColor, a, b);
        /**
         * `tally[own] === 0`: THE BAND'S COLOUR IS FOREIGN HERE.
         *
         * The tally counts the colours this region borders, so a non-zero entry
         * for its OWN index means the same colour is also painted somewhere else
         * in the immediate neighbourhood — across the stroke, or just past the
         * band. That is what a shading band looks like: the region beside it,
         * continuing. A halo looks like the opposite; the mascot's eye rim is
         * painted with the MUZZLE's cream, which exists nowhere near the eye.
         * This is `foreignColorRatio`'s question asked locally, and it is the
         * one condition that separates the two cases on artwork where every
         * colour of the ramp is nearly collinear with every other.
         */
        rampBand =
          fringe ||
          (real &&
            tally[own] === 0 &&
            areas[label] / maxDims[label] <= HALO_MAX_THICKNESS &&
            onRamp(ownColor, a, b));
      }
    }

    /**
     * Strokes survive a *noise* filter; fringes do not.
     *
     * A speck and a hairline can have the same pixel count, so an area-only
     * test deletes line art: at the enhance floor (~87px² on the 1046px
     * reference artwork) a 2px-wide, 30px-long eyelid is 60px² and vanishes.
     * `maxDim² / area` is ~1 for any compact blob and grows with aspect ratio,
     * so it separates the two without a magic length — but only for regions
     * that are not fringes, or the exemption would preserve exactly the halo
     * bands anti-aliasing exists to remove (they are long and thin too).
     */
    if (keepElongated && !fringe && (maxDims[label] * maxDims[label]) / areas[label] >= elongation) {
      continue;
    }
    // Fringe-only mode judges nothing but that: thin was checked when the
    // candidate list was built, on-the-ramp is checked here.
    if (onlyFringe && !rampBand) continue;

    /**
     * Border length says which region a speck *sits in*; it does not say which
     * one it *is*. A mid-grey chunk of an antialiased line touches the cream
     * paper along its whole length and the black stroke only at its ends, so
     * "most border" repaints it cream and punches a hole in the stroke — that
     * is what turned the reference artwork's mouth and eyelids into dashes.
     *
     * The error a merge introduces is `area × colour distance`, and the area is
     * fixed, so among the neighbours it genuinely borders (a quarter of the
     * winner's border length or more — a corner touch is not a neighbourhood)
     * the right target is the closest colour.
     */
    if (ownColor && palette) {
      const floor = bestScore * 0.25;
      let nearest = bestColor;
      let nearestDist = Infinity;
      for (let c = 0; c < 256; c++) {
        if (tally[c] < floor || c === own) continue;
        const cand = palette[c];
        if (!cand) continue;
        const d = dist(ownColor.r, ownColor.g, ownColor.b, cand);
        /**
         * A 50 %-coverage fringe pixel is equidistant from both sides by
         * construction, and then the choice decides whether a hairline survives
         * or is erased. Ties (within 15 %) go to the rarer colour: paper has
         * plenty of pixels to spare, a one-pixel stroke has none, and losing
         * the stroke destroys information the picture cannot get back.
         */
        const better =
          d < nearestDist ||
          (onlyFringe &&
            nearestDist < Infinity &&
            d <= nearestDist * FRINGE_TIE_WINDOW &&
            coverage[c] < coverage[nearest]);
        if (better) {
          nearestDist = Math.min(nearestDist, d);
          nearest = c;
        }
      }
      bestColor = nearest;
    }
    if (bestColor === own) continue;
    if (maxContrast !== Infinity && palette) {
      const a = palette[own];
      const b = palette[bestColor];
      if (a && b && dist(a.r, a.g, a.b, b) > maxContrast) continue;
    }
    for (let m = from; m < to; m++) indices[members[m]] = bestColor;
    merged++;
  }

  return merged;
}

/** Rebuild an RGBA raster from an index image + palette. */
export function indicesToRaster(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: RgbColor[],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
    const transparent = indices[p] === TRANSPARENT_INDEX;
    const c = palette[indices[p]] ?? palette[0];
    data[i] = c.r;
    data[i + 1] = c.g;
    data[i + 2] = c.b;
    data[i + 3] = transparent ? 0 : 255;
  }
  return { width, height, data };
}

/**
 * Clamp a caller-supplied palette override and drop malformed entries,
 * **keeping duplicates**.
 *
 * Duplicates are meaningful: two slots naming the same colour is how the
 * palette editor expresses "merge slot A into slot B" (see `vectorize`). The
 * length of the returned array is therefore the number of colour *slots* the
 * quantizer should cluster into, which is not necessarily the number of
 * distinct colours that end up in the SVG.
 */
export function normalizePalette(palette: RgbColor[] | null | undefined): RgbColor[] | null {
  if (!palette || palette.length === 0) return null;
  const out: RgbColor[] = [];
  for (const c of palette) {
    if (!c || typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') continue;
    if (!Number.isFinite(c.r) || !Number.isFinite(c.g) || !Number.isFinite(c.b)) continue;
    out.push({ r: clamp255(c.r), g: clamp255(c.g), b: clamp255(c.b) });
    if (out.length >= 64) break;
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Preset colour transforms (REFERENCE B2)
// ---------------------------------------------------------------------------

/** Rec. 601 grayscale — the Sketch preset's colour space. */
export function toGrayscale(image: RasterImage): RasterImage {
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const y = clamp255(
      0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2],
    );
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

/** Luminance threshold to pure black/white — the Drawing preset (REFERENCE B2). */
export function toBlackAndWhite(image: RasterImage, threshold: number): RasterImage {
  const t = Math.max(0, Math.min(255, threshold));
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const y = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
    const v = y >= t ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

// ---------------------------------------------------------------------------
// Output colour groups (REFERENCE B3)
// ---------------------------------------------------------------------------

/**
 * Collapse palette entries that sit within `thresholdPercent` of each other.
 *
 * Distance is L1 over RGB as a percentage of the maximum (765), so 5 % — the
 * reference product's default step — merges colours under ~38 units apart:
 * the near-duplicates a soft edge or a gradient leaves behind, not the artwork.
 *
 * Returns the surviving palette plus the index remap, and rewrites `indices`.
 *
 * **The survivor is re-centred on what it ends up painting.** The obvious
 * implementation — walk the palette in coverage order, map each entry onto the
 * first kept entry within the window, keep that entry's colour — makes the fold
 * a *winner-takes-all* over histogram peaks, and on soft-shaded artwork that is
 * how a face gets painted the wrong colour. On the shaded gold standard the
 * cream ramp across the character's face arrives here as four modes —
 * rgb(240,228,217), rgb(224,212,201), rgb(210,198,187), rgb(198,186,179) — and
 * whichever of them happens to cover the most of the *whole image* swallows its
 * neighbours and repaints them with its own colour. The winner was the darkest:
 * a band whose pixels average rgb(210,198,188) came back rgb(197,186,179), 13
 * units too dark across 44 % of the face, which is exactly the muddy grey a
 * person names ("why is his face dirty") and which no other instrument in this
 * repo could see — the outline is fine, the leak is 0 %, the wobble is under the
 * exemplar's, and the mean colour error of a 13-unit miss over half a crop is
 * inside every bar.
 *
 * So the grouping decision is made on the *original* colours — unchanged, so
 * this cannot fold differently than it did, and the colour COUNT it returns is
 * the same one every existing gate was measured against — and only then is each
 * survivor moved to the coverage-weighted mean of the group it absorbed. A fold
 * that absorbs nothing does not move at all; a fold that absorbs a neighbour
 * lands between them in proportion to how much of the picture each one is, which
 * is the colour a person would have picked for the region they now share.
 */
export function mergeSimilarColors(
  indices: Uint8Array,
  palette: RgbColor[],
  thresholdPercent: number,
): { palette: RgbColor[]; map: Uint8Array } {
  const map = new Uint8Array(Math.max(1, palette.length));
  const limit = (Math.max(0, thresholdPercent) / 100) * 765;
  if (limit <= 0 || palette.length < 2) {
    for (let i = 0; i < palette.length; i++) map[i] = i;
    return { palette: palette.map((c) => ({ ...c })), map };
  }
  const kept: RgbColor[] = [];
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    let target = -1;
    for (let j = 0; j < kept.length; j++) {
      if (dist(c.r, c.g, c.b, kept[j]) <= limit) {
        target = j;
        break;
      }
    }
    if (target < 0) {
      target = kept.length;
      kept.push({ ...c });
    }
    map[i] = target;
  }
  // Re-centre: each survivor becomes the coverage-weighted mean of its group.
  // Computed BEFORE `remapIndices`, because after it the per-slot coverage is
  // the group's and the members are gone.
  {
    const coverage = coverageOf(indices, palette.length);
    const sumR = new Float64Array(kept.length);
    const sumG = new Float64Array(kept.length);
    const sumB = new Float64Array(kept.length);
    const sumN = new Float64Array(kept.length);
    for (let i = 0; i < palette.length; i++) {
      const w = coverage[i];
      if (!w) continue;
      const g = map[i];
      sumR[g] += palette[i].r * w;
      sumG[g] += palette[i].g * w;
      sumB[g] += palette[i].b * w;
      sumN[g] += w;
    }
    for (let g = 0; g < kept.length; g++) {
      // A group no pixel uses keeps the colour it came in with: there is nothing
      // to take a mean of, and inventing one would put a colour in the palette
      // that names no region.
      if (sumN[g] === 0) continue;
      kept[g] = {
        r: clamp255(sumR[g] / sumN[g]),
        g: clamp255(sumG[g] / sumN[g]),
        b: clamp255(sumB[g] / sumN[g]),
      };
    }
  }
  remapIndices(indices, map);
  return { palette: kept, map };
}

/**
 * Merge colour groups that cover less than `thresholdPercent` of the image into
 * the nearest surviving colour — the reference product's output-colour-groups
 * "merge threshold" (its default step is 5 %).
 *
 * Coverage, not colour distance, is the useful reading of that control: the
 * groups panel draws each output colour as a circle sized by its area, and the
 * threshold sits next to it. What a user wants from it is "stop giving a whole
 * layer to a colour that barely appears" — a slice of quantization debris that
 * costs a layer, a legend entry and a print run. Colour-distance merging is a
 * different job and lives in `mergeSimilarColors`.
 *
 * Rewrites `indices` and returns the surviving palette.
 */
export function mergeSmallGroups(
  indices: Uint8Array,
  palette: RgbColor[],
  thresholdPercent: number,
): RgbColor[] {
  if (thresholdPercent <= 0 || palette.length < 2) return palette.map((c) => ({ ...c }));
  const coverage = coverageOf(indices, palette.length);
  // Fraction of the *drawn* area, not of the canvas: on a sticker two thirds of
  // the frame can be see-through, and a colour should not be judged small
  // because most of the picture is a hole.
  let drawn = 0;
  for (let i = 0; i < coverage.length; i++) drawn += coverage[i];
  const limit = (thresholdPercent / 100) * drawn;
  const survives = palette.map((_, i) => coverage[i] >= limit);
  // Never merge everything away: the largest group always survives.
  if (!survives.some(Boolean)) {
    let biggest = 0;
    for (let i = 1; i < palette.length; i++) if (coverage[i] > coverage[biggest]) biggest = i;
    survives[biggest] = true;
  }

  const kept: RgbColor[] = [];
  const keptIndex: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (survives[i]) {
      keptIndex.push(i);
      kept.push({ ...palette[i] });
    }
  }
  if (kept.length === palette.length) return kept;

  const map = new Uint8Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    if (survives[i]) {
      map[i] = keptIndex.indexOf(i);
      continue;
    }
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < kept.length; k++) {
      const d = dist(palette[i].r, palette[i].g, palette[i].b, kept[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    map[i] = best;
  }
  remapIndices(indices, map);
  return kept;
}

/** Emission order of the colour layers (REFERENCE B3 "sort order"). */
export function sortedOrder(
  palette: RgbColor[],
  coverage: ArrayLike<number>,
  order: 'coverage' | 'brightness' | 'hue',
): number[] {
  const idx = palette.map((_, i) => i);
  if (order === 'brightness') {
    idx.sort((a, b) => lumaOf(palette[a]) - lumaOf(palette[b]) || a - b);
  } else if (order === 'hue') {
    idx.sort((a, b) => hueOf(palette[a]) - hueOf(palette[b]) || a - b);
  } else {
    idx.sort((a, b) => (coverage[b] ?? 0) - (coverage[a] ?? 0) || a - b);
  }
  return idx;
}

/** `normalizePalette` plus duplicate removal — the distinct colours of an override. */
export function sanitizePalette(palette: RgbColor[] | null | undefined): RgbColor[] | null {
  const normalized = normalizePalette(palette);
  if (!normalized) return null;
  const out: RgbColor[] = [];
  const seen = new Set<number>();
  for (const n of normalized) {
    const key = packRgb(n.r, n.g, n.b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.length ? out : null;
}
