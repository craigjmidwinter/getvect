import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { test, expect, FIXTURE, exportAs, loadViaPicker, waitForReady } from './helpers';

/**
 * REFERENCE.md section D — Export.
 *
 * Under GETVECT_E2E=1 the main process writes to GETVECT_EXPORT_DIR instead of
 * opening the native save dialog, but the write still goes through the same
 * `export:save` IPC handler — so these tests exercise the real export path
 * (see src/main/main.ts and docs/TESTIDS.md "Export dialog under test").
 */

test('[D1] SVG export is valid XML and rasterizes', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const file = await exportAs(page, 'svg', exportDir);
  const svg = await fs.readFile(file, 'utf8');

  expect(svg).toMatch(/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/);
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg.trimEnd()).toMatch(/<\/svg>$/);

  // Rasterizing is the strongest cheap validity check available offline.
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng();
  expect(png.length).toBeGreaterThan(1000);
});

test('[D1] exported SVG carries the source dimensions', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const svg = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');
  expect(svg).toMatch(/viewBox="0 0 512 512"/);
});

test('[D2] EPS export is structurally valid', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const eps = await fs.readFile(await exportAs(page, 'eps', exportDir), 'utf8');

  expect(eps).toMatch(/^%!PS-Adobe-3\.0 EPSF-3\.0/);
  const bbox = eps.match(/%%BoundingBox:\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
  expect(bbox, 'EPS must declare a %%BoundingBox').not.toBeNull();
  expect(Number(bbox![3]) - Number(bbox![1])).toBe(512);
  expect(Number(bbox![4]) - Number(bbox![2])).toBe(512);
  expect(eps).toMatch(/%%EOF/);
  // Painting operators must be present, i.e. the file actually has geometry.
  expect(eps).toMatch(/\bfill\b|\bf\b|\beofill\b/);
  expect((eps.match(/\bmoveto\b|\bm\b/g) ?? []).length).toBeGreaterThan(0);
});

test('[D3] DXF export is structurally valid', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const dxf = await fs.readFile(await exportAs(page, 'dxf', exportDir), 'utf8');

  expect(dxf).toContain('SECTION');
  expect(dxf).toContain('HEADER');
  expect(dxf).toContain('$EXTMIN');
  expect(dxf).toContain('$EXTMAX');
  expect(dxf).toContain('ENTITIES');
  expect(dxf).toMatch(/\bENDSEC\b/);
  expect(dxf.trimEnd()).toMatch(/EOF$/);

  const entities = (dxf.match(/\b(LWPOLYLINE|POLYLINE|SPLINE|HATCH|LINE)\b/g) ?? []).length;
  expect(entities).toBeGreaterThan(0);

  // Extents must cover the artwork, not be left at 0/0.
  const extents = [...dxf.matchAll(/\$EXTMAX[\s\S]{0,80}?\n\s*10\n\s*(-?[\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
  if (extents.length) expect(Math.max(...extents)).toBeGreaterThan(0);
});

test('[D4] exports use the source filename as the default name', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  for (const format of ['svg', 'eps', 'dxf'] as const) {
    const written = await exportAs(page, format, exportDir);
    expect(basename(written)).toBe(`logo-flat-512.${format}`);
  }
});

test('[D4] export goes through the main-process save handler', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const written = await exportAs(page, 'svg', exportDir);
  // The renderer is sandboxed; only the main process can write to disk, so a
  // file existing in the dialog-provided directory proves the IPC path is used.
  expect(written.startsWith(exportDir)).toBe(true);
  await expect(fs.stat(written)).resolves.toBeTruthy();
});

test('[D4] the selected image is the one exported', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.bmp);
  const { tid, TESTIDS } = await import('./helpers');
  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  await waitForReady(page);
  const written = await exportAs(page, 'svg', exportDir);
  expect(basename(written)).toBe('shapes-256.svg');
});
