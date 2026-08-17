/**
 * Curve fitting — turning a pixel-boundary polygon into smooth geometry.
 *
 * The tracer hands us the *exact* boundary polygon of a colour region: a closed
 * ring of integer pixel-corner points, so a 1×1 pixel is a unit square and a
 * rectangle is four points. That polygon is area-exact but it is also a
 * staircase, and REFERENCE asks for "smooth curve-fitted outlines (no pixel
 * staircase)". This module is the step that removes the staircase without
 * moving the ink:
 *
 *   1. **Corner detection** — a vertex is a corner when the path's direction
 *      measured over a `cornerSpan`-pixel window turns by more than
 *      `cornerAngle`. Measuring over a window is what distinguishes a real 90°
 *      corner from the 90° zig-zag every diagonal staircase is made of.
 *   2. **Straight runs** — a run whose points all sit within a fraction of a
 *      pixel of its chord becomes one line segment, so axis-aligned artwork
 *      stays exact (and compresses to `h`/`v`).
 *   3. **Cubic fitting** — everything else goes through Schneider's algorithm
 *      (*Graphics Gems*, 1990): least-squares Bézier fit, Newton-Raphson
 *      reparameterization, recursive split at the worst point. Cubics are what
 *      the reference product emits, and one cubic replaces dozens of `h1v1`
 *      steps.
 *   4. **Circle detection** (REFERENCE B5) — a ring whose radii barely vary is
 *      replaced by an exact four-cubic circle.
 *
 * Everything here is pure and deterministic.
 */

import type { Segment, SubPath } from './path';

export interface Pt {
  x: number;
  y: number;
}

export interface FitOptions {
  /** Maximum distance, in pixels, a fitted curve may stray from the polygon. */
  tolerance: number;
  /** Direction change (radians) over `cornerSpan` that counts as a corner. */
  cornerAngle: number;
  /** Window, in polygon vertices, used to estimate direction. */
  cornerSpan: number;
  /** 1-2-1 passes that centre the staircase before fitting; 0 = fit it raw. */
  smoothPasses: number;
  /**
   * Half-width, in boundary vertices (≈ pixels), of the arc-length low-pass
   * that runs before corner detection. 0 = off, and then the fitter sees the
   * raw pixel-corner ring exactly as it always did.
   */
  boundaryRadius: number;
  /**
   * How far, in pixels, that low-pass may move any one vertex. This is the
   * amplitude of wobble it can remove: a two-pixel sawtooth needs ~1px of
   * licence, and a shape thinner than that gets the licence scaled down (see
   * `fitOptionsFor` in trace.ts) so a hairline is never averaged away.
   */
  boundaryShift: number;
  /**
   * How flat a run must be to come out as a straight line instead of a curve.
   * This is what the Roundness control mostly moves: at the angular end a
   * near-flat sweep is a line, at the round end only a truly straight edge is.
   */
  straightTolerance: number;
  /** Try to replace near-circular contours with exact circle geometry (B5). */
  circleDetection: boolean;
}

const TAU = Math.PI * 2;
/** Control-point offset that makes a cubic quarter-arc match a circle. */
const KAPPA = 0.5522847498307936;

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Pt): number => Math.hypot(a.x, a.y);

function normalize(a: Pt): Pt {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** Remove consecutive duplicate points (and a duplicated closing point). */
export function dedupeClosed(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 1e-9 && Math.abs(prev.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) out.pop();
    else break;
  }
  return out;
}

/** Signed area (shoelace) of a closed polygon; positive = counter-clockwise. */
export function polygonArea(points: Pt[]): number {
  let twice = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

/** Axis-aligned bounding box of a point ring. */
export function polygonBounds(points: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// Polygon simplification
// ---------------------------------------------------------------------------

/**
 * Centre the staircase, without moving the ink or the corners.
 *
 * The boundary polygon alternates half a pixel either side of the edge the
 * artist drew. Fitting straight through it means the fitter measures its error
 * against every stair tread and splits the curve to chase them — which is how a
 * smooth arc ends up as fifty two-pixel Béziers: the file stops *looking* like a
 * staircase while still costing like one.
 *
 * A 1-2-1 moving average halves the tread amplitude and, being symmetric, does
 * not bias the outline outward the way keeping the extreme points (Douglas-
 * Peucker) does — measured on the flat fixture, DP moved a colour's area by
 * 1.8 % where this leaves it under 0.4 %. Corners are pinned so a rectangle
 * stays a rectangle.
 */
export function smoothInterior(pts: Pt[], pinned: Uint8Array, passes: number): Pt[] {
  const n = pts.length;
  if (n < 6 || passes <= 0) return pts;
  let current = pts;
  for (let pass = 0; pass < passes; pass++) {
    const next: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      if (pinned[i]) {
        next[i] = current[i];
        continue;
      }
      const a = current[(i - 1 + n) % n];
      const b = current[i];
      const c = current[(i + 1) % n];
      next[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
    }
    current = next;
  }
  return current;
}

/**
 * Cyclic distance, in vertices, from each position to the nearest pinned one.
 * `radius` caps it, so the walk is O(n · 1) rather than O(n · pins).
 */
function distanceToPinned(pinned: Uint8Array, radius: number): Int32Array {
  const n = pinned.length;
  const dist = new Int32Array(n).fill(radius);
  for (let i = 0; i < n; i++) if (pinned[i]) dist[i] = 0;
  // Two wraps in each direction is enough to reach every vertex from any pin.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      const i = k % n;
      const p = (i - 1 + n) % n;
      if (dist[p] + 1 < dist[i]) dist[i] = dist[p] + 1;
    }
    for (let k = n - 1; k >= 0; k--) {
      const i = k % n;
      const p = (i + 1) % n;
      if (dist[p] + 1 < dist[i]) dist[i] = dist[p] + 1;
    }
  }
  return dist;
}

/**
 * Arc-length low-pass over a closed pixel-boundary ring — the step that removes
 * a WOBBLE rather than a staircase.
 *
 * A staircase and a wobble look alike in a screenshot and are completely
 * different problems. A staircase is the ±½px quantization of a smooth edge:
 * `smoothInterior`'s 1-2-1 average centres it, and the curve fitter's tolerance
 * (~0.9px at the default Detail) then absorbs it. A wobble is the colour
 * boundary itself landing in the wrong place — where two shaded regions meet on
 * a soft gradient, the per-pixel nearest-colour decision follows the noise in
 * the gradient, so the *true* seam sawtooths by two or three pixels before
 * anything is fitted. No fitter can remove that: a tolerance smaller than the
 * amplitude has to chase it, and the result is a faithfully-fitted mountain
 * range where the reference product draws one arc. Measured on the gold standard,
 * that is the whole of the gap — mean layer compactness 3.33 against the
 * exemplar's 2.67, boundary wobble 55.4 against 37.2, with our curve-command
 * ratio (0.872) already well above the exemplar's (0.639).
 *
 * So the ring is convolved with a triangular kernel of half-width `radius`
 * vertices — the boundary walk steps one pixel at a time, so a vertex index IS
 * an arc length — and every vertex is then pulled back onto a disc of radius
 * `maxShift` around where it started. The clamp is what makes this safe to run
 * on artwork rather than on a test pattern: the low-pass can straighten a
 * three-pixel sawtooth and still not move a boundary further than the fit
 * tolerance was always allowed to, and callers scale `maxShift` down by a
 * shape's own thickness (trace.ts `fitOptionsFor`) so a hairline gets a
 * fraction of a pixel and survives.
 *
 * Corners are pinned and the window is clipped at them (`distanceToPinned`), so
 * the average never reaches across a corner and a rectangle stays a rectangle.
 */
export function lowPassClosed(
  pts: Pt[],
  pinned: Uint8Array | null,
  radius: number,
  maxShift: number,
): Pt[] {
  const n = pts.length;
  const r = Math.floor(radius);
  if (n < 8 || r < 1 || !(maxShift > 0)) return pts;
  const reach = pinned ? distanceToPinned(pinned, r) : null;
  const out: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (pinned?.[i]) {
      out[i] = pts[i];
      continue;
    }
    // Never average across a corner: the window shrinks as it approaches one.
    const w = reach ? Math.max(1, Math.min(r, reach[i])) : r;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = -w; k <= w; k++) {
      const p = pts[(((i + k) % n) + n) % n];
      const weight = w + 1 - Math.abs(k);
      sx += p.x * weight;
      sy += p.y * weight;
      sw += weight;
    }
    let dx = sx / sw - pts[i].x;
    let dy = sy / sw - pts[i].y;
    const d = Math.hypot(dx, dy);
    if (d > maxShift) {
      const s = maxShift / d;
      dx *= s;
      dy *= s;
    }
    out[i] = { x: pts[i].x + dx, y: pts[i].y + dy };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corner detection
// ---------------------------------------------------------------------------

/**
 * Indices of the vertices where the contour genuinely turns.
 *
 * The direction on each side of a vertex is measured across `span` vertices, so
 * the 90° zig-zag of a diagonal staircase (which averages out over the window)
 * is not a corner while the 90° meeting of two straight edges is. Only local
 * maxima of the turn survive, so one corner never becomes three.
 */
export function detectCorners(points: Pt[], cornerAngle: number, span: number): number[] {
  const n = points.length;
  if (n < 4) return [];
  const window = Math.max(1, Math.min(Math.floor(span), Math.floor(n / 3)));
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const back = normalize(sub(points[i], points[(i - window + n) % n]));
    const fwd = normalize(sub(points[(i + window) % n], points[i]));
    if ((back.x === 0 && back.y === 0) || (fwd.x === 0 && fwd.y === 0)) continue;
    const dot = Math.max(-1, Math.min(1, back.x * fwd.x + back.y * fwd.y));
    turn[i] = Math.acos(dot);
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = turn[i];
    if (t < cornerAngle) continue;
    let isPeak = true;
    for (let k = 1; k <= window; k++) {
      if (turn[(i + k) % n] > t || turn[(i - k + n) % n] > t) {
        isPeak = false;
        break;
      }
      // Ties: keep the first of an equal run so the choice is deterministic.
      if (turn[(i - k + n) % n] === t) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) corners.push(i);
  }
  return corners;
}

// ---------------------------------------------------------------------------
// Circle detection (REFERENCE B5)
// ---------------------------------------------------------------------------

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** A fitted contour, plus the circle it was recognised as (REFERENCE B5). */
export interface FittedContour {
  subpath: SubPath;
  circle: Circle | null;
}

/** Share of a ring's points that may sit outside `tolerance` and still pass. */
const CIRCLE_OUTLIER_SHARE = 0.02;
/** How far the worst single point may sit outside `tolerance`. */
const CIRCLE_OUTLIER_SLACK = 2;
/** Root-mean-square radial error allowed, as a fraction of `tolerance`. */
const CIRCLE_RMS_SHARE = 0.6;

/**
 * Least-squares (Kåsa) circle through a point ring, accepted when the ring is
 * round *as a whole* and really does go all the way round. Returns null
 * otherwise.
 *
 * Acceptance used to be "every single point within `tolerance`", which is a
 * different and much weaker property than being a circle: one notch anywhere on
 * the boundary rejects the whole contour. Real pipelines put notches there —
 * turning Smart anti-aliasing on (now the default) moved four of the 1520
 * points on the reference ring's boundary by 1.9px against a 1.8px tolerance,
 * and circle detection silently stopped finding a mathematically exact circle
 * it had found the day before. So the test is now the shape of the residual
 * distribution: small RMS, at most a couple of percent of points outside
 * tolerance, and none of them wildly outside. A truncated disc (the flat
 * fixture's navy circle, which the green bar cuts the bottom off) scores an RMS
 * of 4.8 against a 1.1 budget and is still rejected, which is the case that
 * matters.
 */
export function fitCircle(points: Pt[], tolerance: number): Circle | null {
  const n = points.length;
  if (n < 8) return null;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;

  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const c1 = (suuu + suvv) / 2;
  const c2 = (svvv + svuu) / 2;
  const uc = (c1 * svv - c2 * suv) / det;
  const vc = (c2 * suu - c1 * suv) / det;
  const cx = uc + mx;
  const cy = vc + my;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!Number.isFinite(r) || r < 3) return null;

  // Round as a whole: RMS inside budget, few outliers, none of them extreme.
  let sumSq = 0;
  let outliers = 0;
  for (const p of points) {
    const d = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    if (d > tolerance * CIRCLE_OUTLIER_SLACK) return null;
    if (d > tolerance) outliers++;
    sumSq += d * d;
  }
  if (outliers > n * CIRCLE_OUTLIER_SHARE) return null;
  if (Math.sqrt(sumSq / n) > tolerance * CIRCLE_RMS_SHARE) return null;
  // ...and the ring must be a full turn, not an arc that happens to be round.
  const seen = new Uint8Array(16);
  for (const p of points) {
    const a = Math.atan2(p.y - cy, p.x - cx);
    seen[Math.min(15, Math.floor(((a + Math.PI) / TAU) * 16))] = 1;
  }
  for (let i = 0; i < 16; i++) if (!seen[i]) return null;
  return { cx, cy, r };
}

/** Exact circle as four cubic arcs, wound to match `clockwise`. */
export function circleSubPath(circle: Circle, clockwise = true): SubPath {
  const { cx, cy, r } = circle;
  const k = KAPPA * r;
  const segments: Segment[] = clockwise
    ? [
        { t: 'C', c1x: cx + r, c1y: cy + k, c2x: cx + k, c2y: cy + r, x: cx, y: cy + r },
        { t: 'C', c1x: cx - k, c1y: cy + r, c2x: cx - r, c2y: cy + k, x: cx - r, y: cy },
        { t: 'C', c1x: cx - r, c1y: cy - k, c2x: cx - k, c2y: cy - r, x: cx, y: cy - r },
        { t: 'C', c1x: cx + k, c1y: cy - r, c2x: cx + r, c2y: cy - k, x: cx + r, y: cy },
      ]
    : [
        { t: 'C', c1x: cx + r, c1y: cy - k, c2x: cx + k, c2y: cy - r, x: cx, y: cy - r },
        { t: 'C', c1x: cx - k, c1y: cy - r, c2x: cx - r, c2y: cy - k, x: cx - r, y: cy },
        { t: 'C', c1x: cx - r, c1y: cy + k, c2x: cx - k, c2y: cy + r, x: cx, y: cy + r },
        { t: 'C', c1x: cx + k, c1y: cy + r, c2x: cx + r, c2y: cy + k, x: cx + r, y: cy },
      ];
  return { x: cx + r, y: cy, closed: true, segments };
}

// ---------------------------------------------------------------------------
// Schneider cubic fitting
// ---------------------------------------------------------------------------

type Bezier = [Pt, Pt, Pt, Pt];

const bezierPoint = (bez: Bezier, t: number): Pt => {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * bez[0].x + b * bez[1].x + c * bez[2].x + d * bez[3].x,
    y: a * bez[0].y + b * bez[1].y + c * bez[2].y + d * bez[3].y,
  };
};

function chordLengthParameterize(pts: Pt[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) {
    u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])));
  }
  const total = u[u.length - 1];
  if (total <= 0) return u.map((_, i) => i / Math.max(1, u.length - 1));
  return u.map((v) => v / total);
}

/**
 * Longest handle the least-squares solve may keep, as a multiple of the run's
 * own ARC LENGTH.
 *
 * The 2x2 system in `generateBezier` is near-singular whenever a run is short (a
 * three-point run has ONE interior sample) or its end tangents nearly cancel,
 * and then the alphas explode. On the mascot's demo trace a 2x7px sliver at
 * (173..175, 186..193) produced handles ~477px long on a 1.6px chord —
 * `c 109.96 464.07 -116.57 -495.31 0.77 1.22`, shipped verbatim in the asset: at
 * 24x it draws a great orange X across a part of the drawing that is blank.
 *
 * `computeMaxError` cannot see that swing, which is why it survived every check
 * we had: the error is evaluated at the data points' own parameters, and a
 * three-point run has exactly one of those. The curve passes through it, the fit
 * is accepted at error 0.000, and the recursion never splits.
 *
 * The cure is the bound Schneider's published code omits and the guard below
 * only half-had: undersized alphas already fall back to Wu/Barsky chord/3
 * handles, so oversized ones take the same path, after which the usual
 * error-then-split recursion judges honestly. A cubic lies inside the convex
 * hull of its control points, so bounding the handles bounds the curve.
 *
 * WHY THE ARC AND NOT THE CHORD. Two independent laps found this defect and
 * proposed two bounds — handles capped at 3x the CHORD, and handles capped at
 * the ARC. Measured over 262,865 fitted runs they disagree 950 times, and each
 * is wrong where the other is right:
 *
 *   - A chord-relative cap is undefined on a CLOSED contour. Six runs in the
 *     corpus have a chord of exactly 0.0000px against arcs of 166-210px; 3x0 is
 *     0, so every handle trips the guard and falls back to 0/3 = 0, collapsing
 *     the cubic to a degenerate point.
 *   - An arc-relative cap of 1.0 sits exactly on the legitimate p99 and rejects
 *     900 honest fits, most of them tight curls on short runs.
 *
 * The distribution settles the ratio. Over 488,030 handles, alpha/arc runs
 * p50 0.384, p99 0.893 — and then jumps to 33.5 at p99.9. Legitimate fits and
 * blowups are cleanly bimodal with an order of magnitude of empty space between
 * them, so the constant only has to land in the gap: 2.0 leaves 2.2x of headroom
 * above the honest p99 and still catches the explosions 16x below their floor.
 * (For reference, an arc at this fitter's own 75-degree sweep cap wants ~0.33.)
 */
const MAX_ALPHA_ARC_RATIO = 2;

/** Least-squares control points for fixed endpoints and end tangents. */
function generateBezier(
  pts: Pt[],
  first: number,
  last: number,
  u: number[],
  tHat1: Pt,
  tHat2: Pt,
): Bezier {
  const p0 = pts[first];
  const p3 = pts[last];
  const n = last - first + 1;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;

  for (let i = 0; i < n; i++) {
    const t = u[i];
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const a1 = { x: tHat1.x * b1, y: tHat1.y * b1 };
    const a2 = { x: tHat2.x * b2, y: tHat2.y * b2 };
    c00 += a1.x * a1.x + a1.y * a1.y;
    c01 += a1.x * a2.x + a1.y * a2.y;
    c11 += a2.x * a2.x + a2.y * a2.y;
    const tmp = {
      x: pts[first + i].x - (b0 * p0.x + b1 * p0.x + b2 * p3.x + b3 * p3.x),
      y: pts[first + i].y - (b0 * p0.y + b1 * p0.y + b2 * p3.y + b3 * p3.y),
    };
    x0 += a1.x * tmp.x + a1.y * tmp.y;
    x1 += a2.x * tmp.x + a2.y * tmp.y;
  }

  const det = c00 * c11 - c01 * c01;
  const detA = x0 * c11 - c01 * x1;
  const detB = c00 * x1 - x0 * c01;
  let alphaL = Math.abs(det) < 1e-12 ? 0 : detA / det;
  let alphaR = Math.abs(det) < 1e-12 ? 0 : detB / det;

  const segLength = len(sub(p3, p0));
  const epsilon = 1e-6 * segLength;
  let arcLength = 0;
  for (let i = first; i < last; i++) arcLength += len(sub(pts[i + 1], pts[i]));
  const alphaMax = MAX_ALPHA_ARC_RATIO * Math.max(arcLength, segLength);
  if (alphaL < epsilon || alphaR < epsilon || alphaL > alphaMax || alphaR > alphaMax) {
    // Wu/Barsky fallback: put the handles a third of the chord out.
    alphaL = segLength / 3;
    alphaR = segLength / 3;
  }
  return [
    p0,
    { x: p0.x + tHat1.x * alphaL, y: p0.y + tHat1.y * alphaL },
    { x: p3.x + tHat2.x * alphaR, y: p3.y + tHat2.y * alphaR },
    p3,
  ];
}

function computeMaxError(
  pts: Pt[],
  first: number,
  last: number,
  bez: Bezier,
  u: number[],
): { error: number; split: number } {
  let maxDist = 0;
  let split = Math.floor((last + first) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(bez, u[i - first]);
    const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
    if (d >= maxDist) {
      maxDist = d;
      split = i;
    }
  }
  return { error: Math.sqrt(maxDist), split };
}

/** One Newton-Raphson step per point, pulling parameters onto the curve. */
function reparameterize(pts: Pt[], first: number, last: number, u: number[], bez: Bezier): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) {
    const t = u[i - first];
    const p = bezierPoint(bez, t);
    // First and second derivative of the cubic at t.
    const q1: Pt[] = [];
    for (let k = 0; k < 3; k++) {
      q1.push({ x: (bez[k + 1].x - bez[k].x) * 3, y: (bez[k + 1].y - bez[k].y) * 3 });
    }
    const q2: Pt[] = [];
    for (let k = 0; k < 2; k++) {
      q2.push({ x: (q1[k + 1].x - q1[k].x) * 2, y: (q1[k + 1].y - q1[k].y) * 2 });
    }
    const mt = 1 - t;
    const d1 = {
      x: mt * mt * q1[0].x + 2 * mt * t * q1[1].x + t * t * q1[2].x,
      y: mt * mt * q1[0].y + 2 * mt * t * q1[1].y + t * t * q1[2].y,
    };
    const d2 = {
      x: mt * q2[0].x + t * q2[1].x,
      y: mt * q2[0].y + t * q2[1].y,
    };
    const diff = sub(p, pts[i]);
    const numerator = diff.x * d1.x + diff.y * d1.y;
    const denominator = d1.x * d1.x + d1.y * d1.y + diff.x * d2.x + diff.y * d2.y;
    out.push(Math.abs(denominator) < 1e-12 ? t : t - numerator / denominator);
  }
  return out;
}

/**
 * NET turning across a run, in radians — how far the boundary's heading has
 * swung from one end to the other, with the wobble cancelled out.
 *
 * Signed and summed, so a two-pixel sawtooth contributes nothing (it turns one
 * way and straight back) while an arc contributes its whole sweep. That is the
 * distinction the arc cap below is built on: it must split a long smooth bend
 * and must NOT split a noisy straight seam, and total *absolute* turning cannot
 * tell those apart.
 */
function netTurn(pts: Pt[], first: number, last: number): number {
  let total = 0;
  let prevAngle: number | null = null;
  for (let i = first; i < last; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    if (prevAngle !== null) {
      let delta = angle - prevAngle;
      while (delta > Math.PI) delta -= TAU;
      while (delta < -Math.PI) delta += TAU;
      total += delta;
    }
    prevAngle = angle;
  }
  return total;
}

/** The vertex at which half of a run's net turning has been spent. */
function turnMidpoint(pts: Pt[], first: number, last: number, target: number): number {
  let total = 0;
  let prevAngle: number | null = null;
  for (let i = first; i < last; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    if (dx === 0 && dy === 0) continue;
    const angle = Math.atan2(dy, dx);
    if (prevAngle !== null) {
      let delta = angle - prevAngle;
      while (delta > Math.PI) delta -= TAU;
      while (delta < -Math.PI) delta += TAU;
      total += delta;
      if (Math.abs(total) >= target) return i;
    }
    prevAngle = angle;
  }
  return Math.floor((first + last) / 2);
}

/**
 * How far a single cubic may bend, in radians (75°).
 *
 * A cubic Bézier cannot be a circular arc, and how badly it misses is a
 * function of the SWEEP, not of the error budget: a quarter turn is off its arc
 * by 2.7e-4·R, a 120° turn by ~1.5e-3·R, a 180° turn by ~5e-2·R. On a 200px
 * radius those are 0.05px, 0.30px and 10px. The fit tolerance cannot see that
 * as a defect — a 116° bulge measures 0.72px against a 0.89px budget and is
 * accepted — and the result is a boundary that leaves its arc in the middle of
 * every segment and rejoins it at the ends: an undulation at the wavelength of
 * a fitted segment, which is what "the long smooth arcs read as pixels" turned
 * out to be.
 *
 * So a run that sweeps more than this is split whatever its measured error,
 * at the point where half the sweep has been spent. 75° keeps the worst single
 * arc inside 1e-4·R (0.02px at radius 200, 0.04px at radius 400 — under the
 * residual the boundary low-pass itself leaves) and costs five segments for a
 * full circle where four is the theoretical floor.
 *
 * NET turning, not absolute, so this cannot fire on a wobble: a seam that
 * sawtooths ±30° a dozen times nets ~0 and is left for the tolerance to judge.
 */
const MAX_ARC_TURN = (75 * Math.PI) / 180;

/**
 * Deviation, in pixels, a single cubic's own bend may contribute before the run
 * is split on the arc regardless of the fit tolerance.
 *
 * The sweep alone is the wrong test: a triangle's 8px-long apex turns through
 * 140° and misses its own arc by two hundredths of a pixel, while a 200px
 * radius that turns through 116° misses by a third of one. What matters is the
 * product, and it has a closed form — a cubic fitted to a circular arc of
 * radius `R` and sweep `θ` deviates by about `2.7e-4·R·(θ/(π/2))⁶`, and on a
 * traced run `R ≈ length/θ`, so the estimate needs nothing but the run's own
 * length and net turn.
 *
 * A fiftieth of a pixel: below the residual the boundary low-pass itself leaves
 * (0.06px on a rasterized disc), so the cap stops splitting at about the point
 * where the cubic's own bend has stopped being what limits accuracy. Measured
 * on rasterized discs, it takes the fitted ring from RMS 0.21/0.36/0.28px
 * (radius 100/200/400) to 0.04/0.12/0.08px for four extra cubics apiece.
 */
const ARC_ERROR_FLOOR = 0.02;
/** Deviation of a cubic from a quarter circle, as a fraction of the radius. */
const QUARTER_ARC_ERROR = 2.7e-4;

/**
 * Turn, over a few vertices, above which a split point is a CORNER rather than
 * a place on an arc (30°).
 *
 * The two halves of a recursive split share one tangent, so wherever the fitter
 * divides a run it also declares that point smooth. That is harmless on an arc
 * and destructive on a point: the arc cap's first version split every run that
 * swept more than 75°, which on the spikes fixture meant splitting *at the apex
 * of a triangle* — the one vertex on that contour where a shared tangent is a
 * lie — and the sharpest surviving feature corner fell from 88° to 59°.
 *
 * A run that carries its turn at a single vertex is not an arc that needs
 * capping, it is a corner the detector did not pin, and the ordinary
 * error-driven recursion (which splits at the worst-fitted point, i.e. the
 * corner itself, only once the error demands it) is what the corner gates were
 * measured on. So the cap steps aside.
 */
const SHARP_SPLIT_TURN = (30 * Math.PI) / 180;

/**
 * How far either side of a candidate split the sharpness test looks, in
 * vertices. It has to be wider than the boundary low-pass's own reach or it
 * cannot see a corner at all: `lowPassClosed` smears an unpinned turn across
 * `boundaryRadius` vertices (8 at the default Smoothing), so a two-vertex probe
 * of a triangle's apex reads a gentle 20° and lets the cap split straight
 * through it.
 */
const SHARP_SPLIT_SPAN = 6;

/**
 * How many times an evenly-spread turn the local turn must be before a split
 * point counts as a corner. Two: an arc scores 1 by construction, and a corner
 * scores the run's length over the probe window, which is many.
 */
const SHARP_CONCENTRATION = 2;

/**
 * How far one cubic would stray from the arc this run describes — see
 * `ARC_ERROR_FLOOR`. `R` is recovered from the run's own length and sweep.
 */
function arcError(pts: Pt[], first: number, last: number, sweep: number): number {
  let length = 0;
  for (let i = first; i < last; i++) length += len(sub(pts[i + 1], pts[i]));
  if (!(length > 0) || !(sweep > 0)) return 0;
  const radius = length / sweep;
  return QUARTER_ARC_ERROR * radius * (sweep / (Math.PI / 2)) ** 6;
}

/**
 * Is `at` a corner — is the run's turning CONCENTRATED there rather than spread
 * along it?
 *
 * Absolute angle alone cannot answer this, because how much a smooth arc turns
 * over six vertices depends entirely on its radius: 6° on a 60px bend and 60°
 * on a 6px one. So the local turn is compared with what this run's own sweep
 * would produce if it were distributed evenly — an arc scores ~1, a corner
 * scores the ratio of the run's length to the window. The absolute floor is
 * kept as well, so a gently curving run is never called a corner on the
 * strength of a ratio between two small numbers.
 */
function isSharp(pts: Pt[], at: number, first: number, last: number, sweep: number): boolean {
  const back = Math.max(first, at - SHARP_SPLIT_SPAN);
  const fwd = Math.min(last, at + SHARP_SPLIT_SPAN);
  if (back === at || fwd === at) return false;
  const a = normalize(sub(pts[at], pts[back]));
  const b = normalize(sub(pts[fwd], pts[at]));
  if ((a.x === 0 && a.y === 0) || (b.x === 0 && b.y === 0)) return false;
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y));
  const local = Math.acos(dot);
  if (local <= SHARP_SPLIT_TURN) return false;
  const even = (sweep * (fwd - back)) / Math.max(1, last - first);
  return local > SHARP_CONCENTRATION * even;
}

/** Largest distance from the chord `first..last` — the "is this straight?" test. */
function maxChordDeviation(pts: Pt[], first: number, last: number): number {
  const a = pts[first];
  const b = pts[last];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) {
    let worst = 0;
    for (let i = first + 1; i < last; i++) worst = Math.max(worst, len(sub(pts[i], a)));
    return worst;
  }
  let worst = 0;
  for (let i = first + 1; i < last; i++) {
    const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / l;
    if (d > worst) worst = d;
  }
  return worst;
}

const MAX_DEPTH = 24;

/**
 * Newton-Raphson reparameterization passes run on **every** candidate cubic.
 *
 * Eight, because that is where the improvement stops paying on this artwork:
 * on a rasterized disc the radial RMS of the fitted ring falls 0.357 → 0.062 →
 * 0.031px over the first four passes and then moves in the fourth decimal,
 * while the cost is a few Newton steps on runs that are usually a few dozen
 * points long (the whole gold-standard trace moves by single-digit
 * milliseconds). Each pass is kept only when it lowers the error, so the loop
 * is monotone and terminating.
 */
const REFINE_PASSES = 3;

/**
 * Fit `pts[first..last]` with cubics (or a line), appending to `out`.
 * `tHat1`/`tHat2` are unit tangents pointing into the run at each end.
 */
function fitCubic(
  pts: Pt[],
  first: number,
  last: number,
  tHat1: Pt,
  tHat2: Pt,
  tolerance: number,
  straightTolerance: number,
  out: Segment[],
  depth: number,
): void {
  const count = last - first + 1;
  if (count < 2) return;
  if (count === 2) {
    out.push({ t: 'L', x: pts[last].x, y: pts[last].y });
    return;
  }
  // A run that is already straight stays straight: axis-aligned artwork must
  // not be "smoothed" into a wobble, and `h`/`v` is a fraction of the bytes.
  //
  // Only whole runs (depth 0) get this treatment. Inside a curve the fitter has
  // already decided the outline bends, and emitting a two-pixel line segment
  // for a locally-flat patch of a curve is exactly the staircase we came here
  // to remove — it just wears a shorter step.
  if (depth === 0 && maxChordDeviation(pts, first, last) <= straightTolerance) {
    out.push({ t: 'L', x: pts[last].x, y: pts[last].y });
    return;
  }

  // A run that bends more than one cubic can honestly carry is split on the
  // ARC, before any error is measured — see `MAX_ARC_TURN`.
  if (depth < MAX_DEPTH) {
    const sweep = Math.abs(netTurn(pts, first, last));
    if (sweep > MAX_ARC_TURN && arcError(pts, first, last, sweep) > ARC_ERROR_FLOOR) {
      const at = turnMidpoint(pts, first, last, sweep / 2);
      if (at > first && at < last && !isSharp(pts, at, first, last, sweep)) {
        const mid = splitTangent(pts, at, first, last);
        fitCubic(pts, first, at, tHat1, { x: -mid.x, y: -mid.y }, tolerance, straightTolerance, out, depth + 1);
        fitCubic(pts, at, last, mid, tHat2, tolerance, straightTolerance, out, depth + 1);
        return;
      }
    }
  }

  let u = chordLengthParameterize(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { error, split } = computeMaxError(pts, first, last, bez, u);

  // REFINE BEFORE JUDGING — and refine whatever is emitted.
  //
  // Schneider's original only reparameterizes a fit that is *nearly* good
  // enough (error < 4·tolerance) and emits anything already inside the budget
  // exactly as the first least-squares solve produced it. That is what put the
  // pixel staircase back into a boundary the low-pass had already removed.
  // Measured on a rasterized disc of radius 200: the exact pixel ring sits RMS
  // 0.367px from the true circle, `lowPassClosed` brings that to 0.063px — and
  // the unrefined four-cubic fit handed it back at 0.357px, worst 0.75px. The
  // tolerance is an error BUDGET, chord-length parameterization spends all of
  // it, and the result is a curve that wanders a whole pixel either side of the
  // arc it was given. At the length scale of a fitted segment that reads as an
  // undulation — the "smooth arc that follows the pixel grid" the screenshots
  // showed.
  //
  // Newton-Raphson reparameterization is the cure and it was already here; it
  // was just gated off for the fits that needed it least in Schneider's terms
  // and most in ours. Running it unconditionally can only *lower* the error
  // (each pass is kept only if it improves), so a run that was inside the
  // budget stays inside it: the accept criterion below is unchanged and the
  // segment count can never grow because of this loop.
  for (let i = 0; i < REFINE_PASSES; i++) {
    if (error <= 1e-9) break;
    const uPrime = reparameterize(pts, first, last, u, bez);
    const nextBez = generateBezier(pts, first, last, uPrime, tHat1, tHat2);
    const next = computeMaxError(pts, first, last, nextBez, uPrime);
    if (!(next.error < error)) break;
    u = uPrime;
    bez = nextBez;
    error = next.error;
    split = next.split;
  }

  if (error < tolerance) {
    pushCubic(out, bez);
    return;
  }

  if (depth >= MAX_DEPTH || split <= first || split >= last) {
    pushCubic(out, bez);
    return;
  }
  const left = splitTangent(pts, split, first, last);
  fitCubic(pts, first, split, tHat1, { x: -left.x, y: -left.y }, tolerance, straightTolerance, out, depth + 1);
  fitCubic(pts, split, last, left, tHat2, tolerance, straightTolerance, out, depth + 1);
}

/**
 * Window, in polygon vertices, the tangent at a recursive split is averaged
 * over. The boundary walk steps one pixel at a time, so this is a distance:
 * five pixels each way.
 */
const SPLIT_TANGENT_SPAN = 5;

/**
 * Unit tangent at a split point, averaged over a window and clamped to the run.
 *
 * This used to be a two-vertex central difference, `pts[split+1] - pts[split-1]`,
 * and it was the other half of the "smooth arc that follows the pixel grid"
 * defect. A cubic's END TANGENTS are fixed input to the least-squares solve —
 * `generateBezier` may only choose how far the handles reach along them — so a
 * tangent that is a few degrees out cannot be recovered by fitting or by any
 * amount of reparameterization; the whole segment leaves in the wrong direction
 * and bows back. Over two vertices ≈ two pixels, the residual ±0.06px ripple
 * the low-pass leaves is a direction error of ~3.4°, an order of magnitude
 * worse than the span-averaged tangents the run's *ends* already used. Averaged
 * over five vertices instead, the same ripple is ~0.7°, and the fitted disc's
 * radial RMS drops from 0.36px to 0.02px.
 *
 * The window is clamped to `[first, last]` rather than wrapped, so the estimate
 * never reaches across a pinned corner into a different run.
 */
function splitTangent(pts: Pt[], split: number, first: number, last: number): Pt {
  let acc = { x: 0, y: 0 };
  for (let k = 1; k <= SPLIT_TANGENT_SPAN; k++) {
    const back = Math.max(first, split - k);
    const fwd = Math.min(last, split + k);
    if (back === fwd) continue;
    acc = { x: acc.x + (pts[fwd].x - pts[back].x) / k, y: acc.y + (pts[fwd].y - pts[back].y) / k };
  }
  const unit = normalize(acc);
  if (unit.x !== 0 || unit.y !== 0) return unit;
  return normalize(sub(pts[split], pts[first]));
}

function pushCubic(out: Segment[], bez: Bezier): void {
  out.push({
    t: 'C',
    c1x: bez[1].x,
    c1y: bez[1].y,
    c2x: bez[2].x,
    c2y: bez[2].y,
    x: bez[3].x,
    y: bez[3].y,
  });
}

/** Unit tangent leaving `i` along the ring, averaged over `span` vertices. */
function tangentAt(pts: Pt[], i: number, span: number, forward: boolean): Pt {
  const n = pts.length;
  const step = forward ? 1 : -1;
  let acc = { x: 0, y: 0 };
  for (let k = 1; k <= span; k++) {
    const j = (i + step * k + n * (span + 1)) % n;
    const w = 1 / k;
    acc = { x: acc.x + (pts[j].x - pts[i].x) * w, y: acc.y + (pts[j].y - pts[i].y) * w };
  }
  return normalize(acc);
}

/**
 * Fit a closed pixel-boundary polygon into a `SubPath` of lines and cubics.
 *
 * The polygon is assumed to be the exact region boundary (integer pixel
 * corners), so the fit is what introduces smoothing — nothing upstream has
 * already rounded the shape off.
 */
export function fitClosedPolygon(points: Pt[], options: FitOptions): FittedContour | null {
  const exact = dedupeClosed(points);
  if (exact.length < 3) return null;

  if (options.circleDetection) {
    const circle = fitCircle(exact, Math.max(1, options.tolerance * 2));
    if (circle) {
      return { subpath: circleSubPath(circle, polygonArea(exact) > 0), circle };
    }
  }

  const n = exact.length;
  const span = Math.max(1, Math.min(Math.round(options.cornerSpan), Math.floor(n / 3)));

  /**
   * Corners are looked for on the LOW-PASSED ring, then pinned on the exact one.
   *
   * Reading them off the raw boundary sounds safer and is the reason the wobble
   * survived every previous attempt to smooth it: a three-pixel sawtooth turns
   * through more than the corner threshold at every tooth, so each tooth was
   * pinned as a "corner", the smoothing was forbidden from touching it, and the
   * fitter was then required to interpolate the tooth exactly. Detecting on the
   * low-passed ring asks the question at the scale a viewer sees — a real 90°
   * meeting of two edges still turns 90° once a ±1px wobble is averaged out,
   * while the teeth stop existing. The pin itself is still placed on the exact
   * vertex, so a corner keeps its true position.
   */
  const probe = lowPassClosed(exact, null, options.boundaryRadius, options.boundaryShift);
  const corners = detectCorners(probe, options.cornerAngle, span);

  // Corners are found on the exact boundary and then pinned, so smoothing can
  // never round off a corner the artwork actually has.
  const pinned = new Uint8Array(n);
  for (const c of corners) pinned[c] = 1;
  const relaxed = lowPassClosed(exact, pinned, options.boundaryRadius, options.boundaryShift);
  const pts = smoothInterior(relaxed, pinned, Math.max(0, Math.round(options.smoothPasses)));
  const segments: Segment[] = [];

  if (corners.length === 0) {
    // A smooth closed ring: split it in half so each half has real end
    // tangents, then close it. Splitting anywhere is fine — the tangents are
    // computed cyclically, so the seam is C1 by construction.
    const half = Math.floor(n / 2);
    const ring = [...pts, pts[0]];
    const t0 = tangentAt(pts, 0, span, true);
    const tHalf = tangentAt(pts, half, span, true);
    fitCubic(ring, 0, half, t0, { x: -tHalf.x, y: -tHalf.y }, options.tolerance, options.straightTolerance, segments, 0);
    fitCubic(ring, half, n, tHalf, { x: -t0.x, y: -t0.y }, options.tolerance, options.straightTolerance, segments, 0);
    return { subpath: { x: pts[0].x, y: pts[0].y, closed: true, segments }, circle: null };
  }

  // Rotate so the contour starts on a corner, then fit corner-to-corner.
  const start = corners[0];
  const rotated: Pt[] = [];
  for (let i = 0; i <= n; i++) rotated.push(pts[(start + i) % n]);
  const marks = corners.map((c) => (c - start + n) % n).sort((a, b) => a - b);
  marks.push(n);

  for (let m = 0; m < marks.length - 1; m++) {
    const a = marks[m];
    const b = marks[m + 1];
    if (b <= a) continue;
    const tHat1 = normalize(sub(rotated[Math.min(a + span, b)], rotated[a]));
    const tHat2 = normalize(sub(rotated[Math.max(b - span, a)], rotated[b]));
    fitCubic(rotated, a, b, tHat1, tHat2, options.tolerance, options.straightTolerance, segments, 0);
  }

  if (segments.length === 0) return null;
  return { subpath: { x: rotated[0].x, y: rotated[0].y, closed: true, segments }, circle: null };
}
