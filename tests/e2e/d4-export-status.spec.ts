import type { Page } from '@playwright/test';
import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  exportAs,
  loadViaPicker,
  previewSvg,
  setSlider,
  waitForReady,
} from './helpers';

/**
 * REFERENCE D4 — the export row.
 *
 * Two failure modes that a structural export test cannot see:
 *   1. the button row re-flows when the "Saved …" label appears, so the second
 *      click of a two-format export lands on a different button than the one
 *      under the cursor;
 *   2. the confirmation is never invalidated, so it keeps asserting that a file
 *      on disk matches a preview that has since changed (or been deleted).
 *
 * docs/TESTIDS.md defines `data-last-export-path` as "the path of the file that
 * matches what is on screen"; both of these violate that definition.
 */

const EXPORT_BUTTONS = [
  TESTIDS.exportSvg,
  TESTIDS.exportEps,
  TESTIDS.exportDxf,
  TESTIDS.exportPdf,
  TESTIDS.exportPng,
];

async function buttonCentres(page: Page) {
  const out: Record<string, { x: number; y: number }> = {};
  for (const id of EXPORT_BUTTONS) {
    const box = await page.locator(tid(id)).boundingBox();
    if (!box) throw new Error(`${id} has no bounding box`);
    out[id] = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  return out;
}

test('[D4] the export row does not move when an export completes', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const before = await buttonCentres(page);
  await exportAs(page, 'svg', exportDir);
  const after = await buttonCentres(page);

  for (const id of EXPORT_BUTTONS) {
    const dx = Math.abs(after[id].x - before[id].x);
    const dy = Math.abs(after[id].y - before[id].y);
    expect(dx, `${id} shifted ${dx.toFixed(0)}px horizontally after an export`).toBeLessThanOrEqual(
      1,
    );
    expect(dy, `${id} shifted ${dy.toFixed(0)}px vertically after an export`).toBeLessThanOrEqual(1);
  }

  // The strongest form: the point you just clicked still belongs to that button.
  const stillSvg = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
  }, before[TESTIDS.exportSvg]);
  expect(stillSvg, 'a second click at the same point would hit a different format').toBe(
    TESTIDS.exportSvg,
  );
});

test('[D4] the saved-file confirmation is cleared when the settings change', async ({
  page,
  exportDir,
}) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await exportAs(page, 'svg', exportDir);

  await setSlider(page, TESTIDS.settingColorCount, 4);
  await waitForReady(page);

  await expect(
    page.locator(tid(TESTIDS.exportStatus)),
    'the confirmation still claims a stale file matches the preview',
  ).not.toHaveAttribute('data-last-export-path', /.+/);
});

test('[D4] the saved-file confirmation is cleared when the image changes', async ({
  page,
  exportDir,
}) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.noisy512);
  await waitForReady(page);
  await exportAs(page, 'svg', exportDir);

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  await waitForReady(page);

  await expect(page.locator(tid(TESTIDS.exportStatus))).not.toHaveAttribute(
    'data-last-export-path',
    /.+/,
  );
});

test('[D4] the saved-file confirmation is cleared when every image is removed', async ({
  page,
  exportDir,
}) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await exportAs(page, 'svg', exportDir);

  await page.locator(tid(TESTIDS.imageRemoveButton)).first().click();
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(0);

  await expect(page.locator(tid(TESTIDS.statusText))).toHaveAttribute('data-status', 'idle');
  await expect(page.locator(tid(TESTIDS.exportStatus))).not.toHaveAttribute(
    'data-last-export-path',
    /.+/,
  );
});

test('[D4] the export row reports the size of the document it will write', async ({ page }) => {
  // The reference product shows a live file-size label next to Download
  // (OBSERVED-UI.md, "File size label (e.g. 223KB)").
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const label = page.locator(tid(TESTIDS.exportSize));
  await expect(label).toBeVisible();
  const bytes = Number(await label.getAttribute('data-bytes'));
  const actual = Buffer.byteLength(await previewSvg(page), 'utf8');
  // The DOM re-serializes self-closing tags, so allow a small slack.
  expect(Math.abs(bytes - actual) / actual).toBeLessThan(0.2);

  await setSlider(page, TESTIDS.settingColorCount, 3);
  await waitForReady(page);
  await expect(label).not.toHaveAttribute('data-bytes', String(bytes));
});
