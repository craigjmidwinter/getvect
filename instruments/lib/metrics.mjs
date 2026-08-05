/**
 * Fidelity metrics — the "light meter".
 *
 * All functions take the engine's RasterImage shape ({width,height,data:RGBA})
 * and are pure so they can be unit-checked and diffed across runs.
 */

/**
 * Mean absolute per-pixel colour error in 0..255 units, averaged over R,G,B and
 * over all pixels. This is the number REFERENCE's "under ~8/255" refers to.
 */
export function meanColorError(a, b) {
  assertSameSize(a, b);
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    sum +=
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / (n * 3);
}

/**
 * Mean absolute colour error over a subset of pixels.
 *
 * `mask` is one byte per pixel (1 = count it). Returns `null` when the mask is
 * empty, so a fixture with no masked pixels reports "not applicable" rather
 * than a flattering zero.
 */
export function maskedMeanColorError(a, b, mask) {
  assertSameSize(a, b);
  let sum = 0;
  let n = 0;
  for (let p = 0, i = 0; i < a.data.length; i += 4, p++) {
    if (!mask[p]) continue;
    sum +=
      Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    n++;
  }
  return n === 0 ? null : sum / (n * 3);
}

/** One byte per pixel, 1 where the source alpha is below `threshold`. */
export function alphaMask(image, threshold = 128) {
  const mask = new Uint8Array(image.width * image.height);
  for (let p = 0, i = 3; i < image.data.length; i += 4, p++) {
    mask[p] = image.data[i] < threshold ? 1 : 0;
  }
  return mask;
}

/** Root-mean-square colour error (0..255), reported alongside MAE for context. */
export function rmsColorError(a, b) {
  assertSameSize(a, b);
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c];
      sum += d * d;
    }
  }
  return Math.sqrt(sum / (n * 3));
}

/** Peak signal-to-noise ratio in dB (Infinity when identical). */
export function psnr(a, b) {
  const rms = rmsColorError(a, b);
  if (rms === 0) return Infinity;
  return 20 * Math.log10(255 / rms);
}

/** Rec. 601 luma plane, Float64Array of width*height. */
export function toLuma(img) {
  const out = new Float64Array(img.width * img.height);
  for (let p = 0, i = 0; i < img.data.length; i += 4, p++) {
    out[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return out;
}

/**
 * Mean structural similarity on the luma plane.
 *
 * Windowed SSIM (Wang et al. 2004) with an 8x8 uniform window and stride 4,
 * C1=(0.01*255)^2, C2=(0.03*255)^2. Uniform windows rather than the Gaussian
 * variant: fewer knobs, same ranking behaviour, and trivially reproducible.
 * Returns 1.0 for identical images.
 */
export function ssim(a, b, { windowSize = 8, stride = 4 } = {}) {
  assertSameSize(a, b);
  const { width, height } = a;
  const la = toLuma(a);
  const lb = toLuma(b);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const w = Math.min(windowSize, width, height);
  let total = 0;
  let count = 0;

  for (let y = 0; y + w <= height; y += stride) {
    for (let x = 0; x + w <= width; x += stride) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let j = 0; j < w; j++) {
        const row = (y + j) * width + x;
        for (let i = 0; i < w; i++) {
          const va = la[row + i];
          const vb = lb[row + i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const n = w * w;
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const covAB = sumAB / n - muA * muB;
      const num = (2 * muA * muB + C1) * (2 * covAB + C2);
      const den = (muA * muA + muB * muB + C1) * (varA + varB + C2);
      total += num / den;
      count++;
    }
  }
  return count === 0 ? 1 : total / count;
}

/** Fraction of pixels whose max per-channel delta exceeds `tolerance`. */
export function pixelMismatchRatio(a, b, tolerance = 12) {
  assertSameSize(a, b);
  let bad = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > tolerance) bad++;
  }
  return bad / (a.width * a.height);
}

/**
 * Ink recall — did the *line art* survive?
 *
 * MAE and SSIM are area-weighted, so a hairline can be deleted outright and
 * barely move either: the mouth and eyelids of the 1046px reference artwork are
 * 0.3 % of its pixels. Line art is what the reference product's headline use
 * cases (logos, stickers, tattoo templates) are made of, so it gets its own
 * number: of the pixels the source draws in ink, what fraction is still ink.
 *
 * Thresholds are deliberately asymmetric. `inkLuma` picks the *cores* of dark
 * strokes (not their antialiased skirts, which a vector trace is entitled to
 * drop), `keptLuma` accepts anything still clearly darker than the paper, so a
 * stroke that got thinner or slightly greyer counts as kept and only one that
 * was erased or repainted in the background colour counts as lost.
 */
export function inkRecall(reference, traced, { inkLuma = 60, keptLuma = 128 } = {}) {
  assertSameSize(reference, traced);
  const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let ink = 0;
  let kept = 0;
  for (let i = 0; i < reference.data.length; i += 4) {
    if (luma(reference.data, i) >= inkLuma) continue;
    ink++;
    if (luma(traced.data, i) < keptLuma) kept++;
  }
  // No ink to lose: a fixture with no dark strokes passes trivially.
  return ink === 0 ? 1 : kept / ink;
}

/**
 * Strict ink recall — did the stroke survive at *stroke* darkness?
 *
 * `inkRecall` accepts anything darker than 128 as "kept", which is the right
 * question for "was this stroke erased". It is the wrong question for "is this
 * stroke still a solid stroke": a contour that a curve fit thinned below a
 * pixel renders as a grey smear at luma 90-120 and scores a perfect 1.0, and a
 * contour broken into dashes scores whatever fraction of it is still painted at
 * all. Measured loosely on the gold standard's paw the engine read 0.978
 * against the reference product's 1.000 — a 2 % gap for an outline a critic could
 * see was dashed. Measured strictly (source ink < 60 must come back < 60) the
 * same crop reads 0.946 vs 0.983, which is a gap a threshold can hold.
 */
export function strictInkRecall(reference, traced, { inkLuma = 60 } = {}) {
  return inkRecall(reference, traced, { inkLuma, keptLuma: inkLuma });
}

/**
 * Ink COVERAGE — how much of this crop is ink at all, ours over the source's.
 *
 * Every ink number above this one asks whether the source's ink came back, and
 * all of them read a *fattened* stroke as a triumph: recall 1.0, strict recall
 * 1.0, components 1.0. The mascot's nose is the case that needs the other
 * question. Its outline is a thin curve with a notch cut into it, and the trace
 * turns the right nostril into a solid black wedge — every source ink pixel is
 * present and correct, and so is twice as much ink that the source does not
 * have. `strokeWidth` sees fattening only where the source is drawing a stroke
 * (a medial-axis point whose long run is 3x its short one), which is exactly
 * what a filled-in blob stops being.
 *
 * So: the share of the crop darker than `inkLuma` in the source, the same share
 * in the trace, and the ratio. 1.0 means we spend the same amount of ink on this
 * crop as the source does; 2.0 means we doubled it. It is a ratio because the
 * absolute share belongs to the artwork, and it is deliberately blind to WHERE
 * the ink is — `inkRecall` already answers that, and the two together say "all
 * of the source's ink, and no more".
 */
export function inkCoverageProfile(reference, traced, { inkLuma = 60 } = {}) {
  assertSameSize(reference, traced);
  const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const n = reference.width * reference.height;
  let source = 0;
  let ours = 0;
  for (let i = 0; i < reference.data.length; i += 4) {
    if (luma(reference.data, i) < inkLuma) source++;
    if (luma(traced.data, i) < inkLuma) ours++;
  }
  return {
    sourceInkCoverage: n === 0 ? 0 : source / n,
    inkCoverage: n === 0 ? 0 : ours / n,
    // No ink in the crop at all: the question does not apply.
    inkCoverageRatio: source > 0 ? ours / source : null,
  };
}

/**
 * Colour leak — what fraction of a crop is painted a colour the source never
 * had *anywhere in that crop*.
 *
 * Every other fidelity number here is a distance: a cream face that gains 123
 * teal pixels moves mean colour error by hundredths, moves SSIM not at all
 * (the specks are inside a flat region, so the local variance term barely
 * blinks) and moves ink recall not at all (teal is not ink). But it is the one
 * defect a person names instantly — "why is there blue in his mouth" — and it
 * is a *categorical* error rather than a metric one: the palette slot that
 * painted it belongs to a region on the other side of the picture, and a
 * fringe/anti-aliasing pass handed an in-between pixel to a colour that is not
 * one of the two regions the fringe separates.
 *
 * So this asks a categorical question. Quantize every colour the source crop
 * contains — including its antialiased in-betweens, which are legitimately
 * there — into `bin`-sized cells; a traced pixel is FOREIGN when its nearest
 * source colour is further than `tolerance` in RGB. A trace that only ever
 * picks colours off the source's own ramp scores 0 however blurry it is; a
 * trace that invents a hue scores the area of the invention.
 *
 * Verdicts are memoized per quantized traced colour, so this stays linear in
 * pixels and quadratic only in the (small) number of distinct cells.
 *
 * The window is 32, the same one `nearDuplicateFillPairs` calls a duplicate. It
 * was 40, and 40 is wide enough to miss the defect this metric exists for: on
 * the retired exemplar the teal that painted a fifth of the lower jaw sat 40.2
 * units from the nearest colour its crop contains, so the gold-standard row
 * reported "foreign colour 0.00%" for a muzzle that visibly held it. The real
 * exemplar still scores 0 everywhere at 32, which is the check that this is a
 * tightening rather than a re-baselining.
 */
export function foreignColorRatio(reference, traced, { tolerance = 32, bin = 4 } = {}) {
  assertSameSize(reference, traced);
  const key = (r, g, b) =>
    ((Math.min(255, r) / bin) | 0) * 65536 + ((Math.min(255, g) / bin) | 0) * 256 + ((Math.min(255, b) / bin) | 0);
  const centre = (k) => [
    (((k / 65536) | 0) + 0.5) * bin,
    ((((k / 256) | 0) % 256) + 0.5) * bin,
    ((k % 256) + 0.5) * bin,
  ];

  const sourceCells = new Set();
  for (let i = 0; i < reference.data.length; i += 4) {
    sourceCells.add(key(reference.data[i], reference.data[i + 1], reference.data[i + 2]));
  }
  const sourceColors = [...sourceCells].map(centre);
  const limit = tolerance * tolerance;
  const verdict = new Map();
  let foreign = 0;
  let total = 0;
  for (let i = 0; i < traced.data.length; i += 4) {
    total++;
    const k = key(traced.data[i], traced.data[i + 1], traced.data[i + 2]);
    let isForeign = verdict.get(k);
    if (isForeign === undefined) {
      const [r, g, b] = centre(k);
      isForeign = true;
      for (const [sr, sg, sb] of sourceColors) {
        const d = (r - sr) ** 2 + (g - sg) ** 2 + (b - sb) ** 2;
        if (d <= limit) {
          isForeign = false;
          break;
        }
      }
      verdict.set(k, isForeign);
    }
    if (isForeign) foreign++;
  }
  return total === 0 ? 0 : foreign / total;
}

/**
 * Colour PRESENCE — did a specific, named colour survive into the output at all?
 *
 * `foreignColorRatio` asks the opposite question (is there a hue in here the
 * source does not have) and every other colour number in this file is a
 * distance, which is exactly why none of them can see the defect this exists
 * for: a small, hue-distinct feature losing its palette slot and being repainted
 * in its neighbour.
 *
 * Take a mascot's eyes. They are ~0.3 % of the canvas, so folding their green
 * into the surrounding cream moves whole-frame MAE by hundredths and SSIM by
 * nothing. It does not register as a foreign colour, because the repaint uses a
 * hue the crop legitimately contains. It does not register as ink, because green
 * is not ink. It does not register as a palette *shortfall*, because the slot was
 * spent — just on another cream. The only way to ask the question is to name the
 * colour and count it: of the pixels in this crop, what share is within
 * `tolerance` of rgb(...)?
 *
 * Measured identically on the source crop, on our trace and on the real
 * product's, so the number that decides anything is a RATIO — the absolute share
 * belongs to the artwork (how big are the eyes), while "we kept a third of what
 * the source has and the reference product kept all of it" belongs to the tracer.
 *
 * `tolerance` is 40 by default, wider than `foreignColorRatio`'s 32: this is a
 * survival test, not a fidelity test, and a green that came back a shade off is
 * a green that survived. A green that came back cream is 100+ units away and
 * fails at any tolerance in this range.
 */
export function colorPresence(image, color, { tolerance = 40 } = {}) {
  const limit = tolerance * tolerance;
  const n = image.width * image.height;
  let hits = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const d =
      (image.data[i] - color.r) ** 2 +
      (image.data[i + 1] - color.g) ** 2 +
      (image.data[i + 2] - color.b) ** 2;
    if (d <= limit) hits++;
  }
  return n === 0 ? 0 : hits / n;
}

/**
 * The survival question as a record: how much of the named colour the source
 * crop has, how much came back, and what fraction of it that is.
 *
 * `colorPresenceRatio` is the gate-shaped number — 1.0 means the trace painted
 * as much of that colour as the source has, 0 means the colour is gone. It is
 * capped at nothing: a trace that spreads the colour wider than the source
 * scores above 1, which is also worth seeing.
 */
export function colorPresenceProfile(reference, traced, color, opts = {}) {
  assertSameSize(reference, traced);
  const source = colorPresence(reference, color, opts);
  const ours = colorPresence(traced, color, opts);
  return {
    colorPresenceTarget: `rgb(${color.r},${color.g},${color.b})`,
    sourceColorPresence: source,
    colorPresence: ours,
    // No source pixels of that colour at all: the question does not apply, and a
    // flattering 1.0 or a damning 0 would both be inventions.
    colorPresenceRatio: source > 0 ? ours / source : null,
  };
}

/**
 * Shading-band quality — where does a soft gradient get cut, and what colour is
 * each side painted?
 *
 * Every other fidelity number in this file is about *edges* — ink recall, stroke
 * width, component counts, boundary wobble — because the artwork this repo was
 * built on is flat clipart with a black outline, where the interesting failures
 * live on the outline. Soft-shaded artwork fails somewhere else entirely: the
 * outline can be perfect while the character's face, a smooth warm gradient with
 * no edge in it at all, is quantized into two bands with a hard seam drawn
 * across the middle of it. MAE cannot see it (both bands are within a few units
 * of the source almost everywhere), SSIM cannot see it (the bands are flat and
 * so is the source), `foreignColorRatio` cannot see it (the muddy grey is a
 * colour the crop legitimately contains), and `layerWobble` sees the seam's
 * *shape* but nothing about where it was put or what colour it is.
 *
 * Both halves of the question, measured inside a crop:
 *
 *  1. **`bandFit`** — is each band the colour of what it covers? For every flat
 *     colour the trace paints in the crop, take the mean SOURCE colour over that
 *     band's own pixels and measure how far the band's fill sits from it, area-
 *     weighted across bands, in 0..255 units. A band centred on the mean of what
 *     it covers scores ~0 however coarse the banding is; a band that is 15 units
 *     darker and greyer than the region it is painted over scores 15. This is
 *     the "muddy grey where the source is warm cream" half, and it is a fair
 *     question to ask of any tracer at any colour budget.
 *  2. **`bandStep`** — how visible is the worst seam? The largest RGB distance
 *     between two bands that actually touch inside the crop (4-adjacent over at
 *     least `minBoundary` pixel pairs, so a stray speck cannot define it). Two
 *     bands 15 apart across a face read as a band; two bands 4 apart read as a
 *     gradient.
 *
 * INK IS EXCLUDED from both. A drawn outline is *supposed* to be a hard step
 * against the paper and its antialiased skirt drags any mean it is included in;
 * counting it would report the outline, every time, on every drawing, and say
 * nothing about the shading. `bandSpread` — how much source variation each band
 * swallows — is reported for context: it is a property of the artwork and the
 * colour budget, not of the tracer, and it is the honest reminder that some
 * banding is the job.
 *
 * Measured the same way on the exemplar, so the number that decides anything is
 * the ratio (`shadingBandFitRatio`), not the absolute.
 */
export function shadingBandQuality(
  reference,
  traced,
  { minShare = 0.02, inkLuma = 60, bandRadius = 12, maxAssign = 24, minBoundary = 12 } = {},
) {
  assertSameSize(reference, traced);
  const { width: w, height: h } = reference;
  const n = w * h;

  /*
   * Bands are found as PEAKS, not as exact pixel values.
   *
   * The obvious implementation — group by exact RGB, because a vector trace
   * paints flat fills — is wrong on both sides of the comparison. Our own raster
   * comes back from resvg antialiased, and an exemplar whose artwork sits inside
   * a padded viewBox is rendered at 2x, trimmed and resized (see
   * `rasterizeExemplarContent`), which leaves almost no two pixels exactly
   * equal. Grouped exactly, the reference product's face reported ONE band and a seam
   * of zero on a picture that visibly has two: the metric would have scored the
   * thing it exists to measure at zero for the reference and non-zero for us.
   *
   * So: take the heaviest colour, claim everything within `bandRadius` of it,
   * that is a band; repeat. Cheap mean-shift, and it reads a resampled flat fill
   * and a crisp one the same way.
   */
  const hist = new Map();
  for (let i = 0; i < traced.data.length; i += 4) {
    const k = (traced.data[i] << 16) | (traced.data[i + 1] << 8) | traced.data[i + 2];
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  const entries = [...hist.entries()]
    .map(([k, count]) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, count }))
    // Ties broken by colour so the band set is independent of Map order.
    .sort((a, b) => b.count - a.count || a.r - b.r || a.g - b.g || a.b - b.b);
  const claimed = new Uint8Array(entries.length);
  const radius2 = bandRadius * bandRadius;
  const bands = [];
  for (let i = 0; i < entries.length; i++) {
    if (claimed[i]) continue;
    const seed = entries[i];
    let count = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let j = i; j < entries.length; j++) {
      if (claimed[j]) continue;
      const e = entries[j];
      if ((e.r - seed.r) ** 2 + (e.g - seed.g) ** 2 + (e.b - seed.b) ** 2 > radius2) continue;
      claimed[j] = 1;
      count += e.count;
      sr += e.r * e.count;
      sg += e.g * e.count;
      sb += e.b * e.count;
    }
    bands.push({ r: sr / count, g: sg / count, b: sb / count, share: count / n });
  }

  /*
   * Ink is excluded, and so are the transition pixels between bands.
   *
   * A drawn outline is SUPPOSED to be a hard step against the paper, and its
   * antialiased skirt drags any mean it lands in. Counting it would report the
   * outline on every drawing and say nothing about the shading. `maxAssign`
   * drops the in-between pixels for the same reason: a pixel halfway between two
   * bands belongs to neither, and charging it to the nearer one measures the
   * rasterizer.
   */
  const kept = bands.filter(
    (b) => b.share >= minShare && 0.299 * b.r + 0.587 * b.g + 0.114 * b.b >= inkLuma,
  );
  if (kept.length === 0) return null;
  for (const b of kept) {
    b.count = 0;
    b.sr = 0;
    b.sg = 0;
    b.sb = 0;
  }

  const owner = new Int32Array(n).fill(-1);
  const assignLimit = maxAssign * maxAssign;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = traced.data[i];
    const g = traced.data[i + 1];
    const b = traced.data[i + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b < inkLuma) continue;
    let best = -1;
    let bestD = assignLimit;
    for (let k = 0; k < kept.length; k++) {
      const c = kept[k];
      const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0) continue;
    owner[p] = best;
    const band = kept[best];
    band.count++;
    band.sr += reference.data[i];
    band.sg += reference.data[i + 1];
    band.sb += reference.data[i + 2];
  }

  // 1. bandFit — is each band the colour of what it covers?
  let area = 0;
  for (const b of kept) {
    if (b.count === 0) continue;
    b.meanSource = { r: b.sr / b.count, g: b.sg / b.count, b: b.sb / b.count };
    b.fit =
      (Math.abs(b.r - b.meanSource.r) +
        Math.abs(b.g - b.meanSource.g) +
        Math.abs(b.b - b.meanSource.b)) /
      3;
    area += b.count;
  }
  const live = kept.filter((b) => b.count > 0);
  if (!live.length || area === 0) return null;
  const fit = live.reduce((s, b) => s + b.fit * b.count, 0) / area;

  // 2. bandSpread — how much source variation each band swallows. A property of
  //    the artwork and the colour budget, not of the tracer: context, not a bar.
  let spread = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const id = owner[p];
    if (id < 0 || !kept[id].meanSource) continue;
    const m = kept[id].meanSource;
    spread +=
      (Math.abs(reference.data[i] - m.r) +
        Math.abs(reference.data[i + 1] - m.g) +
        Math.abs(reference.data[i + 2] - m.b)) /
      3;
  }
  spread /= area;

  // 3. bandStep — the biggest step between two bands that actually touch, over
  //    at least `minBoundary` adjacent pixel pairs so a speck cannot define it.
  const touch = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = owner[p];
      if (a < 0) continue;
      for (const q of [x + 1 < w ? p + 1 : -1, y + 1 < h ? p + w : -1]) {
        if (q < 0) continue;
        const b = owner[q];
        if (b < 0 || b === a) continue;
        const k = a < b ? a * kept.length + b : b * kept.length + a;
        touch.set(k, (touch.get(k) ?? 0) + 1);
      }
    }
  }
  let step = 0;
  let excess = 0;
  let stepPair = null;
  let excessPair = null;
  for (const [k, len] of touch) {
    if (len < minBoundary) continue;
    const a = kept[Math.floor(k / kept.length)];
    const b = kept[k % kept.length];
    if (!a.meanSource || !b.meanSource) continue;
    const d = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
    /*
     * ...and how much of that step the SOURCE does not have.
     *
     * A crop big enough to hold a face also holds real colour edges — the ear
     * behind it, the outline, a blue against a cream — and those steps are
     * enormous and correct. `bandStep` alone therefore reports the largest
     * legitimate edge in the crop and never the seam: on the shaded gold
     * standard's face box the biggest step is 69 units between two blues in the
     * ear, while the seam this metric exists for sits at 59. Subtracting the
     * distance between the two bands' own mean source colours leaves what we
     * INVENTED: the ear's blues are as far apart in the source as we paint them
     * (excess ~0), while a seam drawn across a soft ramp paints a 59-unit step
     * where the source has 30 (excess ~29). Zero is what a faithful trace of
     * flat art scores on every pair.
     */
    const sd = Math.sqrt(
      (a.meanSource.r - b.meanSource.r) ** 2 +
        (a.meanSource.g - b.meanSource.g) ** 2 +
        (a.meanSource.b - b.meanSource.b) ** 2,
    );
    const pair = [
      `rgb(${Math.round(a.r)},${Math.round(a.g)},${Math.round(a.b)})`,
      `rgb(${Math.round(b.r)},${Math.round(b.g)},${Math.round(b.b)})`,
      len,
    ];
    if (d > step) {
      step = d;
      stepPair = pair;
    }
    if (d - sd > excess) {
      excess = d - sd;
      excessPair = pair;
    }
  }

  return {
    bandCount: live.length,
    bandFit: fit,
    bandSpread: spread,
    bandStep: step,
    bandStepPair: stepPair,
    bandStepExcess: excess,
    bandStepExcessPair: excessPair,
    bandCoverage: area / n,
  };
}

/** One byte per pixel, 1 where luma is below `inkLuma` — the ink field. */
export function inkMask(image, inkLuma = 60) {
  const mask = new Uint8Array(image.width * image.height);
  for (let p = 0, i = 0; i < image.data.length; i += 4, p++) {
    const luma = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
    mask[p] = luma < inkLuma ? 1 : 0;
  }
  return mask;
}

/**
 * Stroke-width uniformity: is our line of even weight where the source's line is?
 *
 * The one thing that decided REFERENCE's blind A/B and that no other instrument
 * here could see. Measured on the gold standard's lower jaw, the source stroke
 * is 3.94px mean (cv 0.33), the reference product's is 5.69px (cv 0.20) and ours was
 * 6.93px (cv 0.28) — a 1.76x fattening against the exemplar's 1.44x, with an
 * upper mouth arc that tapered to a spindle and detached from both fangs. Every
 * ink metric in this file read that as *better* than the reference product:
 * `strictInkRecall` scored us 0.967 against its 0.755 and `inkComponentRatio`
 * 0.43x, because a fatter line recalls more ink and joins more components.
 * Recall answers "is the stroke still there"; this answers "is it still a
 * stroke".
 *
 * Method — local width on the source's own medial axis:
 *
 *  1. Take every source pixel that is ink and sits at the CENTRE of its own
 *     shorter run (horizontal or vertical, within a pixel). That is a cheap
 *     medial axis, and it puts one sample on each stroke rather than one per
 *     ink pixel, so a thick blob cannot outvote a hairline.
 *  2. At each of those points measure the traced image's own local width — the
 *     shorter of its horizontal and vertical runs through that point, and 0
 *     where the trace has no ink there at all, because a line that vanishes for
 *     a stretch is not of even weight.
 *  3. Report mean, its ratio to the source's, and the coefficient of variation.
 *
 * Both sides are measured the same way, so the number that gates is the RATIO
 * of our cv to the exemplar's: the absolute cv belongs to the artwork (a drawn
 * line genuinely varies), the ratio belongs to the tracer.
 *
 * `inkLuma` is 100 rather than the 60 the recall metrics use on purpose — this
 * is a question about geometry, not about darkness, and the edge of a black
 * stroke on cream paper crosses 100 about where a person would say the stroke
 * ends.
 */
const STROKE_ELONGATION = 3;

export function strokeWidthProfile(reference, traced, { inkLuma = 100 } = {}) {
  assertSameSize(reference, traced);
  const { width: w, height: h } = reference;
  const field = (img) => {
    const m = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < m.length; p++, i += 4) {
      const d = img.data;
      // A transparent pixel is not ink, however dark its RGB bytes read.
      if (d[i + 3] < 128) continue;
      m[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < inkLuma ? 1 : 0;
    }
    return m;
  };
  const refInk = field(reference);
  const outInk = field(traced);

  /** Maximal run of ink through (x,y) along ±(dx,dy): its length, and how much of it lies before the point. */
  const run = (mask, x, y, dx, dy) => {
    if (!mask[y * w + x]) return { len: 0, before: 0 };
    let before = 0;
    for (let i = 1; ; i++) {
      const nx = x - dx * i;
      const ny = y - dy * i;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) break;
      before++;
    }
    let after = 0;
    for (let i = 1; ; i++) {
      const nx = x + dx * i;
      const ny = y + dy * i;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) break;
      after++;
    }
    return { len: before + after + 1, before };
  };

  const samples = [];
  let sourceTotal = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!refInk[y * w + x]) continue;
      const hr = run(refInk, x, y, 1, 0);
      const vr = run(refInk, x, y, 0, 1);
      const across = hr.len <= vr.len ? hr : vr;
      const along = hr.len <= vr.len ? vr : hr;
      // Centre of the shorter run, within a pixel: the medial axis.
      if (Math.abs(across.before - (across.len - 1 - across.before)) > 1) continue;
      // ...and only where the source is drawing a STROKE. Inside a filled
      // region every interior pixel is on some medial axis and its "width" is
      // the region, so a crop containing one eye outvotes every line in it: the
      // gold standard's face box scored a 12.95px mean width and a cv of 1.0
      // for both products, which is a measurement of the eye. A stroke is
      // longer than it is wide; `STROKE_ELONGATION` is where that starts.
      if (along.len < across.len * STROKE_ELONGATION) continue;
      const ow = outInk[y * w + x]
        ? Math.min(run(outInk, x, y, 1, 0).len, run(outInk, x, y, 0, 1).len)
        : 0;
      samples.push(ow);
      sourceTotal += across.len;
    }
  }
  if (samples.length < 8) return null;
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sourceMean = sourceTotal / n;
  return {
    samples: n,
    strokeWidth: mean,
    sourceStrokeWidth: sourceMean,
    strokeWidthRatio: sourceMean > 0 ? mean / sourceMean : null,
    strokeWidthCv: mean > 0 ? Math.sqrt(variance) / mean : null,
  };
}

/**
 * Number of 8-connected components in an image's ink field, ignoring
 * components smaller than `minPixels` (isolated antialiasing crumbs are not
 * strokes and neither product should be judged on them).
 */
export function inkComponents(image, { inkLuma = 60, minPixels = 4 } = {}) {
  const { width, height } = image;
  const mask = inkMask(image, inkLuma);
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let components = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || seen[p]) continue;
    let top = 0;
    stack[top++] = p;
    seen[p] = 1;
    let size = 0;
    while (top > 0) {
      const q = stack[--top];
      size++;
      const qx = q % width;
      const qy = (q - qx) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = qy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack[top++] = n;
          }
        }
      }
    }
    if (size >= minPixels) components++;
  }
  return components;
}

/**
 * Light pixels that are ENCLOSED — the interior of a small drawn feature.
 *
 * The count of these is what says a row of outlined spikes is still a row of
 * outlined spikes. Weld two outlines together and their two interiors become one
 * (or none), while every other instrument in this file reports health: all the
 * ink is still ink (`inkRecall` ~1), the colours are right, the sub-path count
 * moves by one. A person looking at the picture names it immediately.
 *
 * Components touching the border are dropped, because that is the paper the
 * features sit ON, not a feature. `minPixels` drops antialiasing crumbs.
 */
export function enclosedLightComponents(image, { lightLuma = 200, minPixels = 6 } = {}) {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    mask[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] >= lightLuma ? 1 : 0;
  }
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let components = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || seen[p]) continue;
    let top = 0;
    stack[top++] = p;
    seen[p] = 1;
    let size = 0;
    let touchesBorder = false;
    while (top > 0) {
      const q = stack[--top];
      size++;
      const qx = q % width;
      const qy = (q - qx) / width;
      if (qx === 0 || qy === 0 || qx === width - 1 || qy === height - 1) touchesBorder = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = qy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack[top++] = n;
          }
        }
      }
    }
    if (size >= minPixels && !touchesBorder) components++;
  }
  return components;
}

/**
 * Did the small sharp features survive? Enclosed light components in the trace
 * over the same count in the source.
 *
 * 1.0 means every one of them came back as its own region. Below 1 means
 * features merged or vanished — the ink-fusion defect, in one number. Above 1
 * means the trace invented one, which is also worth seeing.
 */
export function sharpFeatureSurvival(reference, traced, opts = {}) {
  assertSameSize(reference, traced);
  const source = enclosedLightComponents(reference, opts);
  const ours = enclosedLightComponents(traced, opts);
  return {
    featureComponents: ours,
    sourceFeatureComponents: source,
    featureComponentRatio: source === 0 ? null : ours / source,
  };
}

/**
 * Invented seams: light pixels the source does not have, on a boundary between
 * two traced layers.
 *
 * Where two layers abut, each is rasterized against whatever is *under* it, so a
 * shared edge is composited twice and neither pass covers it fully — the backdrop
 * shows through as a sliver a fraction of a pixel wide. Against ink it reads as a
 * white hairline drawn along an outline, which is the single most visible defect
 * a tracer can ship and the one every averaging metric ignores: 900 such pixels
 * on a megapixel drawing move MAE by 0.1.
 *
 * The test is deliberately two-sided, so it cannot fire on a real light line the
 * artwork has:
 *
 *   - the pixel is lighter than BOTH of its opposite neighbours, in every
 *     channel, by more than `lighterBy` (a ridge, on either axis), and
 *   - nothing that light exists anywhere in the source's own neighbourhood of
 *     the same pixel (`window`), so the drawing never had it.
 *
 * A genuine highlight fails the second test; a ridge that is only one side of a
 * gradient fails the first.
 */
export function seamSlivers(reference, traced, { lighterBy = 12, window = 1 } = {}) {
  assertSameSize(reference, traced);
  const { width, height, data } = traced;
  const ref = reference.data;
  const lighter = (i, j) =>
    data[i] - data[j] > lighterBy &&
    data[i + 1] - data[j + 1] > lighterBy &&
    data[i + 2] - data[j + 2] > lighterBy;
  let slivers = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const i = p * 4;
      const ridge =
        (lighter(i, (p - 1) * 4) && lighter(i, (p + 1) * 4)) ||
        (lighter(i, (p - width) * 4) && lighter(i, (p + width) * 4));
      if (!ridge) continue;
      // ...and the source has nothing that light anywhere near it.
      let present = false;
      for (let dy = -window; dy <= window && !present; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -window; dx <= window; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const r = (ny * width + nx) * 4;
          if (
            ref[r] >= data[i] - lighterBy &&
            ref[r + 1] >= data[i + 1] - lighterBy &&
            ref[r + 2] >= data[i + 2] - lighterBy
          ) {
            present = true;
            break;
          }
        }
      }
      if (!present) slivers++;
    }
  }
  return { sliverPixels: slivers, sliverRatio: slivers / (width * height) };
}

/**
 * Continuity, as one number: components in the trace's ink field over
 * components in the source's.
 *
 * A continuous outline traced continuously scores ~1. An outline broken into
 * dashes multiplies its own component count while `inkRecall` barely moves,
 * because every dash is still ink and the gaps are a rounding error in area.
 * This is what "the strokes are interrupted" looks like to an instrument.
 * Returns null when the source region has no ink to count.
 */
export function inkComponentRatio(reference, traced, opts = {}) {
  assertSameSize(reference, traced);
  const ref = inkComponents(reference, opts);
  if (ref === 0) return null;
  return inkComponents(traced, opts) / ref;
}

/**
 * Crop a RasterImage to `{ x, y, width, height }`, clamped to the image.
 *
 * Whole-frame scores are area-weighted, so a region that is 8 % of the canvas
 * but carries all of the meaning — a character's face — can be destroyed while
 * MAE, SSIM and even whole-image `inkRecall` stay inside their bars. That is
 * exactly how the gold-standard A/B was lost with every gate green: the mouth
 * came back as a smear of blobs and the fangs disappeared while `inkRecall`
 * read 0.9421 against a 0.94 floor. A fixture can now name a `salientRegion`
 * and get every fidelity number recomputed inside it.
 */
export function cropRegion(image, { x, y, width, height }) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const w = Math.max(1, Math.min(image.width - x0, Math.round(width)));
  const h = Math.max(1, Math.min(image.height - y0, Math.round(height)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y0 + row) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/** Count of `<path` elements in an SVG string (REFERENCE "Economy"). */
export function countPaths(svg) {
  return (svg.match(/<path\b/g) ?? []).length;
}

/** Every drawable element, not just paths — catches tracers that emit <rect>/<polygon>. */
export function countShapes(svg) {
  return (svg.match(/<(path|rect|circle|ellipse|polygon|polyline|line)\b/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Sub-path geometry
//
// `pathCount` is NOT a shape count: a tracer is free to emit one compound
// `<path>` per colour layer, in which case every speck is a sub-path (`M`/`m`)
// inside a single element and the "<= 200 paths" bar is met by definition
// rather than by economy. These helpers count what the eye actually sees.
// ---------------------------------------------------------------------------

/** Every `d="..."` attribute in the document, in order. */
export function pathDataAttributes(svg) {
  return [...svg.matchAll(/\sd="([^"]*)"/g)].map((m) => m[1]);
}

const ARG_COUNT = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Parse one path-data string into sub-path bounding boxes.
 *
 * Returns `[{ x0, y0, x1, y1, width, height, commands }]`, one entry per
 * `M`/`m`. Handles absolute and relative forms, implicit lineto repeats after a
 * moveto, and arcs (the endpoint only — good enough for an extent estimate).
 */
export function subPathBoxes(d) {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const boxes = [];
  let box = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  let i = 0;

  const extend = (x, y) => {
    if (!box) return;
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  };

  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const token = tokens[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(token)) {
      cmd = token;
      i++;
    } else if (cmd == null) {
      i++; // stray number before any command
      continue;
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }

    const lower = cmd.toLowerCase();
    const relative = cmd === lower;
    const need = ARG_COUNT[lower];
    if (need > 0 && i + need > tokens.length) break;

    if (lower === 'z') {
      cx = sx;
      cy = sy;
      if (box) box.commands++;
      continue;
    }

    if (lower === 'm') {
      const x = num();
      const y = num();
      cx = relative ? cx + x : x;
      cy = relative ? cy + y : y;
      sx = cx;
      sy = cy;
      box = { x0: cx, y0: cy, x1: cx, y1: cy, commands: 0 };
      boxes.push(box);
      continue;
    }

    if (box) box.commands++;

    if (lower === 'h') {
      const x = num();
      cx = relative ? cx + x : x;
    } else if (lower === 'v') {
      const y = num();
      cy = relative ? cy + y : y;
    } else if (lower === 'a') {
      num(); num(); num(); num(); num();
      const x = num();
      const y = num();
      cx = relative ? cx + x : x;
      cy = relative ? cy + y : y;
    } else {
      // l/c/s/q/t — every pair is a point; only the last pair is the endpoint,
      // but control points are inside the ink's influence so they count too.
      for (let k = 0; k < need; k += 2) {
        const x = num();
        const y = num();
        const ax = relative ? cx + x : x;
        const ay = relative ? cy + y : y;
        extend(ax, ay);
        if (k + 2 === need) {
          cx = ax;
          cy = ay;
        }
      }
      extend(cx, cy);
      continue;
    }
    extend(cx, cy);
  }

  return boxes.map((b) => ({ ...b, width: b.x1 - b.x0, height: b.y1 - b.y0 }));
}

/** Total sub-paths (`M`/`m` starts) across every `<path d>` in the document. */
export function countSubPaths(svg) {
  let total = 0;
  for (const d of pathDataAttributes(svg)) total += (d.match(/[Mm]/g) ?? []).length;
  return total;
}

/**
 * Fraction of sub-paths whose bounding box fits inside `maxExtent` pixels in
 * both axes — i.e. single-pixel specks that survived despeckle / Minimum Area.
 */
export function tinySubPathRatio(svg, maxExtent = 1.5) {
  let total = 0;
  let tiny = 0;
  for (const d of pathDataAttributes(svg)) {
    for (const b of subPathBoxes(d)) {
      total++;
      if (b.width <= maxExtent && b.height <= maxExtent) tiny++;
    }
  }
  return total === 0 ? 0 : tiny / total;
}

/**
 * Share of drawing commands that are curves rather than straight segments:
 * `[CcSsQqTtAa] / ([CcSsQqTtAa] + [LlHhVv])`.
 *
 * REFERENCE demands "smooth curve-fitted outlines (no pixel staircase)". A
 * tracer that emits runs of `h1v1` is a staircase however small the file is,
 * and this number is how you see that without opening the PNG. The real
 * product's exemplar scores ~0.64; a pure polyline tracer scores 0.
 */
export function curveCommandRatio(svg) {
  let curves = 0;
  let lines = 0;
  for (const d of pathDataAttributes(svg)) {
    curves += (d.match(/[CcSsQqTtAa]/g) ?? []).length;
    lines += (d.match(/[LlHhVv]/g) ?? []).length;
  }
  const total = curves + lines;
  return total === 0 ? 0 : curves / total;
}

/** Count of cubic Bézier commands (`C`/`c`/`S`/`s`) — the exemplar's segment type. */
export function countCubics(svg) {
  let n = 0;
  for (const d of pathDataAttributes(svg)) n += (d.match(/[CcSs]/g) ?? []).length;
  return n;
}

// ---------------------------------------------------------------------------
// Colour-layer structure
// ---------------------------------------------------------------------------

/** Parse `#rrggbb`, `#rgb` or `rgb(r,g,b)` into {r,g,b}; null if unparseable. */
export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'none') return null;
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [a, b, c] = m[1].split('');
    return { r: parseInt(a + a, 16), g: parseInt(b + b, 16), b: parseInt(c + c, 16) };
  }
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  return null;
}

/**
 * The `<g fill="...">` colour layers, in document order. Accepts both the hex
 * form and the `rgb(r,g,b)` form REFERENCE D1 documents, so the metric does not
 * change meaning when the writer switches notation.
 */
export function layerFills(svg) {
  return [...svg.matchAll(/<g[^>]*\bfill="([^"]+)"/g)]
    .map((m) => parseColor(m[1]))
    .filter(Boolean);
}

/**
 * Flatten one path-data string into polylines, one per sub-path.
 *
 * Curves are sampled (`samples` points per cubic/quadratic) so a fitted
 * boundary and a staircase of `l` segments are measured on the same footing —
 * otherwise a curve would count as one "edge" however far it travels.
 * Arcs contribute their endpoint only, which is what `subPathBoxes` does too.
 */
export function subPathPolylines(d, options = 8) {
  /**
   * `samples` per curve, or — with `{ step }` — a sample every `step` user
   * units of control-polygon length.
   *
   * A fixed count is the right thing for every metric that compares a curve
   * with a staircase, and the wrong thing for anything that measures how far a
   * curve sits from a smooth reference: eight samples across a 200px cubic put
   * the chords 25px apart, and the sagitta of those chords is a *sampling*
   * error of a whole pixel that lands in the answer as if the geometry had
   * wobbled. Measured that way the reference product's own arcs scored 7× our
   * high-frequency energy on a picture where they are visibly smoother.
   */
  const samples = typeof options === 'number' ? options : (options.samples ?? 8);
  const step = typeof options === 'number' ? 0 : (options.step ?? 0);
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const polys = [];
  let poly = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const push = (x, y) => {
    if (poly) poly.push([x, y]);
  };
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    let n = samples;
    if (step > 0) {
      const hull =
        Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      n = Math.max(2, Math.min(8192, Math.ceil(hull / step)));
    }
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const u = 1 - t;
      push(
        u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
      );
    }
    cx = x3;
    cy = y3;
  };

  while (i < tokens.length) {
    const token = tokens[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(token)) {
      cmd = token;
      i++;
    } else if (cmd == null) {
      i++;
      continue;
    } else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';

    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    const need = ARG_COUNT[lower];
    if (need > 0 && i + need > tokens.length) break;

    if (lower === 'z') {
      cx = sx;
      cy = sy;
      push(cx, cy);
      continue;
    }
    if (lower === 'm') {
      const x = num();
      const y = num();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      sx = cx;
      sy = cy;
      poly = [[cx, cy]];
      polys.push(poly);
      continue;
    }
    if (lower === 'h') {
      const x = num();
      cx = rel ? cx + x : x;
      push(cx, cy);
    } else if (lower === 'v') {
      const y = num();
      cy = rel ? cy + y : y;
      push(cx, cy);
    } else if (lower === 'l' || lower === 't') {
      const x = num();
      const y = num();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      push(cx, cy);
    } else if (lower === 'c' || lower === 's' || lower === 'q') {
      const pts = [];
      for (let k = 0; k < need; k += 2) {
        const x = num();
        const y = num();
        pts.push([rel ? cx + x : x, rel ? cy + y : y]);
      }
      // s/q carry fewer control points than a cubic; reuse the start point for
      // the missing one. The sampling only has to be consistent, not exact.
      const [p1, p2, p3] = pts.length === 3 ? pts : [[cx, cy], pts[0], pts[1]];
      cubic(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    } else if (lower === 'a') {
      num(); num(); num(); num(); num();
      const x = num();
      const y = num();
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      push(cx, cy);
    }
  }
  return polys.filter((p) => p.length > 1);
}

/** Absolute shoelace area and total edge length of a polyline. */
function polylineAreaPerimeter(points) {
  let area = 0;
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
    perimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  return { area: Math.abs(area) / 2, perimeter };
}

/**
 * Per-`<g fill>` layer geometry: area, perimeter and **compactness**
 * `perimeter / (2 * sqrt(pi * area))` — 1.0 for a circle, higher the more
 * ragged the boundary.
 *
 * Why this exists: a quantization boundary that sawtooths through a shaded
 * region costs nothing in MAE (both sides of the seam are nearly the right
 * colour), nothing in ink recall (no ink involved) and nothing in sub-path
 * count (it is one big region either way) — and it is the single most visible
 * difference between "clipart" and "posterized photo". Measured on the gold
 * standard, our mid-tone layers score 5.65 / 5.36 against the reference product's
 * 4.35 / 2.87 for the equivalent cream and blue.
 *
 * Computed from the path data rather than by rasterizing each layer alone, so
 * it stays pure, deterministic and fast. Layers are split at every
 * `<g … fill="…">` start: the exemplar nests a plain `<g>` inside each fill
 * group, so matching to the next `</g>` would truncate every layer.
 */
export function fillLayerChunks(svg) {
  const starts = [...svg.matchAll(/<g\b[^>]*\bfill="([^"]+)"[^>]*>/g)];
  return starts.map((start, i) => ({
    fill: start[1],
    body: svg.slice(
      start.index + start[0].length,
      i + 1 < starts.length ? starts[i + 1].index : svg.length,
    ),
  }));
}

export function layerGeometry(svg, { curveSamples = 8 } = {}) {
  const starts = fillLayerChunks(svg);
  const layers = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = starts[i].body;
    let area = 0;
    let perimeter = 0;
    let box = null;
    const extend = (x0, y0, x1, y1) => {
      box = box
        ? [Math.min(box[0], x0), Math.min(box[1], y0), Math.max(box[2], x1), Math.max(box[3], y1)]
        : [x0, y0, x1, y1];
    };
    for (const d of pathDataAttributes(chunk)) {
      for (const poly of subPathPolylines(d, curveSamples)) {
        const m = polylineAreaPerimeter(poly);
        area += m.area;
        perimeter += m.perimeter;
        let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of poly) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        extend(minX, minY, maxX, maxY);
      }
    }
    // <rect> and <circle> primitives the writer may emit alongside paths.
    for (const m of chunk.matchAll(/<rect\b([^>]*)>/g)) {
      const w = Number(/\bwidth="([\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const h = Number(/\bheight="([\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const x = Number(/\bx="([-\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const y = Number(/\by="([-\d.]+)"/.exec(m[1])?.[1] ?? 0);
      area += w * h;
      perimeter += 2 * (w + h);
      extend(x, y, x + w, y + h);
    }
    for (const m of chunk.matchAll(/<circle\b([^>]*)>/g)) {
      const r = Number(/\br="([\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const cx = Number(/\bcx="([-\d.]+)"/.exec(m[1])?.[1] ?? 0);
      const cy = Number(/\bcy="([-\d.]+)"/.exec(m[1])?.[1] ?? 0);
      area += Math.PI * r * r;
      perimeter += 2 * Math.PI * r;
      extend(cx - r, cy - r, cx + r, cy + r);
    }
    layers.push({
      fill: starts[i].fill,
      color: parseColor(starts[i].fill),
      area,
      perimeter,
      box,
      compactness: area > 0 ? perimeter / (2 * Math.sqrt(Math.PI * area)) : null,
    });
  }
  return layers;
}

/**
 * Mean compactness over the layers that carry the picture.
 *
 * `minCoverage` is a share of the **drawing's bounding box**, not of the
 * declared viewBox. A reference-product capture may draw inside a corner of a padded
 * viewBox (the retired exemplar used the top-left quarter of an 11520x9280
 * box), and viewBox-relative coverage would then drop every one of its layers
 * under the bar and the exemplar side of the comparison would measure nothing.
 * It also matters for a sticker: `fox-sticker-clipart-8colors-smartAA.svg` fills
 * its viewBox honestly, but the artwork inside it is a fox on a transparent
 * field, so the layers are small against the frame and large against the
 * drawing.
 */
export function layerCompactness(svg, { minCoverage = 0.01, curveSamples = 8 } = {}) {
  const layers = layerGeometry(svg, { curveSamples });
  let box = null;
  for (const l of layers) {
    if (!l.box) continue;
    box = box
      ? [
          Math.min(box[0], l.box[0]),
          Math.min(box[1], l.box[1]),
          Math.max(box[2], l.box[2]),
          Math.max(box[3], l.box[3]),
        ]
      : l.box;
  }
  const canvas = box ? Math.max(1, (box[2] - box[0]) * (box[3] - box[1])) : 1;
  const counted = layers.filter((l) => l.compactness != null && l.area / canvas >= minCoverage);
  const mean = counted.length
    ? counted.reduce((sum, l) => sum + l.compactness, 0) / counted.length
    : null;
  return {
    mean,
    counted: counted.length,
    layers: counted.map((l) => ({
      fill: l.fill,
      coverage: l.area / canvas,
      compactness: l.compactness,
    })),
  };
}

/**
 * Resample a CLOSED polyline at a fixed arc-length step.
 *
 * Wobble has to be measured at one spatial frequency or it is not a
 * measurement: a boundary written as 400 `l` segments and the same boundary
 * written as 12 cubics carry the same shape but wildly different node spacing,
 * and any "sum of turns" over raw nodes just counts nodes. Walking both at the
 * same step makes the two comparable.
 */
export function resampleClosed(points, step) {
  const out = [points[0]];
  let carry = 0;
  for (let i = 1; i <= points.length; i++) {
    const prev = points[i - 1];
    const p = points[i % points.length];
    const segLen = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (segLen === 0) continue;
    let t = 0;
    while (carry + (segLen - t) >= step) {
      t += step - carry;
      const f = t / segLen;
      out.push([prev[0] + (p[0] - prev[0]) * f, prev[1] + (p[1] - prev[1]) * f]);
      carry = 0;
    }
    carry += segLen - t;
  }
  return out;
}

/**
 * The sharpest corner each small feature still has, in degrees, and the bluntest
 * of those — read off the FITTED geometry, not off pixels.
 *
 * `enclosedLightComponents` says a spike is still there; this says it is still a
 * spike. A 142° apex whose arms are eight pixels long is precisely the corner a
 * fixed-window corner detector cannot see: the direction on each side is
 * averaged over a window that is a large fraction of the whole contour, the turn
 * measures small, no corner is pinned, the pre-fit low-pass is free to average
 * across the tip and a triangle comes back as a lozenge. Nothing else here
 * notices — the component survives, the area is nearly right, the ink is intact.
 *
 * Only contours no larger than `maxExtent` inside `box` are measured, because
 * the question is about SMALL features; a big shape has arms long enough that no
 * window can straddle its corners. The turn at a vertex is measured between
 * headings taken `span` samples either side, at a fixed 1px resample step, so a
 * corner written as two cubics and one written as forty `l` segments score the
 * same.
 */
export function featureCornerAngles(
  svg,
  box,
  { maxExtent = 80, curveSamples = 16, step = 1, span = 2, minSamples = 12 } = {},
) {
  const inside = (x, y) =>
    x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height;
  const angles = [];
  for (const chunk of fillLayerChunks(svg)) {
    for (const d of pathDataAttributes(chunk.body)) {
      for (const poly of subPathPolylines(d, curveSamples)) {
        let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of poly) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        if (!inside(minX, minY) || !inside(maxX, maxY)) continue;
        if (Math.max(maxX - minX, maxY - minY) > maxExtent) continue;
        const walk = resampleClosed(poly, step);
        if (walk.length < minSamples) continue;
        const n = walk.length;
        let sharpest = 0;
        for (let i = 0; i < n; i++) {
          const a = walk[(i - span + n) % n];
          const b = walk[i];
          const c = walk[(i + span) % n];
          const v1x = b[0] - a[0];
          const v1y = b[1] - a[1];
          const v2x = c[0] - b[0];
          const v2y = c[1] - b[1];
          const l1 = Math.hypot(v1x, v1y);
          const l2 = Math.hypot(v2x, v2y);
          if (l1 < 1e-9 || l2 < 1e-9) continue;
          const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
          const turn = (Math.acos(dot) * 180) / Math.PI;
          if (turn > sharpest) sharpest = turn;
        }
        angles.push(sharpest);
      }
    }
  }
  if (!angles.length) return { featureCount: 0, minCornerAngle: null, meanCornerAngle: null };
  return {
    featureCount: angles.length,
    // The BLUNTEST feature is the gate: one rounded-off spike in a row of eight
    // is the defect, and a mean would bury it under the seven that survived.
    minCornerAngle: Math.min(...angles),
    meanCornerAngle: angles.reduce((s, v) => s + v, 0) / angles.length,
  };
}

/**
 * BOUNDARY SMOOTHNESS — how much of the pixel grid survived into the geometry,
 * measured against an edge whose true shape is known.
 *
 * Every other geometry metric in this file is *self-referential*: it compares
 * the trace with a smoothed copy of itself, or with the reference product's
 * trace of the same picture. Neither can answer the question a user asks at 8×
 * zoom — "is that supposed to be a straight arc?" — because neither knows what
 * the arc was. `layerWobble` least of all: it is turning per unit length, so a
 * boundary that rises and falls half a pixel every twenty reads as *smoother*
 * than the truth it is approximating, which is how our trace scored 0.74× the
 * exemplar's wobble on artwork whose long arcs visibly undulated against its
 * clean ones.
 *
 * So this metric is only defined where the answer is a fact: on a fixture whose
 * shapes the generator drew from an equation. `arcs` is a list of
 * `{ name, cx, cy, r }` in source pixels; every fitted boundary point within
 * `capture` px of that radius is taken to belong to that circle, and what is
 * reported is the RMS and the worst |distance − mean radius| in pixels.
 *
 * A perfect trace of a rasterized disc scores ~0. Fitting its *pixel* boundary
 * verbatim scores 0.37 (the staircase's own RMS about the circle it
 * approximates), and anything in between is the share of the staircase that got
 * through — which makes the number directly readable: **0.05px means the
 * geometry is as good as the boundary the fitter was handed; 0.35px means the
 * fitter reproduced the pixel grid.**
 *
 * Curves are flattened at a fixed 0.1px step rather than a fixed sample count,
 * because at eight samples per cubic the chord sagitta of a long fitted curve
 * is itself a pixel of "wobble" (see `subPathPolylines`).
 */
export function boundarySmoothness(svg, arcs, { capture = 3.5, step = 0.1, minPoints = 64 } = {}) {
  if (!arcs?.length) return null;
  const points = [];
  for (const chunk of fillLayerChunks(svg)) {
    for (const d of pathDataAttributes(chunk.body)) {
      for (const poly of subPathPolylines(d, { step })) points.push(...poly);
    }
  }
  const measured = [];
  for (const arc of arcs) {
    const radii = [];
    for (const [x, y] of points) {
      const dist = Math.hypot(x - arc.cx, y - arc.cy);
      if (Math.abs(dist - arc.r) <= capture) radii.push(dist);
    }
    if (radii.length < minPoints) {
      measured.push({ name: arc.name, r: arc.r, points: radii.length, rms: null, max: null });
      continue;
    }
    const mean = radii.reduce((s, v) => s + v, 0) / radii.length;
    let sq = 0;
    let max = 0;
    for (const v of radii) {
      const e = v - mean;
      sq += e * e;
      if (Math.abs(e) > max) max = Math.abs(e);
    }
    measured.push({
      name: arc.name,
      r: arc.r,
      points: radii.length,
      fittedRadius: mean,
      rms: Math.sqrt(sq / radii.length),
      max,
    });
  }
  const scored = measured.filter((m) => m.rms != null);
  return {
    arcs: measured,
    // The WORST arc, not the mean: one arc that came back as a pixel staircase
    // is the defect, and averaging it with five clean ones hides it.
    rms: scored.length ? Math.max(...scored.map((m) => m.rms)) : null,
    max: scored.length ? Math.max(...scored.map((m) => m.max)) : null,
    counted: scored.length,
  };
}

/**
 * Boundary WOBBLE — total absolute turning per unit boundary length, averaged
 * over the colour layers that carry the picture.
 *
 * `layerCompactness` asks "how much perimeter does this layer spend on the area
 * it encloses"; it is the right global question and it cannot separate a layer
 * that is genuinely intricate (a hand, a row of teeth) from one whose smooth
 * outline was placed on a noisy per-pixel threshold. This asks the local
 * question instead: walking the boundary at a fixed step, how much does the
 * heading change per unit travelled? One smooth arc through a soft shading
 * gradient is near-zero; a jagged mountain range through the same gradient is
 * large, *however few sub-paths it is written in and however many of its
 * commands are cubics*. That is what the lap-6 critique measured by hand on the
 * belly seam and the paw pad ("a jagged mountain range in ours where the source
 * has a soft gradient and the exemplar draws one smooth arc") and what
 * `curveCommandRatio` 0.872 could not see: our commands ARE curves, they are
 * just fitted to a wobble the reference product never had.
 *
 * Scale-invariant by construction: every coordinate is divided by the drawing's
 * own bounding-box diagonal before the walk, so the exemplar's 10x viewBox and
 * our 1x one are measured on the same footing without guessing a scale factor.
 * `stepFraction` (0.002 of the diagonal, ~2.7 px on the 1046x833 gold standard)
 * sets the frequency; sub-paths shorter than `minLengthFraction` of the diagonal
 * are skipped because a 20 px contour is all corner in either product's output.
 */
export function layerBoundaryWobble(
  svg,
  { minCoverage = 0.01, curveSamples = 16, stepFraction = 0.002, minLengthFraction = 0.02 } = {},
) {
  const geometry = layerGeometry(svg, { curveSamples });
  let box = null;
  for (const l of geometry) {
    if (!l.box) continue;
    box = box
      ? [
          Math.min(box[0], l.box[0]),
          Math.min(box[1], l.box[1]),
          Math.max(box[2], l.box[2]),
          Math.max(box[3], l.box[3]),
        ]
      : l.box;
  }
  if (!box) return { mean: null, counted: 0, layers: [] };
  const canvas = Math.max(1, (box[2] - box[0]) * (box[3] - box[1]));
  const diagonal = Math.max(1e-9, Math.hypot(box[2] - box[0], box[3] - box[1]));
  const chunks = fillLayerChunks(svg);
  const measured = [];

  for (let i = 0; i < chunks.length; i++) {
    const layer = geometry[i];
    if (!layer || layer.compactness == null || layer.area / canvas < minCoverage) continue;
    let turning = 0;
    let length = 0;
    for (const d of pathDataAttributes(chunks[i].body)) {
      for (const poly of subPathPolylines(d, curveSamples)) {
        const norm = poly.map(([x, y]) => [x / diagonal, y / diagonal]);
        let raw = 0;
        for (let k = 1; k < norm.length; k++) {
          raw += Math.hypot(norm[k][0] - norm[k - 1][0], norm[k][1] - norm[k - 1][1]);
        }
        if (raw < minLengthFraction) continue;
        const walk = resampleClosed(norm, stepFraction);
        if (walk.length < 4) continue;
        for (let k = 0; k < walk.length; k++) {
          const a = walk[k];
          const b = walk[(k + 1) % walk.length];
          const c = walk[(k + 2) % walk.length];
          let delta =
            Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0]);
          while (delta > Math.PI) delta -= 2 * Math.PI;
          while (delta < -Math.PI) delta += 2 * Math.PI;
          turning += Math.abs(delta);
          length += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
      }
    }
    if (length > 0) {
      measured.push({ fill: chunks[i].fill, coverage: layer.area / canvas, wobble: turning / length });
    }
  }

  return {
    mean: measured.length ? measured.reduce((s, l) => s + l.wobble, 0) / measured.length : null,
    counted: measured.length,
    layers: measured,
  };
}

/** Squared RGB distance. */
export function colorDistance2(a, b) {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/**
 * Pairs of colour layers closer together than `threshold` (Euclidean RGB).
 *
 * This is the anti-aliasing halo signature: transition pixels between two flat
 * regions quantize into their own near-duplicate slots, become full layers and
 * get painted over the artwork as thin coloured outlines (REFERENCE B4
 * "Anti-aliasing Off/Smart/Mid" is the control that suppresses them).
 *
 * The window is 32, not 24. At 24 the metric reported 0 for the gold-standard
 * fixture while its output carried rgb(213,202,193) beside rgb(197,186,179)
 * (distance 26.6) and rgb(94,149,169) beside rgb(115,162,180) (27.0) — the
 * mottled two-cream patchwork a critic could see across the belly and the
 * metric could not. The real exemplar's own layers are never closer than 37
 * apart, so 32 is inside what the reference product ships and outside what a
 * halo produces.
 */
export function nearDuplicateFillPairs(svg, threshold = 32) {
  const fills = layerFills(svg);
  const limit = threshold * threshold;
  let pairs = 0;
  for (let i = 0; i < fills.length; i++) {
    for (let j = i + 1; j < fills.length; j++) {
      if (colorDistance2(fills[i], fills[j]) <= limit) pairs++;
    }
  }
  return pairs;
}

/**
 * Largest per-colour area drift between the source and the re-rasterized trace.
 *
 * Every pixel of both images is snapped to its nearest entry in `palette`; the
 * result is the maximum absolute difference in coverage fraction over all
 * entries. Thin dark features eroding by a half-pixel inset shows up here as a
 * few percent on the outline colour while MAE/SSIM stay comfortably inside
 * their bars.
 */
export function perColorCoverageDelta(a, b, palette) {
  assertSameSize(a, b);
  if (!palette?.length) return 0;
  const share = (img) => {
    const counts = new Float64Array(palette.length);
    for (let i = 0; i < img.data.length; i += 4) {
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const c = palette[p];
        const d =
          (img.data[i] - c.r) ** 2 + (img.data[i + 1] - c.g) ** 2 + (img.data[i + 2] - c.b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      counts[best]++;
    }
    const n = img.width * img.height;
    return Array.from(counts, (c) => c / n);
  };
  const sa = share(a);
  const sb = share(b);
  let max = 0;
  for (let i = 0; i < palette.length; i++) max = Math.max(max, Math.abs(sa[i] - sb[i]));
  return max;
}

/**
 * The fill of a full-bleed backdrop `<rect>`, or null when there is none.
 *
 * `src/engine/svg.ts` paints the dominant colour as a rect covering the whole
 * canvas. That is correct for an opaque source and a lie for a transparent one:
 * a sticker PNG traced with a black backdrop is the REFERENCE blocker this
 * metric exists to name (docs/HARNESS.md "One decode contract").
 */
export function backdropFill(svg) {
  const box = /\bviewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  if (!box) return null;
  const [w, h] = [Number(box[1]), Number(box[2])];
  const re = /<g\b[^>]*\bfill="([^"]+)"[^>]*>\s*<rect\b([^>]*)>/g;
  for (const m of svg.matchAll(re)) {
    const attrs = m[2];
    const rw = Number(/\bwidth="([\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    const rh = Number(/\bheight="([\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    const rx = Number(/\bx="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    const ry = Number(/\by="([\d.]+)"/.exec(attrs)?.[1] ?? 0);
    if (rx <= 0 && ry <= 0 && rw >= w && rh >= h) {
      return { fill: m[1], color: parseColor(m[1]) };
    }
  }
  return null;
}

/** Everything structural we can read straight out of an SVG string. */
export function svgStructure(svg) {
  const backdrop = backdropFill(svg);
  return {
    backdropFill: backdrop?.fill ?? null,
    hasFullBleedBackdrop: backdrop !== null,
    pathCount: countPaths(svg),
    shapeCount: countShapes(svg),
    subPathCount: countSubPaths(svg),
    tinySubPathRatio: tinySubPathRatio(svg),
    curveCommandRatio: curveCommandRatio(svg),
    cubicCount: countCubics(svg),
    layerCount: layerFills(svg).length,
    // Boundary raggedness of the layers that carry the picture. The number that
    // separates "clipart" from "posterized photo" (see `layerCompactness`).
    layerCompactness: layerCompactness(svg).mean,
    // ...and the LOCAL form of the same question: turning per unit boundary
    // length, which sees a smooth-looking curve fitted to a noisy threshold
    // where compactness (a global perimeter/area ratio) and curveCommandRatio
    // (which only counts command letters) both report health.
    layerWobble: layerBoundaryWobble(svg).mean,
    nearDuplicateFillPairs: nearDuplicateFillPairs(svg),
    bytes: Buffer.byteLength(svg, 'utf8'),
  };
}

function assertSameSize(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}
