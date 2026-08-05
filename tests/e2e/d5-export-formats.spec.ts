import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { test, expect, FIXTURE, exportAs, loadViaPicker, previewSvg, waitForReady } from './helpers';

/**
 * REFERENCE.md D5 — "PDF and PNG export options alongside SVG/EPS/DXF (real
 * product also offers these)", plus the D1 structural claim about per-colour
 * `<g fill=...>` layers.
 *
 * Same rules as d-export.spec.ts: exports go through `window.getvect.saveExport`
 * and therefore through the main process, which under GETVECT_E2E=1 writes to
 * GETVECT_EXPORT_DIR instead of opening the native dialog.
 */

test('[D5] PDF export is a structurally valid one-page vector PDF', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const pdf = await fs.readFile(await exportAs(page, 'pdf', exportDir), 'latin1');

  expect(pdf).toMatch(/^%PDF-1\.\d/);
  expect(pdf).toContain('/Type /Catalog');
  expect(pdf).toContain('/Type /Page');
  expect(pdf).toMatch(/\/MediaBox \[0 0 512 512\]/);
  expect(pdf).toContain('stream');
  expect(pdf.trimEnd()).toMatch(/%%EOF$/);

  // Painting operators: `f*`/`B*` fills preceded by `m`/`c`/`l` path building.
  expect(pdf).toMatch(/\bf\*|\bB\*/);
  expect((pdf.match(/^\s*[-\d.]+ [-\d.]+ m$/gm) ?? []).length).toBeGreaterThan(0);

  // The xref must point at a real `startxref` offset, or no reader opens it.
  const startxref = /startxref\s+(\d+)/.exec(pdf);
  expect(startxref, 'PDF must declare startxref').not.toBeNull();
  const offset = Number(startxref![1]);
  expect(offset).toBeGreaterThan(0);
  expect(pdf.slice(offset, offset + 4)).toBe('xref');
});

test('[D5] PNG export is a real bitmap at the source size', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const png = await fs.readFile(await exportAs(page, 'png', exportDir));

  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
  expect(png.readUInt32BE(16)).toBe(512); // width
  expect(png.readUInt32BE(20)).toBe(512); // height
  expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
  expect(png.length).toBeGreaterThan(1000);
});

test('[D5] PDF and PNG use the source filename too', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  for (const format of ['pdf', 'png'] as const) {
    expect(basename(await exportAs(page, format, exportDir))).toBe(`logo-flat-512.${format}`);
  }
});

test('[D1] the exported SVG groups paths into per-colour layers', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const svg = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');

  const groups = [...svg.matchAll(/<g fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  expect(groups.length).toBeGreaterThan(1);
  // One group per colour, and every path lives inside one of them.
  expect(new Set(groups).size).toBe(groups.length);
  expect((svg.match(/<path\b/g) ?? []).length).toBeGreaterThan(0);
  expect(svg).not.toMatch(/<path[^>]*\bfill="/);

  // C3 — the preview is the export. The DOM re-serializes `<path/>` as
  // `<path></path>`, so compare with empty elements collapsed.
  const collapse = (s: string) => s.replace(/><\/(path|rect)>/g, '/>').trim();
  expect(collapse(await previewSvg(page))).toBe(collapse(svg));
});
