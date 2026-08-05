/**
 * D3 / REFERENCE E — the DXF the app can actually produce.
 *
 * `toDxf(result, { curves: 'lines' })` is implemented in `src/engine/dxf.ts`,
 * documented in the engine contract (docs/HARNESS.md) and listed in REFERENCE
 * section E as a real-product download ("DXF lines-vs-splines variants"). But
 * `grep -rn "'dxf'" src/renderer src/main src/shared` finds only the format
 * string and `src/renderer/App.tsx` offers exactly one DXF button, so no user
 * can reach the variant: it is code the product does not have.
 *
 * Two ways to close that, and this spec picks the first: expose the choice.
 * (The other is to delete the parameter and its contract line — in which case
 * delete this file in the same commit, and `dxf-curves` from
 * `src/shared/testids.ts` and docs/TESTIDS.md.)
 *
 * Splines are the default because they are what the curve fitting produced;
 * `lines` exists for consumers (older CAD, some cutter firmware) that cannot
 * read a degree-3 SPLINE at all — which is why "the same file with fewer
 * features" is not good enough: the lines variant must contain no SPLINE.
 */
import { promises as fs } from 'node:fs';
import { FIXTURE, TESTIDS, exportAs, expect, loadViaPicker, test, tid, waitForReady } from './helpers';

const countEntities = (dxf: string, name: string) =>
  (dxf.match(new RegExp(`\\n\\s*0\\n${name}\\b`, 'g')) ?? []).length;

test('[D3] the DXF curve variant is a control, not just an engine option', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const select = page.locator(tid(TESTIDS.exportDxfCurves));
  await expect(
    select,
    'no dxf-curves control: toDxf({ curves }) ships two output formats and the app exposes one',
  ).toHaveCount(1);
  const values = await select.locator('option').evaluateAll((nodes) =>
    nodes.map((n) => (n as HTMLOptionElement).value),
  );
  expect(values.sort()).toEqual(['lines', 'splines']);
  // The curve-fitted form is what the rest of the pipeline produces, so it is
  // the one a user who never touches this control must get.
  await expect(select).toHaveValue('splines');
});

test('[D4] the DXF variant select is dead when the row it belongs to is dead', async ({ page }) => {
  /**
   * With no image loaded every control in the export row is correctly disabled
   * — SVG, EPS, DXF, PDF and PNG all grey out — except this `<select>`, which
   * stays fully interactive: `src/renderer/App.tsx` renders the sibling buttons
   * with `disabled={!ready || exporting !== null}` and gives the select no
   * `disabled` prop at all. It is the only live control in a dead row, and it
   * configures an export that cannot happen.
   *
   * Checked before anything is loaded (the disabled case) and after (the live
   * case), because "disable it forever" is not a fix either.
   */
  const select = page.locator(tid(TESTIDS.exportDxfCurves));
  await expect(select).toHaveCount(1);
  await expect(page.locator(tid(TESTIDS.exportDxf))).toBeDisabled();
  await expect(
    select,
    'the DXF curve-encoding select is interactive with no image loaded, next to a disabled DXF ' +
      'button — it configures an export that cannot happen',
  ).toBeDisabled();

  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await expect(select).toBeEnabled();
});

test('[D3] "splines" keeps the fitted curves and "lines" flattens them', async ({
  page,
  exportDir,
}) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const splines = await fs.readFile(await exportAs(page, 'dxf', exportDir), 'utf8');
  expect(
    countEntities(splines, 'SPLINE'),
    'the default DXF carries no SPLINE entities at all',
  ).toBeGreaterThan(0);

  await page.locator(tid(TESTIDS.exportDxfCurves)).selectOption('lines');
  const lines = await fs.readFile(await exportAs(page, 'dxf', exportDir), 'utf8');

  expect(
    countEntities(lines, 'SPLINE'),
    'the "lines" variant still emits SPLINE entities — the consumers it exists for cannot read ' +
      'them, so a file that contains any is the same file with extra steps',
  ).toBe(0);
  expect(
    countEntities(lines, 'POLYLINE') + countEntities(lines, 'LWPOLYLINE'),
    'the "lines" variant has no POLYLINE geometry — the curves were dropped, not flattened',
  ).toBeGreaterThan(0);
  expect(countEntities(lines, 'VERTEX')).toBeGreaterThan(0);

  // Same drawing, two encodings: the flattened one is bigger (that is the
  // trade), but both have to describe the same picture rather than one being a
  // stub. Extents are the cheapest structural proof of that.
  const extentOf = (dxf: string) =>
    [...dxf.matchAll(/\$EXTMAX[\s\S]{0,80}?\n\s*10\n\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  expect(extentOf(lines)).toEqual(extentOf(splines));
});
