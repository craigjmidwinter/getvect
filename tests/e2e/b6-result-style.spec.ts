import { promises as fs } from 'node:fs';
import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  exportAs,
  layerFills,
  layerStrokes,
  loadViaPicker,
  previewSvg,
  waitForReady,
} from './helpers';

/**
 * REFERENCE B6 — result styles: Filled Layers vs Stroked Layers.
 *
 * Filled vs bordered elements is the first choice a user makes about what the
 * output IS, so it has to reach the exported document, not just the preview
 * CSS — a style that only exists on screen is a lie about the file.
 */

test('[B6] both result styles are offered and filled is the default', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await expect(page.locator(tid(TESTIDS.resultStyleFilled))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.resultStyleStroked))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.resultStyleFilled))).toHaveAttribute(
    'data-selected',
    'true',
  );
});

test('[B6] stroked layers export outlines instead of fills', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const filled = await previewSvg(page);
  expect(layerFills(filled).length).toBeGreaterThan(1);

  await page.locator(tid(TESTIDS.resultStyleStroked)).click();
  await waitForReady(page);
  const stroked = await previewSvg(page);

  expect(stroked).not.toEqual(filled);
  // Every colour layer must now be a border: stroke set, fill switched off.
  expect(layerStrokes(stroked).length).toBeGreaterThan(1);
  expect(layerStrokes(stroked).sort()).toEqual(layerFills(filled).sort());
  expect(stroked).toMatch(/<g[^>]*fill="none"/);
  expect(stroked).toMatch(/stroke-width="/);

  // C3 still holds in this mode: the preview is the export.
  const exported = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');
  expect(layerStrokes(exported).sort()).toEqual(layerStrokes(stroked).sort());
});

test('[B6] switching back to filled restores the filled document', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const filled = await previewSvg(page);

  await page.locator(tid(TESTIDS.resultStyleStroked)).click();
  await waitForReady(page);
  await page.locator(tid(TESTIDS.resultStyleFilled)).click();
  await waitForReady(page);

  expect(await previewSvg(page)).toEqual(filled);
});
