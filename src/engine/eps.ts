/**
 * EPS (Encapsulated PostScript) writer — REFERENCE D2.
 *
 * Geometry-level conversion: the traced shapes are recovered from the result's
 * SVG and re-emitted as PostScript path operators. Nothing is rasterized and
 * nothing is embedded; the output is editable vector art.
 *
 * Conventions:
 *   - 1 source pixel = 1 PostScript point, so `%%BoundingBox: 0 0 w h` matches
 *     the source dimensions exactly.
 *   - SVG's y-down space is mapped to PostScript's y-up space once, with
 *     `0 h translate / 1 -1 scale`, so path coordinates stay identical to the
 *     SVG (which keeps the two exports trivially diffable).
 *   - Fills use `eofill`, matching the `fill-rule="evenodd"` the SVG declares.
 */

import { parseHex } from './color';
import { num, parseSvgShapes, quadToCubic, type Shape } from './path';
import type { VectorizeResult } from './types';

const P = 3;

function colorOps(fill: string): string {
  const rgb = parseHex(fill) ?? { r: 0, g: 0, b: 0 };
  return `${num(rgb.r / 255, 4)} ${num(rgb.g / 255, 4)} ${num(rgb.b / 255, 4)} setrgbcolor`;
}

function shapeOps(shape: Shape, out: string[]): void {
  out.push(colorOps(shape.fill));
  out.push('newpath');
  for (const sp of shape.subpaths) {
    if (sp.segments.length === 0) continue;
    let cx = sp.x;
    let cy = sp.y;
    out.push(`${num(cx, P)} ${num(cy, P)} moveto`);
    for (const seg of sp.segments) {
      if (seg.t === 'L') {
        out.push(`${num(seg.x, P)} ${num(seg.y, P)} lineto`);
      } else if (seg.t === 'C') {
        out.push(
          `${num(seg.c1x, P)} ${num(seg.c1y, P)} ${num(seg.c2x, P)} ${num(seg.c2y, P)} ` +
            `${num(seg.x, P)} ${num(seg.y, P)} curveto`,
        );
      } else {
        const c = quadToCubic(cx, cy, seg.cx, seg.cy, seg.x, seg.y);
        out.push(
          `${num(c.c1x, P)} ${num(c.c1y, P)} ${num(c.c2x, P)} ${num(c.c2y, P)} ` +
            `${num(seg.x, P)} ${num(seg.y, P)} curveto`,
        );
      }
      cx = seg.x;
      cy = seg.y;
    }
    out.push('closepath');
  }
  if (shape.unfilled) {
    // Outline-only layer (REFERENCE B6): stroke it, do not fill it.
    out.push(`${num(shape.strokeWidth || 1, 3)} setlinewidth 1 setlinejoin 1 setlinecap`);
    out.push('stroke');
  } else if (shape.strokeWidth > 0) {
    // `eofill` consumes the path, so keep a copy to stroke afterwards. Without
    // this the sub-pixel contours (which have no area to fill) vanish.
    out.push('gsave');
    out.push('eofill');
    out.push('grestore');
    out.push(`${num(shape.strokeWidth, 3)} setlinewidth 1 setlinejoin 1 setlinecap`);
    out.push('stroke');
  } else {
    out.push('eofill');
  }
}

export function resultToEps(result: VectorizeResult, creator = 'GetVect'): string {
  const parsed = parseSvgShapes(result.svg);
  const width = Math.round(result.width || parsed.width);
  const height = Math.round(result.height || parsed.height);

  const body: string[] = [];
  for (const shape of parsed.shapes) shapeOps(shape, body);

  const lines: string[] = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%Creator: ${creator}`,
    '%%Title: vectorized artwork',
    `%%BoundingBox: 0 0 ${width} ${height}`,
    `%%HiResBoundingBox: 0 0 ${num(width, 1)} ${num(height, 1)}`,
    '%%LanguageLevel: 2',
    '%%Pages: 1',
    '%%DocumentData: Clean7Bit',
    '%%EndComments',
    '%%BeginProlog',
    '/gvsave save def',
    '%%EndProlog',
    '%%Page: 1 1',
    'gsave',
    `0 ${height} translate`,
    '1 -1 scale',
    ...body,
    'grestore',
    'showpage',
    '%%Trailer',
    'gvsave restore',
    '%%EOF',
    '',
  ];
  return lines.join('\n');
}
