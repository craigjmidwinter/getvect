/**
 * SVG serialization. The string produced here is *the* deliverable: it is what
 * the preview renders and what the SVG export writes, byte for byte
 * (REFERENCE C3/D1).
 */

import { hexOf } from './color';
import { num, toPathData, type Shape } from './path';
import { STROKE_BANDS, type TracedLayer } from './trace';
import type { RgbColor } from './types';

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
   * the dominant colour here rather than white. `-1` disables the optimisation.
   */
  backgroundIndex: number;
  /**
   * Multiplier on the tracer's per-band stroke compensation (see `STROKE_BANDS`
   * in trace.ts). 1 applies it as designed; 0 disables it entirely.
   */
  strokeScale: number;
}

export interface RenderedSvg {
  svg: string;
  pathCount: number;
  shapes: Shape[];
}

export function renderSvg(
  layers: TracedLayer[],
  palette: RgbColor[],
  options: RenderOptions,
): RenderedSvg {
  const { width, height, precision, backgroundIndex, strokeScale } = options;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}">`,
  );

  const shapes: Shape[] = [];

  if (backgroundIndex >= 0 && palette[backgroundIndex]) {
    const fill = hexOf(palette[backgroundIndex]);
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
  for (const layer of layers) {
    if (layer.colorIndex === backgroundIndex) continue;
    const color = palette[layer.colorIndex];
    if (!color) continue;
    const fill = hexOf(color);

    // Widest band first: the big shapes go down before the small ones that sit
    // on top of them, which is also the order a person would paint them in.
    //
    // All of a colour's paths live inside one `<g fill="…">`, which is how the
    // reference product structures its output (REFERENCE D1: "per-color
    // `<g fill=...>` layers"). The colour is stated once per layer instead of
    // once per path, and a consumer that wants to hide/recolour a whole colour
    // layer — Illustrator, Inkscape, a laser cutter's job list — gets it as a
    // single addressable group.
    const layerParts: string[] = [];
    for (let band = layer.bands.length - 1; band >= 0; band--) {
      const subpaths = layer.bands[band];
      if (subpaths.length === 0) continue;
      const d = toPathData(subpaths, precision);
      if (!d) continue;
      const stroke = STROKE_BANDS[band].stroke * strokeScale;
      // Stroke width is per band, so it cannot be hoisted onto the group; the
      // stroke *colour* is the group's fill and is inherited.
      const strokeAttrs =
        stroke > 0
          ? ` stroke="${fill}" stroke-width="${num(stroke, 3)}"` +
            ' stroke-linejoin="round" stroke-linecap="round"'
          : '';
      layerParts.push(`<path fill-rule="evenodd"${strokeAttrs} d="${d}"/>`);
      pathCount++;
      shapes.push({ fill, strokeWidth: stroke, subpaths });
    }
    if (layerParts.length > 0) {
      parts.push(`<g fill="${fill}">`, ...layerParts, '</g>');
    }
  }

  parts.push('</svg>');
  return { svg: parts.join(''), pathCount, shapes };
}
