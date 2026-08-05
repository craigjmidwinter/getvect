/**
 * SVG serialization. The string produced here is *the* deliverable: it is what
 * the preview renders and what the SVG export writes, byte for byte
 * (REFERENCE C3/D1).
 */

import { rgbOf } from './color';
import { circleSubPath } from './fit';
import { num, toPathData, type Shape } from './path';
import type { TracedLayer } from './trace';
import type { ResultStyle, RgbColor } from './types';

export interface RenderOptions {
  width: number;
  height: number;
  /** Decimal places kept in path data. */
  precision: number;
  /**
   * Palette index painted as a full-canvas backdrop instead of a traced layer.
   *
   * The traced layers partition the canvas exactly, so painting the most
   * common colour as a `<rect>` and then skipping its (usually most complex)
   * outline is lossless and much cheaper. It also fixes the seam problem:
   * neighbouring layers share a border, and where antialiasing splits a pixel
   * between them the leftover coverage blends into whatever is underneath —
   * the dominant colour here rather than white. `-1` disables the optimisation,
   * which is what a disabled background colour (REFERENCE B3) and the stroked
   * result style (B6) both need.
   */
  backgroundIndex: number;
  /** Filled layers (default) or stroked outlines (REFERENCE B6). */
  resultStyle: ResultStyle;
  /** Stroke width used by the stroked result style. */
  strokeWidth: number;
}

export interface RenderedSvg {
  svg: string;
  pathCount: number;
  /**
   * The geometry as it went out, for callers that would otherwise re-parse the
   * document. The exporters deliberately do NOT use this: they parse the SVG
   * (src/engine/path.ts) so that what they convert is provably the same
   * document the preview shows (REFERENCE C3).
   */
  shapes: Shape[];
}

export function renderSvg(
  layers: TracedLayer[],
  palette: RgbColor[],
  options: RenderOptions,
): RenderedSvg {
  const { width, height, precision, backgroundIndex, resultStyle, strokeWidth } = options;
  const stroked = resultStyle === 'stroked';
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}">`,
  );

  const shapes: Shape[] = [];

  if (backgroundIndex >= 0 && palette[backgroundIndex]) {
    const fill = rgbOf(palette[backgroundIndex]);
    parts.push(`<g fill="${fill}"><rect width="${width}" height="${height}"/></g>`);
    shapes.push({
      fill,
      strokeWidth: 0,
      subpaths: [
        {
          x: 0,
          y: 0,
          closed: true,
          segments: [
            { t: 'L', x: width, y: 0 },
            { t: 'L', x: width, y: height },
            { t: 'L', x: 0, y: height },
          ],
        },
      ],
    });
  }

  let pathCount = 0;
  // `layers` arrives in paint order — bottom first (see `order` in index.ts).
  for (const layer of layers) {
    if (layer.colorIndex === backgroundIndex) continue;
    const color = palette[layer.colorIndex];
    if (!color) continue;
    if (layer.subpaths.length === 0 && layer.circles.length === 0) continue;
    const d = toPathData(layer.subpaths, precision);
    if (!d && layer.circles.length === 0) continue;

    // All of a colour's paths live inside one `<g fill="…">`, which is how the
    // reference product structures its output (REFERENCE D1: "per-color
    // `<g fill="rgb(...)">` layers"). The colour is stated once per layer
    // instead of once per path, and a consumer that wants to hide/recolour a
    // whole colour layer — Illustrator, Inkscape, a laser cutter's job list —
    // gets it as a single addressable group.
    const paint = rgbOf(color);
    const groupAttrs = stroked
      ? `fill="none" stroke="${paint}" stroke-width="${num(strokeWidth, 3)}" ` +
        'stroke-linejoin="round" stroke-linecap="round"'
      : `fill="${paint}"`;
    const body: string[] = [];
    if (d) {
      body.push(`<path fill-rule="evenodd" d="${d}"/>`);
      pathCount++;
      shapes.push({
        fill: paint,
        strokeWidth: stroked ? strokeWidth : 0,
        subpaths: layer.subpaths,
        unfilled: stroked,
      });
    }
    // Circle Detection (REFERENCE B5) emits real `<circle>` elements: a reader
    // — and a downstream CAD/cutter tool — gets a circle, not a polygon that
    // happens to look round. A ring is the same element with a stroke.
    for (const circle of layer.circles) {
      const ring = circle.strokeWidth > 0;
      const attrs =
        `cx="${num(circle.cx, precision)}" cy="${num(circle.cy, precision)}" ` +
        `r="${num(circle.r, precision)}"`;
      if (stroked || ring) {
        const w = stroked ? strokeWidth : circle.strokeWidth;
        body.push(`<circle ${attrs} fill="none" stroke="${paint}" stroke-width="${num(w, 3)}"/>`);
      } else {
        body.push(`<circle ${attrs}/>`);
      }
      shapes.push({
        fill: paint,
        strokeWidth: stroked ? strokeWidth : circle.strokeWidth,
        unfilled: stroked || ring,
        subpaths: [circleSubPath(circle)],
      });
    }
    parts.push(`<g ${groupAttrs}>`, ...body, '</g>');
  }

  parts.push('</svg>');
  return { svg: parts.join(''), pathCount, shapes };
}
