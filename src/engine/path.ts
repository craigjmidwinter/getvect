/**
 * The geometry model shared by the SVG writer and the EPS/DXF converters.
 *
 * `vectorize()` returns an SVG string (that is the contract — the preview and
 * the SVG export must be the *same* document, REFERENCE C3/D1). The EPS and DXF
 * converters therefore recover geometry by parsing that SVG back into these
 * structures. The parser only has to understand the subset this module emits:
 * `<rect>` plus `<path>` with absolute `M`/`L`/`Q`/`C`/`Z` commands.
 */

import { circleSubPath } from './fit';

export type Segment =
  | { t: 'L'; x: number; y: number }
  | { t: 'Q'; cx: number; cy: number; x: number; y: number }
  | { t: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number };

export interface SubPath {
  /** Start point. */
  x: number;
  y: number;
  segments: Segment[];
  closed: boolean;
}

export interface Shape {
  /** `#rrggbb` or `rgb(r, g, b)` — the paint colour, whichever role it plays. */
  fill: string;
  /**
   * Outline width, or 0. The stroked result style (REFERENCE B6) draws every
   * colour layer as an outline; every export format has to carry that width or
   * the stroked document converts to an empty page.
   */
  strokeWidth: number;
  /**
   * True when the shape is outline-only (`fill="none"`), so the converters
   * stroke it instead of filling it.
   */
  unfilled?: boolean;
  subpaths: SubPath[];
}

export interface ParsedSvg {
  width: number;
  height: number;
  shapes: Shape[];
}

/** Format a number with at most `precision` decimals, no trailing zeros. */
export function num(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0';
  const factor = 10 ** precision;
  let v = Math.round(value * factor) / factor;
  if (Object.is(v, -0)) v = 0;
  let s = v.toFixed(precision);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Serialize subpaths into a compact `d` attribute.
 *
 * Two compactions, both of them standard SVG (a third — dropping a repeated
 * command letter — is deliberately NOT done; see `letter` below):
 *   - axis-aligned lines become `h`/`v`, which is most of a traced contour;
 *   - a leading `-` is its own separator, so no space precedes it;
 *   - coordinates are relative (`m`/`l`/`q`/`c`), which on traced artwork is a
 *     large win — deltas along a contour are single digits where absolute
 *     coordinates need three or four.
 *
 * Relative output is emitted drift-free: each delta is measured from the
 * *rounded* point actually written, never from the ideal one, so rounding error
 * cannot accumulate along a long contour.
 */
export function toPathData(subpaths: SubPath[], precision: number, relative = true): string {
  const factor = 10 ** precision;
  const snap = (v: number) => Math.round(v * factor) / factor;

  let out = '';
  let cmd = '';
  let needSep = false;
  let cx = 0;
  let cy = 0;
  let started = false;

  // Every segment states its command letter.
  //
  // SVG lets a repeated command drop the letter (`L1 2L3 4` → `L1 2 3 4`), and
  // an earlier version of this writer did. It saves about a byte per segment
  // and costs something worth more: a document where the number of curves can
  // no longer be counted. `instruments/lib/metrics.mjs` — and any reader
  // eyeballing the file — counts command letters, so eliding them makes a
  // staircase of a thousand `l` segments look like a handful of commands. The
  // reference product's own output spells every command out too.
  const letter = (l: string) => {
    out += l;
    cmd = l;
    needSep = false;
  };
  const value = (v: number) => {
    const s = num(v, precision);
    if (needSep && s.charCodeAt(0) !== 45 /* '-' */) out += ' ';
    out += s;
    needSep = true;
  };

  for (const sp of subpaths) {
    if (sp.segments.length === 0) continue;
    const sx = snap(sp.x);
    const sy = snap(sp.y);
    if (relative && started) {
      letter('m');
      value(sx - cx);
      value(sy - cy);
    } else {
      letter('M');
      value(sx);
      value(sy);
    }
    started = true;
    cx = sx;
    cy = sy;

    for (const seg of sp.segments) {
      const ex = snap(seg.x);
      const ey = snap(seg.y);
      if (seg.t === 'L') {
        // Traced contours run along pixel edges, so most segments are axis
        // aligned and `h`/`v` halve their cost.
        if (ex === cx && ey === cy) continue; // zero-length: pure noise in the output
        if (ey === cy) {
          letter(relative ? 'h' : 'H');
          value(relative ? ex - cx : ex);
        } else if (ex === cx) {
          letter(relative ? 'v' : 'V');
          value(relative ? ey - cy : ey);
        } else {
          letter(relative ? 'l' : 'L');
          value(relative ? ex - cx : ex);
          value(relative ? ey - cy : ey);
        }
      } else if (seg.t === 'Q') {
        const qx = snap(seg.cx);
        const qy = snap(seg.cy);
        letter(relative ? 'q' : 'Q');
        value(relative ? qx - cx : qx);
        value(relative ? qy - cy : qy);
        value(relative ? ex - cx : ex);
        value(relative ? ey - cy : ey);
      } else {
        const a1 = snap(seg.c1x);
        const a2 = snap(seg.c1y);
        const b1 = snap(seg.c2x);
        const b2 = snap(seg.c2y);
        letter(relative ? 'c' : 'C');
        value(relative ? a1 - cx : a1);
        value(relative ? a2 - cy : a2);
        value(relative ? b1 - cx : b1);
        value(relative ? b2 - cy : b2);
        value(relative ? ex - cx : ex);
        value(relative ? ey - cy : ey);
      }
      cx = ex;
      cy = ey;
    }

    if (sp.closed) {
      out += 'Z';
      cmd = '';
      needSep = false;
      // After a closepath the current point returns to the subpath's start.
      cx = sx;
      cy = sy;
    }
  }
  return out;
}

/** Bounding box of a set of shapes, curve control points included. */
export function boundsOf(shapes: Shape[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const hit = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (const shape of shapes) {
    for (const sp of shape.subpaths) {
      hit(sp.x, sp.y);
      for (const seg of sp.segments) hit(seg.x, seg.y);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Quadratic Bézier → cubic (PostScript has no quadratic operator). */
export function quadToCubic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
): { c1x: number; c1y: number; c2x: number; c2y: number } {
  return {
    c1x: x0 + (2 / 3) * (cx - x0),
    c1y: y0 + (2 / 3) * (cy - y0),
    c2x: x1 + (2 / 3) * (cx - x1),
    c2y: y1 + (2 / 3) * (cy - y1),
  };
}

/**
 * Flatten a subpath into a polyline. Curves are sampled proportionally to their
 * control-polygon length so long sweeps stay smooth and short ones stay cheap.
 */
export function flattenSubPath(sp: SubPath, tolerance = 0.2): Array<[number, number]> {
  const pts: Array<[number, number]> = [[sp.x, sp.y]];
  let cx = sp.x;
  let cy = sp.y;
  for (const seg of sp.segments) {
    if (seg.t === 'L') {
      pts.push([seg.x, seg.y]);
      cx = seg.x;
      cy = seg.y;
      continue;
    }
    const cubic =
      seg.t === 'C'
        ? { c1x: seg.c1x, c1y: seg.c1y, c2x: seg.c2x, c2y: seg.c2y }
        : quadToCubic(cx, cy, seg.cx, seg.cy, seg.x, seg.y);
    const polyLen =
      Math.hypot(cubic.c1x - cx, cubic.c1y - cy) +
      Math.hypot(cubic.c2x - cubic.c1x, cubic.c2y - cubic.c1y) +
      Math.hypot(seg.x - cubic.c2x, seg.y - cubic.c2y);
    const steps = Math.max(2, Math.min(32, Math.ceil(Math.sqrt(polyLen / Math.max(tolerance, 0.01)))));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      pts.push([
        a * cx + b * cubic.c1x + c * cubic.c2x + d * seg.x,
        a * cy + b * cubic.c1y + c * cubic.c2y + d * seg.y,
      ]);
    }
    cx = seg.x;
    cy = seg.y;
  }
  // Drop consecutive duplicates — DXF readers dislike zero-length segments.
  const out: Array<[number, number]> = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - p[0]) < 1e-9 && Math.abs(prev[1] - p[1]) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing back out of the SVG we produced
// ---------------------------------------------------------------------------

const ATTR = (source: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return m ? m[1] : null;
};

/**
 * Recover shapes from a GetVect SVG. Deliberately narrow: it understands the
 * exact subset `renderSvg()` emits rather than pretending to be a general SVG
 * parser.
 */
export function parseSvgShapes(svg: string): ParsedSvg {
  const viewBox = /viewBox="\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
  const width = viewBox ? Number(viewBox[1]) : Number(ATTR(svg, 'width') ?? 0);
  const height = viewBox ? Number(viewBox[2]) : Number(ATTR(svg, 'height') ?? 0);

  const shapes: Shape[] = [];
  // `<g fill="…">` layers carry the colour for the paths inside them (that is
  // the structure renderSvg emits, and the one the reference product emits), so
  // the walk keeps a stack of inherited fills rather than looking at each
  // element in isolation.
  const groupFills: Array<string | null> = [];
  // The stroked result style (B6) states the colour as the group's `stroke`
  // with `fill="none"`, so the walk tracks both roles.
  const groupStrokes: Array<{ color: string | null; width: number }> = [];
  const inherited = (): string | null => {
    for (let i = groupFills.length - 1; i >= 0; i--) {
      if (groupFills[i]) return groupFills[i];
    }
    return null;
  };
  const inheritedStroke = (): { color: string | null; width: number } => {
    for (let i = groupStrokes.length - 1; i >= 0; i--) {
      if (groupStrokes[i].color) return groupStrokes[i];
    }
    return { color: null, width: 0 };
  };

  const elements = svg.match(/<\/?(g|rect|path|circle)\b[^>]*\/?>/g) ?? [];
  for (const el of elements) {
    if (el.startsWith('</g')) {
      groupFills.pop();
      groupStrokes.pop();
      continue;
    }
    if (el.startsWith('<g')) {
      // A self-closing `<g/>` opens nothing.
      if (!el.endsWith('/>')) {
        groupFills.push(normalizeFill(ATTR(el, 'fill')));
        groupStrokes.push({
          color: normalizeFill(ATTR(el, 'stroke')),
          width: Number(ATTR(el, 'stroke-width') ?? 0) || 0,
        });
      }
      continue;
    }
    // An explicit `fill="none"` means "not filled", not "ask the group".
    const own = ATTR(el, 'fill');
    const fill = own !== null ? normalizeFill(own) : inherited();
    if (!fill) {
      // Outline-only geometry still has to reach EPS/DXF/PDF (REFERENCE B6).
      const outline = inheritedStroke();
      const ownStroke = normalizeFill(ATTR(el, 'stroke'));
      const color = ownStroke ?? outline.color;
      if (!color) continue;
      const width = Number(ATTR(el, 'stroke-width') ?? outline.width) || outline.width || 1;
      if (el.startsWith('<circle')) {
        const sp = circleSubPathOf(el);
        if (sp) shapes.push({ fill: color, strokeWidth: width, unfilled: true, subpaths: [sp] });
        continue;
      }
      const d = ATTR(el, 'd');
      if (!d) continue;
      const subpaths = parsePathData(d);
      if (!subpaths.length) continue;
      shapes.push({ fill: color, strokeWidth: width, unfilled: true, subpaths });
      continue;
    }
    if (el.startsWith('<circle')) {
      const sp = circleSubPathOf(el);
      if (sp) shapes.push({ fill, strokeWidth: 0, subpaths: [sp] });
      continue;
    }
    if (el.startsWith('<rect')) {
      const x = Number(ATTR(el, 'x') ?? 0);
      const y = Number(ATTR(el, 'y') ?? 0);
      const w = Number(ATTR(el, 'width') ?? 0);
      const h = Number(ATTR(el, 'height') ?? 0);
      if (!(w > 0 && h > 0)) continue;
      shapes.push({
        fill,
        strokeWidth: 0,
        subpaths: [
          {
            x,
            y,
            closed: true,
            segments: [
              { t: 'L', x: x + w, y },
              { t: 'L', x: x + w, y: y + h },
              { t: 'L', x, y: y + h },
            ],
          },
        ],
      });
      continue;
    }
    const d = ATTR(el, 'd');
    if (!d) continue;
    const subpaths = parsePathData(d);
    if (!subpaths.length) continue;
    const stroked = normalizeFill(ATTR(el, 'stroke')) !== null;
    const strokeWidth = stroked ? Number(ATTR(el, 'stroke-width') ?? 0) : 0;
    shapes.push({
      fill,
      strokeWidth: Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 0,
      subpaths,
    });
  }
  return { width, height, shapes };
}

/**
 * `<circle>` → four cubic quarter-arcs.
 *
 * Circle Detection (REFERENCE B5) emits real `<circle>` elements, and every
 * export format is generated by parsing the SVG back (C3), so the converters
 * would silently drop those shapes if this did not exist.
 */
function circleSubPathOf(el: string): SubPath | null {
  const cx = Number(ATTR(el, 'cx') ?? 0);
  const cy = Number(ATTR(el, 'cy') ?? 0);
  const r = Number(ATTR(el, 'r') ?? 0);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(r > 0)) return null;
  return circleSubPath({ cx, cy, r });
}

function normalizeFill(fill: string | null): string | null {
  if (!fill) return null;
  const trimmed = fill.trim().toLowerCase();
  if (trimmed === 'none' || trimmed === 'transparent') return null;
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
  }
  // `rgb(r,g,b)` is what the reference product itself writes, so accepting it lets the
  // converters read reference exemplars as well as our own output.
  const rgb = /^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)$/.exec(trimmed);
  if (rgb) {
    const hex = (v: string) =>
      Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0');
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
  }
  return null;
}

/** Absolute M/L/H/V/Q/C/Z path-data parser (the subset this engine writes). */
export function parsePathData(d: string): SubPath[] {
  const tokens = d.match(/[MLHVQCZmlhvqcz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const subpaths: SubPath[] = [];
  let current: SubPath | null = null;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let i = 0;
  const next = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[MLHVQCZmlhvqcz]$/.test(tok)) {
      cmd = tok;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (current) {
          current.closed = true;
          subpaths.push(current);
          current = null;
        }
        x = sx;
        y = sy;
        continue;
      }
    }
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'M') {
      const nx = next();
      const ny = next();
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      if (current && current.segments.length) subpaths.push(current);
      current = { x, y, segments: [], closed: false };
      sx = x;
      sy = y;
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const nx = next();
      const ny = next();
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      current?.segments.push({ t: 'L', x, y });
    } else if (C === 'H') {
      const nx = next();
      x = rel ? x + nx : nx;
      current?.segments.push({ t: 'L', x, y });
    } else if (C === 'V') {
      const ny = next();
      y = rel ? y + ny : ny;
      current?.segments.push({ t: 'L', x, y });
    } else if (C === 'Q') {
      const c1 = next();
      const c2 = next();
      const nx = next();
      const ny = next();
      const qcx = rel ? x + c1 : c1;
      const qcy = rel ? y + c2 : c2;
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      current?.segments.push({ t: 'Q', cx: qcx, cy: qcy, x, y });
    } else if (C === 'C') {
      const a1 = next();
      const a2 = next();
      const b1 = next();
      const b2 = next();
      const nx = next();
      const ny = next();
      const c1x = rel ? x + a1 : a1;
      const c1y = rel ? y + a2 : a2;
      const c2x = rel ? x + b1 : b1;
      const c2y = rel ? y + b2 : b2;
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      current?.segments.push({ t: 'C', c1x, c1y, c2x, c2y, x, y });
    } else {
      break;
    }
  }
  if (current && current.segments.length) subpaths.push(current);
  return subpaths;
}
