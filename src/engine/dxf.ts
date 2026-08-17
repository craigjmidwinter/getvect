/**
 * DXF writer — REFERENCE D3.
 *
 * Geometry-level conversion: shapes are recovered from the result's SVG and
 * re-emitted as ASCII DXF, in the two variants the reference product offers side by
 * side in its download menu (REFERENCE E: "DXF
 * (splines)", "DXF (lines)"):
 *
 *   `curves: 'splines'` (default) — R2000 (AC1015). Every cubic run in the
 *      drawing travels as a degree-3 `SPLINE` whose control points are the
 *      Bézier control points, so the curve fitting the SVG paid for arrives
 *      intact and the file is a drawing rather than a point cloud. SPLINE is an
 *      R13+ entity, which is why this variant declares R2000 and carries the
 *      handles and subclass markers that dialect requires.
 *   `curves: 'lines'` — R12 (AC1009), curves flattened into POLYLINE vertices.
 *      R12 is the most widely readable dialect (old CAD, laser/vinyl cutters),
 *      and some of those readers really do only implement POLYLINE.
 *
 * The default used to be the second one, and the bill was 1.49 MB of
 * POLYLINE/VERTEX (28058 vertices) against a 121 KB EPS of the identical
 * drawing — 21x the SVG — for geometry that is 90 % curves.
 *
 * Conventions, both variants:
 *   - 1 source pixel = 1 drawing unit.
 *   - DXF is y-up, SVG is y-down, so y is mirrored about the artwork height.
 *   - One LAYER per palette colour, named `C_RRGGBB` so the exact colour
 *     survives even though DXF entity colours are ACI indices, not RGB.
 *   - Straight segments stay straight: a run of `L` commands is a POLYLINE in
 *     both variants. Nothing is turned into a curve it was not.
 */

import { parseHex } from './color';
import { boundsOf, flattenSubPath, parseSvgShapes, type SubPath } from './path';
import type { RgbColor, VectorizeResult } from './types';

/**
 * The AutoCAD Color Index.
 *
 * 1-9 and 250-255 are fixed by the standard; 10-249 are 24 hues (15° apart) x
 * 10 value/saturation steps, which is why they can be generated rather than
 * typed out. Generating them matters: a hand-picked corner of the index (the
 * previous 22 entries) collapsed every dark colour onto the grey ramp, so a
 * navy layer and a near-black layer both came out as ACI 250 and became
 * indistinguishable the moment the drawing was opened in CAD.
 */
const ACI_STEPS: Array<[number, number]> = [
  [255, 255],
  [255, 178],
  [189, 255],
  [189, 132],
  [129, 255],
  [129, 92],
  [104, 255],
  [104, 74],
  [79, 255],
  [79, 56],
];

function hsvToRgb(h: number, s: number, v: number): RgbColor {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const to255 = (n: number) => Math.max(0, Math.min(255, Math.round((n + m) * 255)));
  return { r: to255(r), g: to255(g), b: to255(b) };
}

function buildAci(): Array<{ i: number; c: RgbColor }> {
  const table: Array<{ i: number; c: RgbColor }> = [
    { i: 1, c: { r: 255, g: 0, b: 0 } },
    { i: 2, c: { r: 255, g: 255, b: 0 } },
    { i: 3, c: { r: 0, g: 255, b: 0 } },
    { i: 4, c: { r: 0, g: 255, b: 255 } },
    { i: 5, c: { r: 0, g: 0, b: 255 } },
    { i: 6, c: { r: 255, g: 0, b: 255 } },
    { i: 7, c: { r: 255, g: 255, b: 255 } },
    { i: 8, c: { r: 128, g: 128, b: 128 } },
    { i: 9, c: { r: 192, g: 192, b: 192 } },
  ];
  for (let hue = 0; hue < 24; hue++) {
    for (let step = 0; step < ACI_STEPS.length; step++) {
      const [value, sat] = ACI_STEPS[step];
      table.push({
        i: 10 + hue * 10 + step,
        c: hsvToRgb(hue * 15, sat / 255, value / 255),
      });
    }
  }
  for (const [i, g] of [
    [250, 51],
    [251, 91],
    [252, 132],
    [253, 173],
    [254, 214],
    [255, 255],
  ] as Array<[number, number]>) {
    table.push({ i, c: { r: g, g, b: g } });
  }
  return table;
}

const ACI = buildAci();

/**
 * Nearest ACI index, never reusing one already handed to a different colour.
 *
 * R12 entity colours are indices, so two layers sharing an index are the same
 * colour to every reader — the palette silently loses a colour on export. When
 * the best match is taken, the next-best free index is used instead.
 */
function nearestAci(color: RgbColor, taken?: Set<number>): number {
  let best = 7;
  let bestD = Infinity;
  for (const entry of ACI) {
    if (taken?.has(entry.i)) continue;
    const d =
      (entry.c.r - color.r) ** 2 + (entry.c.g - color.g) ** 2 + (entry.c.b - color.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = entry.i;
    }
  }
  taken?.add(best);
  return best;
}

const layerNameFor = (fill: string) => `C_${fill.replace('#', '').toUpperCase()}`;

/**
 * DXF group code / value pair. Real values always carry a decimal point, and
 * never more digits than the geometry has: the SVG this is converted from is
 * written to two decimals, so a fixed four-decimal format was spending two
 * characters per coordinate on zeros — about 12 % of a large drawing.
 */
function pair(out: string[], code: number, value: string | number): void {
  out.push(String(code));
  out.push(typeof value === 'number' ? real(value) : value);
}

function real(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  const s = value.toFixed(4).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

export interface DxfOptions {
  /** Chord tolerance used when flattening curves into vertices. */
  flattenTolerance?: number;
  /**
   * How curved geometry travels (REFERENCE E "DXF lines-vs-splines variants").
   * `splines` (default) keeps it as SPLINE entities in an R2000 drawing;
   * `lines` flattens it into POLYLINE vertices in an R12 drawing.
   */
  curves?: 'splines' | 'lines';
}

/**
 * The control points of a subpath as one chain of cubic Béziers: `3k+1` points
 * for `k` segments, which is exactly a degree-3 B-spline with Bézier knots.
 *
 * Quadratics are promoted exactly (a Q is a C with both handles two thirds of
 * the way to the control point), and so are straight segments — a cubic whose
 * handles sit at a third and two thirds of the chord *is* that straight line,
 * to the last bit. That matters for economy: an outline that alternates a
 * corner-to-corner line with a curve would otherwise be chopped into dozens of
 * entities, each paying for its own header, and the drawing would be a pile of
 * fragments instead of one contour. A subpath with no curve in it at all never
 * gets here — it stays a POLYLINE (see `resultToDxf`), so nothing that is
 * genuinely straight is ever described as a curve.
 */
function cubicChainOf(sp: SubPath): Array<[number, number]> {
  const points: Array<[number, number]> = [[sp.x, sp.y]];
  let cx = sp.x;
  let cy = sp.y;
  const lineTo = (x: number, y: number): void => {
    points.push(
      [cx + (x - cx) / 3, cy + (y - cy) / 3],
      [cx + (2 * (x - cx)) / 3, cy + (2 * (y - cy)) / 3],
      [x, y],
    );
  };
  for (const seg of sp.segments) {
    if (seg.t === 'L') {
      lineTo(seg.x, seg.y);
    } else if (seg.t === 'C') {
      points.push([seg.c1x, seg.c1y], [seg.c2x, seg.c2y], [seg.x, seg.y]);
    } else {
      points.push(
        [cx + (2 / 3) * (seg.cx - cx), cy + (2 / 3) * (seg.cy - cy)],
        [seg.x + (2 / 3) * (seg.cx - seg.x), seg.y + (2 / 3) * (seg.cy - seg.y)],
        [seg.x, seg.y],
      );
    }
    cx = seg.x;
    cy = seg.y;
  }
  if (sp.closed && (Math.abs(cx - sp.x) > 1e-9 || Math.abs(cy - sp.y) > 1e-9)) {
    lineTo(sp.x, sp.y);
  }
  return points;
}

/** True when a subpath is a polygon — no curve anywhere in it. */
const isPolygon = (sp: SubPath): boolean => sp.segments.every((seg) => seg.t === 'L');

export function resultToDxf(result: VectorizeResult, options: DxfOptions = {}): string {
  const parsed = parseSvgShapes(result.svg);
  const height = result.height || parsed.height;
  const tolerance = options.flattenTolerance ?? 0.15;
  const splines = (options.curves ?? 'splines') === 'splines';
  /** R2000 numbers every entity and table record; R12 numbers nothing. */
  let nextHandle = 0x100;
  const handle = (out: string[]): void => {
    if (splines) pair(out, 5, (nextHandle++).toString(16).toUpperCase());
  };
  const subclass = (out: string[], ...names: string[]): void => {
    if (splines) for (const name of names) pair(out, 100, name);
  };

  const shapes = parsed.shapes;
  const bounds = boundsOf(shapes);
  const hasGeometry = shapes.length > 0 && bounds.maxX > bounds.minX;
  const extMin = hasGeometry ? { x: bounds.minX, y: height - bounds.maxY } : { x: 0, y: 0 };
  const extMax = hasGeometry
    ? { x: bounds.maxX, y: height - bounds.minY }
    : { x: result.width, y: result.height };

  // Stable layer order: first appearance in the SVG (background first).
  const layers: string[] = [];
  for (const shape of shapes) {
    const name = layerNameFor(shape.fill);
    if (!layers.includes(name)) layers.push(name);
  }

  // --- TABLES (layer per colour) -------------------------------------------
  const tables: string[] = [];
  pair(tables, 0, 'SECTION');
  pair(tables, 2, 'TABLES');
  pair(tables, 0, 'TABLE');
  pair(tables, 2, 'LAYER');
  handle(tables);
  subclass(tables, 'AcDbSymbolTable');
  pair(tables, 70, String(layers.length + 1));
  const layerRecord = (name: string, aci: number): void => {
    pair(tables, 0, 'LAYER');
    handle(tables);
    subclass(tables, 'AcDbSymbolTableRecord', 'AcDbLayerTableRecord');
    pair(tables, 2, name);
    pair(tables, 70, '0');
    pair(tables, 62, String(aci));
    pair(tables, 6, 'CONTINUOUS');
  };
  layerRecord('0', 7);
  const aciOf = new Map<string, number>();
  const takenAci = new Set<number>();
  for (const name of layers) {
    const rgb = parseHex(name.slice(2)) ?? { r: 0, g: 0, b: 0 };
    const aci = nearestAci(rgb, takenAci);
    aciOf.set(name, aci);
    layerRecord(name, aci);
  }
  pair(tables, 0, 'ENDTAB');
  pair(tables, 0, 'ENDSEC');

  // --- ENTITIES -------------------------------------------------------------
  const body: string[] = [];
  pair(body, 0, 'SECTION');
  pair(body, 2, 'ENTITIES');
  let entities = 0;
  /** Entity header shared by every entity: handle, class, layer, colour. */
  const startEntity = (name: string, layer: string, aci: number): void => {
    pair(body, 0, name);
    handle(body);
    subclass(body, 'AcDbEntity');
    pair(body, 8, layer);
    pair(body, 62, String(aci));
  };

  const polyline = (
    points: Array<[number, number]>,
    layer: string,
    aci: number,
    closed: boolean,
    strokeWidth: number,
  ): void => {
    if (points.length < 2) return;
    startEntity('POLYLINE', layer, aci);
    subclass(body, 'AcDb2dPolyline');
    pair(body, 66, '1'); // vertices follow
    pair(body, 70, closed ? '1' : '0'); // bit 1 = closed polyline
    if (strokeWidth > 0) {
      // Sub-pixel contours have no area; their width is the whole shape, so it
      // has to travel as the polyline's default start/end width.
      pair(body, 40, strokeWidth);
      pair(body, 41, strokeWidth);
    }
    pair(body, 10, 0);
    pair(body, 20, 0);
    pair(body, 30, 0);
    for (const [px, py] of points) {
      pair(body, 0, 'VERTEX');
      handle(body);
      subclass(body, 'AcDbEntity');
      pair(body, 8, layer);
      subclass(body, 'AcDbVertex', 'AcDb2dVertex');
      pair(body, 10, px);
      pair(body, 20, height - py);
      pair(body, 30, 0);
    }
    pair(body, 0, 'SEQEND');
    handle(body);
    subclass(body, 'AcDbEntity');
    pair(body, 8, layer);
    entities++;
  };

  /**
   * A run of k cubic Béziers as one degree-3 SPLINE.
   *
   * The Bézier basis is the B-spline basis with interior knots of multiplicity
   * 3, so the control points go across untouched and the knot vector is
   * `0,0,0,0, 1,1,1, 2,2,2, ... k,k,k,k` — `nctrl + degree + 1` values, exactly
   * as the format requires. Nothing is resampled, so the DXF and the SVG are
   * the same curve rather than two approximations of it.
   */
  const spline = (points: Array<[number, number]>, layer: string, aci: number): void => {
    const k = (points.length - 1) / 3;
    if (!Number.isInteger(k) || k < 1) return;
    startEntity('SPLINE', layer, aci);
    subclass(body, 'AcDbSpline');
    pair(body, 70, '8'); // planar
    pair(body, 71, '3'); // degree
    pair(body, 72, String(3 * k + 5)); // knots
    pair(body, 73, String(points.length)); // control points
    pair(body, 74, '0'); // fit points
    for (let i = 0; i < 4; i++) pair(body, 40, 0);
    for (let i = 1; i < k; i++) for (let m = 0; m < 3; m++) pair(body, 40, i);
    for (let i = 0; i < 4; i++) pair(body, 40, k);
    for (const [px, py] of points) {
      pair(body, 10, px);
      pair(body, 20, height - py);
      pair(body, 30, 0);
    }
    entities++;
  };

  for (const shape of shapes) {
    const layer = layerNameFor(shape.fill);
    const aci = aciOf.get(layer) ?? 7;
    for (const sp of shape.subpaths) {
      // A stroked shape's width lives on the polyline, and SPLINE has nowhere
      // to put it — so the stroked result style (B6) stays on polylines.
      if (!splines || shape.strokeWidth > 0) {
        polyline(flattenSubPath(sp, tolerance), layer, aci, sp.closed, shape.strokeWidth);
        continue;
      }
      // A polygon is a polygon: one closed POLYLINE, no curve anywhere.
      if (isPolygon(sp)) {
        polyline(flattenSubPath(sp, tolerance), layer, aci, sp.closed, 0);
        continue;
      }
      spline(cubicChainOf(sp), layer, aci);
    }
  }
  if (entities === 0) {
    // Never emit an empty ENTITIES section — some readers reject it.
    pair(body, 0, 'LINE');
    handle(body);
    subclass(body, 'AcDbEntity');
    pair(body, 8, '0');
    subclass(body, 'AcDbLine');
    pair(body, 10, 0);
    pair(body, 20, 0);
    pair(body, 30, 0);
    pair(body, 11, result.width);
    pair(body, 21, 0);
    pair(body, 31, 0);
  }
  pair(body, 0, 'ENDSEC');

  // --- OBJECTS (R2000 wants a root dictionary) ------------------------------
  const objects: string[] = [];
  if (splines) {
    const root = (nextHandle++).toString(16).toUpperCase();
    const groups = (nextHandle++).toString(16).toUpperCase();
    pair(objects, 0, 'SECTION');
    pair(objects, 2, 'OBJECTS');
    pair(objects, 0, 'DICTIONARY');
    pair(objects, 5, root);
    pair(objects, 100, 'AcDbDictionary');
    pair(objects, 3, 'ACAD_GROUP');
    pair(objects, 350, groups);
    pair(objects, 0, 'DICTIONARY');
    pair(objects, 5, groups);
    pair(objects, 330, root);
    pair(objects, 100, 'AcDbDictionary');
    pair(objects, 0, 'ENDSEC');
  }

  // --- HEADER ---------------------------------------------------------------
  // Written last because $HANDSEED has to exceed every handle handed out above.
  const out: string[] = [];
  pair(out, 0, 'SECTION');
  pair(out, 2, 'HEADER');
  pair(out, 9, '$ACADVER');
  pair(out, 1, splines ? 'AC1015' : 'AC1009');
  if (splines) {
    pair(out, 9, '$HANDSEED');
    pair(out, 5, nextHandle.toString(16).toUpperCase());
  }
  pair(out, 9, '$INSBASE');
  pair(out, 10, 0);
  pair(out, 20, 0);
  pair(out, 30, 0);
  pair(out, 9, '$EXTMIN');
  pair(out, 10, extMin.x);
  pair(out, 20, extMin.y);
  pair(out, 30, 0);
  pair(out, 9, '$EXTMAX');
  pair(out, 10, extMax.x);
  pair(out, 20, extMax.y);
  pair(out, 30, 0);
  pair(out, 9, '$LIMMIN');
  pair(out, 10, extMin.x);
  pair(out, 20, extMin.y);
  pair(out, 9, '$LIMMAX');
  pair(out, 10, extMax.x);
  pair(out, 20, extMax.y);
  pair(out, 0, 'ENDSEC');

  return [...out, ...tables, ...body, ...objects, '0', 'EOF'].join('\n') + '\n';
}
