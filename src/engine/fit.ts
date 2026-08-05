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
  if (alphaL < epsilon || alphaR < epsilon) {
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

  let u = chordLengthParameterize(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
  let { error, split } = computeMaxError(pts, first, last, bez, u);

  if (error < tolerance) {
    pushCubic(out, bez);
    return;
  }
  if (error < tolerance * 4 && depth < MAX_DEPTH) {
    for (let i = 0; i < 4; i++) {
      const uPrime = reparameterize(pts, first, last, u, bez);
      const nextBez = generateBezier(pts, first, last, uPrime, tHat1, tHat2);
      const next = computeMaxError(pts, first, last, nextBez, uPrime);
      u = uPrime;
      bez = nextBez;
      error = next.error;
      split = next.split;
      if (error < tolerance) {
        pushCubic(out, bez);
        return;
      }
    }
  }

  if (depth >= MAX_DEPTH || split <= first || split >= last) {
    pushCubic(out, bez);
    return;
  }
  const centre = normalize(sub(pts[split + 1] ?? pts[split], pts[split - 1] ?? pts[split]));
  const left = centre.x === 0 && centre.y === 0 ? normalize(sub(pts[split], pts[first])) : centre;
  fitCubic(pts, first, split, tHat1, { x: -left.x, y: -left.y }, tolerance, straightTolerance, out, depth + 1);
  fitCubic(pts, split, last, left, tHat2, tolerance, straightTolerance, out, depth + 1);
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
  const corners = detectCorners(exact, options.cornerAngle, span);

  // Corners are found on the exact boundary and then pinned, so smoothing can
  // never round off a corner the artwork actually has.
  const pinned = new Uint8Array(n);
  for (const c of corners) pinned[c] = 1;
  const pts = smoothInterior(exact, pinned, Math.max(0, Math.round(options.smoothPasses)));
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
