/**
 * PDF writer — REFERENCE D5 ("PDF and PNG export options alongside SVG/EPS/DXF";
 * the reference product lists PDF under its vector downloads).
 *
 * Geometry-level conversion, like the EPS and DXF writers: the traced shapes are
 * recovered from the result's SVG and re-emitted as PDF path operators, so the
 * file is editable vector art rather than a wrapped bitmap.
 *
 * Conventions:
 *   - 1 source pixel = 1 PDF point, so `/MediaBox [0 0 w h]` matches the source
 *     dimensions exactly (a 512px artwork becomes a 512pt page).
 *   - PDF user space is y-up and SVG is y-down, so the whole content stream is
 *     wrapped in `1 0 0 -1 0 h cm` — path coordinates then stay byte-identical
 *     to the SVG's, which keeps the two exports trivially diffable.
 *   - Fills use `f*` (even-odd), matching the `fill-rule="evenodd"` the SVG
 *     declares. Sub-pixel contours carry the same stroke width the SVG gives
 *     them and are painted with `B*` (fill + stroke) so they survive.
 *
 * The document is written uncompressed with a correct classic `xref` table: a
 * compressed stream would save bytes but make the output unreadable by eye and
 * unverifiable by tests, and traced artwork is small either way.
 */

import { parseHex } from './color';
import { num, parseSvgShapes, quadToCubic, type Shape } from './path';
import type { VectorizeResult } from './types';

/** Decimals kept in path coordinates; matches the EPS writer. */
const P = 3;

function colorOps(fill: string, stroked: boolean): string[] {
  const rgb = parseHex(fill) ?? { r: 0, g: 0, b: 0 };
  const triple = `${num(rgb.r / 255, 4)} ${num(rgb.g / 255, 4)} ${num(rgb.b / 255, 4)}`;
  const ops = [`${triple} rg`];
  if (stroked) ops.push(`${triple} RG`);
  return ops;
}

function shapeOps(shape: Shape, out: string[]): void {
  const stroked = shape.strokeWidth > 0;
  const mark = out.length; // rollback point if the shape turns out to be empty
  out.push(...colorOps(shape.fill, stroked));
  if (stroked) out.push(`${num(shape.strokeWidth, 3)} w 1 J 1 j`);

  let emitted = false;
  for (const sp of shape.subpaths) {
    if (sp.segments.length === 0) continue;
    let cx = sp.x;
    let cy = sp.y;
    out.push(`${num(cx, P)} ${num(cy, P)} m`);
    for (const seg of sp.segments) {
      if (seg.t === 'L') {
        out.push(`${num(seg.x, P)} ${num(seg.y, P)} l`);
      } else {
        const c =
          seg.t === 'C'
            ? { c1x: seg.c1x, c1y: seg.c1y, c2x: seg.c2x, c2y: seg.c2y }
            : quadToCubic(cx, cy, seg.cx, seg.cy, seg.x, seg.y);
        out.push(
          `${num(c.c1x, P)} ${num(c.c1y, P)} ${num(c.c2x, P)} ${num(c.c2y, P)} ` +
            `${num(seg.x, P)} ${num(seg.y, P)} c`,
        );
      }
      cx = seg.x;
      cy = seg.y;
    }
    out.push('h');
    emitted = true;
  }
  if (!emitted) {
    out.length = mark; // nothing was drawn — drop the colour setup again
    return;
  }
  // `B*` fills and strokes in one go; `f*` is fill only. Both use the even-odd
  // rule so holes stay holes.
  out.push(stroked ? 'B*' : 'f*');
}

export function resultToPdf(result: VectorizeResult, creator = 'GetVect'): string {
  const parsed = parseSvgShapes(result.svg);
  const width = Math.round(result.width || parsed.width);
  const height = Math.round(result.height || parsed.height);

  const content: string[] = ['q', `1 0 0 -1 0 ${num(height, 1)} cm`];
  for (const shape of parsed.shapes) shapeOps(shape, content);
  content.push('Q', '');
  const stream = content.join('\n');

  // --- object assembly ------------------------------------------------------
  // Offsets in the xref table are byte offsets into the finished file, so the
  // objects are concatenated first and measured as they go. Everything written
  // here is ASCII, so string length is byte length.
  // A fixed timestamp, not `new Date()`: exporting the same artwork twice must
  // give byte-identical files so diffs and the instruments harness mean
  // something. PDF requires the key, not that it be truthful about wall clock.
  const created = pdfDate(new Date(0));
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      `/Resources << /ProcSet [/PDF] >> /Contents 4 0 R >>`,
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    `<< /Producer (${pdfString(creator)}) /Creator (${pdfString(creator)}) ` +
      `/CreationDate (${created}) >>`,
  ];

  // No binary-marker comment: every byte this writer emits is ASCII, so the
  // file is safe to hand around as text — and, more usefully, the xref offsets
  // below cannot drift because of a multi-byte character in the header.
  const header = '%PDF-1.4\n';
  let file = header;
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLength(file));
    file += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = byteLength(file);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  file +=
    xref +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return file;
}

/**
 * UTF-8 byte length. The file is written with a utf8 encoding, so an xref
 * offset must count bytes, not UTF-16 code units — a single stray non-ASCII
 * character (a filename in the Info dictionary, say) would otherwise shift
 * every offset after it and produce a file no reader will open.
 */
function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c > 0xffff) {
      n += 4;
      i++; // surrogate pair
    } else if (c > 0x7ff) n += 3;
    else if (c > 0x7f) n += 2;
    else n += 1;
  }
  return n;
}

/** Escape the characters that would end a PDF literal string early. */
function pdfString(s: string): string {
  return s.replace(/([\\()])/g, '\\$1');
}

/**
 * `D:YYYYMMDDHHmmSS` in UTC. A fixed date is passed by the exporter so two runs
 * over the same artwork produce byte-identical files (the instruments harness
 * and the acceptance suite both compare outputs).
 */
function pdfDate(date: Date): string {
  const p = (v: number, w = 2) => String(v).padStart(w, '0');
  return (
    `D:${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}
