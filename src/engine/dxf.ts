/**
 * DXF writer — REFERENCE D3.
 *
 * Geometry-level conversion: shapes are recovered from the result's SVG and
 * re-emitted as R12 (AC1009) ASCII DXF. R12 is the most widely readable DXF
 * dialect — CAD packages, laser/vinyl cutters and `ezdxf` all take it without
 * complaint — and its `POLYLINE`/`VERTEX`/`SEQEND` triple is the entity every
 * reader implements.
 *
 * Conventions:
 *   - 1 source pixel = 1 drawing unit.
 *   - DXF is y-up, SVG is y-down, so y is mirrored about the artwork height.
 *   - One LAYER per palette colour, named `C_RRGGBB` so the exact colour
 *     survives even though R12 entity colours are ACI indices, not RGB.
 *   - Bézier segments are flattened to vertices; R12 has no spline entity.
 */

import { parseHex } from './color';
import { boundsOf, flattenSubPath, parseSvgShapes } from './path';
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

/** DXF group code / value pair. Values always carry a decimal point when real. */
function pair(out: string[], code: number, value: string | number): void {
  out.push(String(code));
  out.push(typeof value === 'number' ? value.toFixed(4) : value);
}

export interface DxfOptions {
  /** Chord tolerance used when flattening curves into vertices. */
  flattenTolerance?: number;
}

export function resultToDxf(result: VectorizeResult, options: DxfOptions = {}): string {
  const parsed = parseSvgShapes(result.svg);
  const height = result.height || parsed.height;
  const tolerance = options.flattenTolerance ?? 0.15;

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

  const out: string[] = [];

  // --- HEADER ---------------------------------------------------------------
  pair(out, 0, 'SECTION');
  pair(out, 2, 'HEADER');
  pair(out, 9, '$ACADVER');
  pair(out, 1, 'AC1009');
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

  // --- TABLES (layer per colour) -------------------------------------------
  pair(out, 0, 'SECTION');
  pair(out, 2, 'TABLES');
  pair(out, 0, 'TABLE');
  pair(out, 2, 'LAYER');
  pair(out, 70, String(layers.length + 1));
  pair(out, 0, 'LAYER');
  pair(out, 2, '0');
  pair(out, 70, '0');
  pair(out, 62, '7');
  pair(out, 6, 'CONTINUOUS');
  const aciOf = new Map<string, number>();
  const takenAci = new Set<number>();
  for (const name of layers) {
    const rgb = parseHex(name.slice(2)) ?? { r: 0, g: 0, b: 0 };
    const aci = nearestAci(rgb, takenAci);
    aciOf.set(name, aci);
    pair(out, 0, 'LAYER');
    pair(out, 2, name);
    pair(out, 70, '0');
    pair(out, 62, String(aci));
    pair(out, 6, 'CONTINUOUS');
  }
  pair(out, 0, 'ENDTAB');
  pair(out, 0, 'ENDSEC');

  // --- ENTITIES -------------------------------------------------------------
  pair(out, 0, 'SECTION');
  pair(out, 2, 'ENTITIES');
  let entities = 0;
  for (const shape of shapes) {
    const layer = layerNameFor(shape.fill);
    const aci = aciOf.get(layer) ?? 7;
    for (const sp of shape.subpaths) {
      const points = flattenSubPath(sp, tolerance);
      if (points.length < 2) continue;
      pair(out, 0, 'POLYLINE');
      pair(out, 8, layer);
      pair(out, 62, String(aci));
      pair(out, 66, '1'); // vertices follow
      pair(out, 70, sp.closed ? '1' : '0'); // bit 1 = closed polyline
      if (shape.strokeWidth > 0) {
        // Sub-pixel contours have no area; their width is the whole shape, so
        // it has to travel as the polyline's default start/end width.
        pair(out, 40, shape.strokeWidth);
        pair(out, 41, shape.strokeWidth);
      }
      pair(out, 10, 0);
      pair(out, 20, 0);
      pair(out, 30, 0);
      for (const [px, py] of points) {
        pair(out, 0, 'VERTEX');
        pair(out, 8, layer);
        pair(out, 10, px);
        pair(out, 20, height - py);
        pair(out, 30, 0);
      }
      pair(out, 0, 'SEQEND');
      pair(out, 8, layer);
      entities++;
    }
  }
  if (entities === 0) {
    // Never emit an empty ENTITIES section — some readers reject it.
    pair(out, 0, 'LINE');
    pair(out, 8, '0');
    pair(out, 10, 0);
    pair(out, 20, 0);
    pair(out, 30, 0);
    pair(out, 11, result.width);
    pair(out, 21, 0);
    pair(out, 31, 0);
  }
  pair(out, 0, 'ENDSEC');

  pair(out, 0, 'EOF');
  return out.join('\n') + '\n';
}
