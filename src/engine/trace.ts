/**
 * Contour tracing.
 *
 * Two steps, and the split matters:
 *
 *   1. **Boundary extraction** — imagetracerjs's edge-node walk (`pathscan`)
 *      turns a binary mask into closed rings of *integer pixel corners*. That
 *      polygon is the region's exact boundary: a 1×1 pixel is a unit square, a
 *      rectangle is four points, and the area of the ring equals the pixel count
 *      of the region. Nothing is approximated yet.
 *   2. **Fitting** — src/engine/fit.ts smooths that staircase into lines and
 *      cubic Béziers.
 *
 * The engine used to feed the library's own `internodes` + `batchtracepaths`
 * instead, which places every node at the *midpoint* between two pixel corners.
 * That halves every corner, erodes thin features, and collapses single-pixel
 * regions to zero area — which is why the old code carried a stroke-compensation
 * table and a pixel-rebuild fallback. Fitting the exact boundary needs neither:
 * the geometry starts correct and the fit is bounded by an explicit tolerance.
 *
 * Determinism: `pathscan` is a deterministic walk, and the fitter uses no
 * randomness, so the same mask always produces the same path data.
 */

import ImageTracer, { type ItPath } from 'imagetracerjs';
import {
  fitClosedPolygon,
  polygonArea,
  polygonBounds,
  type Circle,
  type FitOptions,
  type FittedContour,
  type Pt,
} from './fit';
import type { Segment, SubPath } from './path';

export interface TraceOptions extends FitOptions {
  /**
   * Minimum bounding-box area, in px², a shape must have to survive
   * (REFERENCE B5 "Minimum Area 0/5/90"). Measured on the *fitted* geometry, so
   * the promise "no shape smaller than this is in the document" is literal.
   */
  minArea: number;
}

/**
 * A shape recognised as a circle (REFERENCE B5 Circle Detection).
 *
 * `strokeWidth` carries the annulus case: a detected circle whose only hole is a
 * concentric detected circle is exactly a stroked circle, which is both smaller
 * and more faithful than two Bézier rings.
 */
export interface CircleShape extends Circle {
  strokeWidth: number;
}

/** One traced colour layer: the outline set for a single palette entry. */
export interface TracedLayer {
  colorIndex: number;
  /** Outer contours and their holes, in paint order. */
  subpaths: SubPath[];
  /** Contours recognised as circles, emitted as real `<circle>` elements. */
  circles: CircleShape[];
  /** Number of top-level (non-hole) contours, i.e. distinct filled regions. */
  regionCount: number;
}

/**
 * Bounding box of a fitted subpath, control points included — the same extent
 * `instruments/lib/metrics.mjs` measures, so the Minimum Area promise is
 * checked against exactly what a reader sees.
 */
export function subPathBox(sp: SubPath): { width: number; height: number } {
  let x0 = sp.x;
  let x1 = sp.x;
  let y0 = sp.y;
  let y1 = sp.y;
  const hit = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const seg of sp.segments) {
    if (seg.t === 'Q') hit(seg.cx, seg.cy);
    else if (seg.t === 'C') {
      hit(seg.c1x, seg.c1y);
      hit(seg.c2x, seg.c2y);
    }
    hit(seg.x, seg.y);
  }
  return { width: x1 - x0, height: y1 - y0 };
}

/**
 * Reverse a subpath's direction. Holes are emitted with opposite winding to
 * their outer contour so the geometry reads correctly under the nonzero rule
 * too, not just the even-odd rule we declare.
 */
export function reverseSubPath(sp: SubPath): SubPath {
  const pts: Array<{ x: number; y: number }> = [{ x: sp.x, y: sp.y }];
  for (const seg of sp.segments) pts.push({ x: seg.x, y: seg.y });
  const last = pts[pts.length - 1];
  const segments: Segment[] = [];
  for (let i = sp.segments.length - 1; i >= 0; i--) {
    const seg = sp.segments[i];
    const target = pts[i];
    if (seg.t === 'Q') segments.push({ t: 'Q', cx: seg.cx, cy: seg.cy, x: target.x, y: target.y });
    else if (seg.t === 'C')
      segments.push({
        t: 'C',
        c1x: seg.c2x,
        c1y: seg.c2y,
        c2x: seg.c1x,
        c2y: seg.c1y,
        x: target.x,
        y: target.y,
      });
    else segments.push({ t: 'L', x: target.x, y: target.y });
  }
  return { x: last.x, y: last.y, segments, closed: sp.closed };
}

/**
 * Edge-node array for a binary mask, in the layout `pathscan` walks.
 *
 * Each cell describes the four pixels meeting at one grid corner, so the
 * resulting paths run along pixel boundaries. The array is padded by one on
 * every side, which is what makes a region touching the image edge close.
 */
export function edgeNodeArray(mask: Uint8Array, width: number, height: number): number[][] {
  const h = height + 2;
  const w = width + 2;
  const at = (j: number, i: number): number =>
    j >= 1 && j <= height && i >= 1 && i <= width ? mask[(j - 1) * width + (i - 1)] : 0;
  const layer: number[][] = new Array(h);
  layer[0] = new Array<number>(w).fill(0);
  for (let j = 1; j < h; j++) {
    const row = new Array<number>(w).fill(0);
    for (let i = 1; i < w; i++) {
      row[i] =
        (at(j - 1, i - 1) ? 1 : 0) +
        (at(j - 1, i) ? 2 : 0) +
        (at(j, i - 1) ? 8 : 0) +
        (at(j, i) ? 4 : 0);
    }
    layer[j] = row;
  }
  return layer;
}

const pointsOf = (path: ItPath): Pt[] => path.points.map((p) => ({ x: p.x, y: p.y }));

/**
 * Fraction of a shape's own thickness the fit may deviate by. Below ~0.3 the
 * curve fitting stops paying for itself (the outline starts tracking pixel
 * steps again and the file grows); above it, hairlines start dissolving.
 */
const THIN_FIT_FRACTION = 0.3;

/**
 * Fit tolerance, scaled to how thick the shape being fitted actually is.
 *
 * A tolerance is a promise about *absolute* error, and the same 1px of licence
 * means two different things: on a 200px belly it is invisible, on a 2px eyelid
 * it is the difference between a line and nothing. Curve fitting at the default
 * detail was quietly costing the gold-standard artwork ~1.5 % of its ink that
 * way, in exactly the strokes (mouth, eyes, claws) a viewer looks at first.
 *
 * `2·area / perimeter` is the mean thickness of a region — `w` for a `w × L`
 * stroke, `r` for a disc — so allowing a fraction of it keeps the fit
 * proportional: big shapes still get the full tolerance the Detail slider asked
 * for, thin ones get a fit that cannot swallow them. */
function fitOptionsFor(pts: Pt[], options: TraceOptions): TraceOptions {
  let perimeter = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (perimeter <= 0) return options;
  const thickness = (2 * Math.abs(polygonArea(pts))) / perimeter;
  const limit = Math.max(0.25, thickness * THIN_FIT_FRACTION);
  if (limit >= options.tolerance) return options;
  return { ...options, tolerance: limit };
}

/**
 * Trace one binary mask into fitted, closed subpaths.
 *
 * `mask[p]` is truthy for pixels belonging to the layer. Holes ride with their
 * outer contour: even-odd only cancels within one path element, so separating
 * them would fill the holes in.
 */
export function traceMask(
  mask: Uint8Array,
  width: number,
  height: number,
  colorIndex: number,
  options: TraceOptions,
): TracedLayer {
  const nodes = edgeNodeArray(mask, width, height);
  // `pathomit` is 0: shape economy is decided by Minimum Area on real geometry,
  // not by how many edge nodes a contour happens to have.
  const scanned = ImageTracer.pathscan(nodes, 0);

  const minArea = Math.max(0, options.minArea);
  const preFilter = minArea > 0 ? minArea * 0.5 : 0;
  const subpaths: SubPath[] = [];
  const circles: CircleShape[] = [];
  let regionCount = 0;

  const fit = (path: ItPath): FittedContour | null => {
    const pts = pointsOf(path);
    if (pts.length < 3) return null;
    if (preFilter > 0) {
      const b = polygonBounds(pts);
      if ((b.x1 - b.x0) * (b.y1 - b.y0) < preFilter) return null;
    }
    const fitted = fitClosedPolygon(pts, fitOptionsFor(pts, options));
    if (!fitted) return null;
    if (minArea > 0) {
      const box = subPathBox(fitted.subpath);
      if (box.width * box.height < minArea) return null;
    }
    return fitted;
  };

  for (let i = 0; i < scanned.length; i++) {
    const path = scanned[i];
    if (path.isholepath) continue;
    const outer = fit(path);
    if (!outer) continue;
    regionCount++;
    const holes: FittedContour[] = [];
    for (const holeIndex of path.holechildren) {
      const hole = scanned[holeIndex];
      if (!hole) continue;
      const fitted = fit(hole);
      if (fitted) holes.push(fitted);
    }

    if (outer.circle) {
      if (holes.length === 0) {
        circles.push({ ...outer.circle, strokeWidth: 0 });
        continue;
      }
      // A disc with one concentric circular hole is a ring, and a ring is a
      // stroked circle — two numbers instead of two Bézier loops.
      const hole = holes[0];
      if (
        holes.length === 1 &&
        hole.circle &&
        Math.hypot(hole.circle.cx - outer.circle.cx, hole.circle.cy - outer.circle.cy) <= 1 &&
        hole.circle.r < outer.circle.r
      ) {
        const width = outer.circle.r - hole.circle.r;
        circles.push({
          cx: outer.circle.cx,
          cy: outer.circle.cy,
          r: (outer.circle.r + hole.circle.r) / 2,
          strokeWidth: width,
        });
        continue;
      }
    }

    subpaths.push(outer.subpath);
    // Holes ride with their outer contour: even-odd only cancels within one
    // path element, so separating them would fill the holes in.
    for (const hole of holes) subpaths.push(reverseSubPath(hole.subpath));
  }

  return { colorIndex, subpaths, circles, regionCount };
}

/** Mask of every pixel whose palette index is `colorIndex`. */
export function maskForIndex(
  indices: Uint8Array,
  colorIndex: number,
  out?: Uint8Array,
): Uint8Array {
  const mask = out ?? new Uint8Array(indices.length);
  for (let p = 0; p < indices.length; p++) mask[p] = indices[p] === colorIndex ? 1 : 0;
  return mask;
}
