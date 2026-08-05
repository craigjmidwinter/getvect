/**
 * Contour tracing — a thin, deterministic wrapper around imagetracerjs.
 *
 * We drive the library's low-level pipeline instead of `imagedataToSVG` because
 * this engine owns quantization (palette editing, REFERENCE B3), despeckling
 * (B2) and SVG serialization (C3 — the preview *is* the export). imagetracerjs
 * contributes what it is good at: edge-node path scanning plus straight/
 * quadratic sequence fitting.
 *
 * Determinism note: the library only reaches for `Math.random()` inside its own
 * palette sampling (`samplepalette`) and the `mincolorratio` re-roll, neither of
 * which is on this code path — we hand it a finished index array.
 */

import ImageTracer, { type ItSegment, type ItTracedPath } from 'imagetracerjs';
import type { Segment, SubPath } from './path';

export interface TraceOptions {
  /** Straight-line error threshold. Lower = follows pixel edges more closely. */
  ltres: number;
  /** Quadratic-spline error threshold. Lower = fewer curves, more line segments. */
  qtres: number;
  /** Edge-node paths shorter than this are discarded. */
  pathomit: number;
  /** Snap near-right-angle corners back to exact corners. */
  rightangleenhance: boolean;
}

/**
 * Stroke compensation bands.
 *
 * imagetracerjs places every node at the midpoint between two pixel corners.
 * Along a straight edge that is exact, but at a corner it cuts half a pixel
 * off — so a contour loses roughly a quarter-pixel of width for every corner it
 * turns. On a large shape that is invisible. On a small, corner-dense blob it
 * removes a large fraction of the area, and on a region a single pixel across
 * it is fatal: the four corners collapse onto the four edge midpoints and the
 * fitter reduces them to a *degenerate*, zero-area contour that a fill paints
 * as nothing at all. That is how a naive tracer silently loses every speck of
 * detail in a noisy scan.
 *
 * Contours that collapse entirely are rebuilt from the index image
 * (`rebuildFromPixels`). What is left — thin but not degenerate — is stroked
 * back to size with its own fill colour. Above a pixel of mean width nothing is
 * stroked at all: corner-cutting is negligible there, and a stroke would only
 * bleed one colour across a boundary into the next.
 *
 * "Size" is the contour's hydraulic radius `2·area / perimeter`, i.e. its mean
 * width in pixels. Contours are bucketed rather than stroked individually so a
 * colour still costs a handful of `<path>` elements, not one per region. A
 * graded middle band (half a pixel for contours 1–4px wide) was tried and moved
 * the fixture metrics by less than 0.001, so it is not carried.
 */
export interface StrokeBand {
  /** Upper bound (exclusive) on mean contour width, in pixels. */
  maxMeanWidth: number;
  /** Same-colour stroke applied to contours in this band. */
  stroke: number;
}

export const STROKE_BANDS: readonly StrokeBand[] = [
  { maxMeanWidth: 1, stroke: 1 },
  { maxMeanWidth: Infinity, stroke: 0 },
];

/** One traced colour layer: the outline set for a single palette entry. */
export interface TracedLayer {
  colorIndex: number;
  /** Contours grouped by `STROKE_BANDS` index. */
  bands: SubPath[][];
  /** Number of top-level (non-hole) contours, i.e. distinct filled regions. */
  regionCount: number;
}

interface Measured {
  area: number;
  perimeter: number;
  cx: number;
  cy: number;
  /** Node count. */
  n: number;
}

/** Node-polygon area, perimeter and centroid of a closed contour. */
function measure(sp: SubPath): Measured {
  const xs = [sp.x];
  const ys = [sp.y];
  for (const seg of sp.segments) {
    xs.push(seg.x);
    ys.push(seg.y);
  }
  const n = xs.length;
  let twiceArea = 0;
  let perimeter = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    twiceArea += xs[i] * ys[j] - xs[j] * ys[i];
    perimeter += Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
    sumX += xs[i];
    sumY += ys[i];
  }
  return { area: Math.abs(twiceArea) / 2, perimeter, cx: sumX / n, cy: sumY / n, n };
}

/** Area below which a contour cannot cover a pixel and must be rebuilt. */
const DEGENERATE_AREA = 0.75;
/** How far a pixel centre may sit from the contour centroid to be its source. */
const SNAP_RADIUS = 0.8;

/**
 * Rebuild a collapsed contour from the pixels it was traced from.
 *
 * A one-pixel region survives node interpolation as a zero-area contour (see
 * `STROKE_BANDS`), and no fill or stroke reproduces it faithfully: a fill paints
 * nothing, a stroke paints a soft blob straddling four pixels. But the pixel is
 * still right there in the index image, so instead of approximating it we look
 * it up and emit its exact square. The result is grid-aligned, so it rasterizes
 * at full strength with no antialiasing at all.
 *
 * Returns `null` when no source pixel can be identified, in which case the
 * caller falls back to stroking.
 */
function rebuildFromPixels(
  measured: Measured,
  paddedArray: number[][],
  colorIndex: number,
  width: number,
  height: number,
  claimed: Set<number>,
): SubPath[] | null {
  const { cx, cy } = measured;
  const squares: SubPath[] = [];
  for (let j = Math.floor(cy - 1); j <= Math.floor(cy + 1); j++) {
    if (j < 0 || j >= height) continue;
    for (let i = Math.floor(cx - 1); i <= Math.floor(cx + 1); i++) {
      if (i < 0 || i >= width) continue;
      if (Math.hypot(i + 0.5 - cx, j + 0.5 - cy) > SNAP_RADIUS) continue;
      if (paddedArray[j + 1][i + 1] !== colorIndex) continue;
      const key = j * width + i;
      // Two 4-connected components can never claim the same pixel, but a
      // diagonal pair sits within snapping range of both — and two identical
      // squares in one even-odd path would cancel out and vanish.
      if (claimed.has(key)) continue;
      claimed.add(key);
      squares.push({
        x: i,
        y: j,
        closed: true,
        segments: [
          { t: 'L', x: i + 1, y: j },
          { t: 'L', x: i + 1, y: j + 1 },
          { t: 'L', x: i, y: j + 1 },
        ],
      });
    }
  }
  return squares.length ? squares : null;
}

/** Which stroke band a contour belongs to, by mean width. */
function bandOf(m: Measured): number {
  const { area, perimeter, n } = m;
  const meanWidth = n < 3 || perimeter <= 0 ? 0 : (2 * area) / perimeter;
  for (let i = 0; i < STROKE_BANDS.length; i++) {
    if (meanWidth < STROKE_BANDS[i].maxMeanWidth) return i;
  }
  return STROKE_BANDS.length - 1;
}

/**
 * Build the (h+2)×(w+2) padded colour-index array imagetracerjs's layering step
 * expects. The -1 border is what makes contours close at the image edge.
 */
function paddedIndexArray(indices: Uint8Array, width: number, height: number): number[][] {
  const array: number[][] = new Array(height + 2);
  for (let j = 0; j < height + 2; j++) {
    const row = new Array<number>(width + 2).fill(-1);
    if (j >= 1 && j <= height) {
      const base = (j - 1) * width;
      for (let i = 0; i < width; i++) row[i + 1] = indices[base + i];
    }
    array[j] = row;
  }
  return array;
}

function segmentsOf(traced: ItTracedPath): { start: { x: number; y: number }; segments: Segment[] } {
  const first = traced.segments[0] as ItSegment;
  const start = { x: first.x1, y: first.y1 };
  const segments: Segment[] = [];
  for (const s of traced.segments) {
    if (s.type === 'Q') {
      segments.push({ t: 'Q', cx: s.x2, cy: s.y2, x: s.x3, y: s.y3 });
    } else {
      segments.push({ t: 'L', x: s.x2, y: s.y2 });
    }
  }
  return { start, segments };
}

/**
 * Reverse a subpath's direction. Holes are emitted with opposite winding to
 * their outer contour so the geometry reads correctly under the nonzero rule
 * too, not just the even-odd rule we declare.
 */
function reverseSubPath(sp: SubPath): SubPath {
  const pts: Array<{ x: number; y: number }> = [{ x: sp.x, y: sp.y }];
  for (const seg of sp.segments) pts.push({ x: seg.x, y: seg.y });
  const last = pts[pts.length - 1];
  const segments: Segment[] = [];
  for (let i = sp.segments.length - 1; i >= 0; i--) {
    const seg = sp.segments[i];
    const target = pts[i];
    if (seg.t === 'Q') segments.push({ t: 'Q', cx: seg.cx, cy: seg.cy, x: target.x, y: target.y });
    else if (seg.t === 'C')
      segments.push({ t: 'C', c1x: seg.c2x, c1y: seg.c2y, c2x: seg.c1x, c2y: seg.c1y, x: target.x, y: target.y });
    else segments.push({ t: 'L', x: target.x, y: target.y });
  }
  return { x: last.x, y: last.y, segments, closed: sp.closed };
}

/** Trace one colour of the index image into closed subpaths. */
export function traceLayer(
  paddedArray: number[][],
  colorIndex: number,
  options: TraceOptions,
): TracedLayer {
  const itOptions = {
    ltres: options.ltres,
    qtres: options.qtres,
    pathomit: options.pathomit,
    rightangleenhance: options.rightangleenhance,
    linefilter: false,
    scale: 1,
    roundcoords: -1,
  };

  const layer = ImageTracer.layeringstep({ array: paddedArray, palette: [] }, colorIndex);
  const scanned = ImageTracer.pathscan(layer, options.pathomit);
  const interpolated = ImageTracer.internodes(scanned, itOptions);
  const traced = ImageTracer.batchtracepaths(interpolated, options.ltres, options.qtres);

  const height = paddedArray.length - 2;
  const width = (paddedArray[0]?.length ?? 2) - 2;
  const exact = STROKE_BANDS.length - 1; // the unstroked band
  const bands: SubPath[][] = STROKE_BANDS.map(() => []);
  const claimed = new Set<number>();
  let regionCount = 0;
  for (let i = 0; i < traced.length; i++) {
    const path = traced[i];
    if (path.isholepath || path.segments.length === 0) continue;
    regionCount++;
    const outer = segmentsOf(path);
    const shape: SubPath = {
      x: outer.start.x,
      y: outer.start.y,
      segments: outer.segments,
      closed: true,
    };
    const metrics = measure(shape);
    if (metrics.area < DEGENERATE_AREA) {
      const squares = rebuildFromPixels(metrics, paddedArray, colorIndex, width, height, claimed);
      if (squares) {
        // A collapsed speck has no holes; emit the pixels and move on.
        bands[exact].push(...squares);
        continue;
      }
    }
    const band = bands[bandOf(metrics)];
    band.push(shape);
    // Holes ride with their outer contour: even-odd only cancels within one
    // path element, so separating them would fill the holes in.
    for (const holeIndex of path.holechildren) {
      const hole = traced[holeIndex];
      if (!hole || hole.segments.length === 0) continue;
      const h = segmentsOf(hole);
      band.push(reverseSubPath({ x: h.start.x, y: h.start.y, segments: h.segments, closed: true }));
    }
  }
  return { colorIndex, bands, regionCount };
}

export { paddedIndexArray };
