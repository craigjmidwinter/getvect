import type { Page } from '@playwright/test';
import { test, expect, tid, TESTIDS, FIXTURE, loadViaPicker, waitForReady } from './helpers';

/**
 * REFERENCE C1/C2 — the preview must behave like an image viewer.
 *
 * The checklist tests in c-preview.spec.ts prove the controls exist. These
 * prove they behave: the artwork never disappears mid-trace, the busy state is
 * an overlay rather than a member of the zoom/pan stage, the wheel zooms, and
 * panning cannot throw the artwork off screen with no way back except "Fit".
 */

const rectOf = (page: Page, id: string) =>
  page
    .locator(tid(id))
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });

const svgRect = (page: Page) =>
  page.locator(`${tid(TESTIDS.previewVector)} svg`).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

test('[C1] the vector view never goes blank while a new image is traced', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.snorlax);
  await waitForReady(page);

  let blankFrames = 0;
  const watching = (async () => {
    for (let i = 0; i < 60; i++) {
      const hasSvg = await page.locator(`${tid(TESTIDS.previewVector)} svg`).count();
      if (hasSvg === 0) blankFrames++;
      await page.waitForTimeout(15);
    }
  })();

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  await waitForReady(page);
  await watching;

  expect(blankFrames, 'the preview emptied while re-tracing').toBe(0);
});

test('[C1] the busy indicator is a centred overlay, not part of the zoom stage', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.snorlax);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomIn)).click();
  await page.locator(tid(TESTIDS.zoomIn)).click();

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  const busy = page.locator(tid(TESTIDS.previewBusy));
  await expect(busy).toBeVisible({ timeout: 5_000 });

  const pane = await rectOf(page, TESTIDS.previewPane);
  const overlay = await rectOf(page, TESTIDS.previewBusy);
  const dx = Math.abs(overlay.x + overlay.width / 2 - (pane.x + pane.width / 2));
  const dy = Math.abs(overlay.y + overlay.height / 2 - (pane.y + pane.height / 2));
  expect(dx, 'busy overlay is not horizontally centred in the pane').toBeLessThan(12);
  expect(dy, 'busy overlay is not vertically centred in the pane').toBeLessThan(12);
  await waitForReady(page);
});

test('[C2] the mouse wheel zooms the preview', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const level = page.locator(tid(TESTIDS.zoomLevel));
  const read = async () => Number(await level.getAttribute('data-zoom'));
  const before = await read();

  const pane = await rectOf(page, TESTIDS.previewPane);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, -400);
  await expect
    .poll(read, { message: 'wheel up did not zoom in' })
    .toBeGreaterThan(before);

  const zoomedIn = await read();
  await page.mouse.wheel(0, 400);
  await expect.poll(read, { message: 'wheel down did not zoom out' }).toBeLessThan(zoomedIn);

  // Both views stay synchronized under wheel zoom too (C2).
  await expect(page.locator(tid(TESTIDS.previewVector))).toHaveAttribute(
    'data-zoom',
    String(await read()),
  );
});

test('[C2] panning cannot throw the artwork off screen', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomFit)).click();

  const pane = await rectOf(page, TESTIDS.previewPane);
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 + 700, pane.y + pane.height / 2 + 500, {
    steps: 10,
  });
  await page.mouse.up();

  const art = await svgRect(page);
  expect(
    overlap(art, pane),
    'a single drag pushed the artwork out of the view with no way back but Fit',
  ).toBeGreaterThan(0.25);
});

test('[C2] preview controls are inert until an image is loaded', async ({ page }) => {
  for (const id of [
    TESTIDS.previewToggle,
    TESTIDS.previewSideBySide,
    TESTIDS.zoomIn,
    TESTIDS.zoomOut,
    TESTIDS.zoomFit,
  ]) {
    await expect(page.locator(tid(id)), `${id} should be disabled with no image`).toBeDisabled();
  }
});
