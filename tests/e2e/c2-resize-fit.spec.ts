/**
 * C2 — "fit" has to survive the window changing size.
 *
 * Zoom is computed once, when the image lands. Shrink the window afterwards and
 * the artwork keeps the old scale: it overflows the smaller pane, and the only
 * way back is finding the Fit button. Every desktop viewer re-fits on resize
 * while the user has not chosen a zoom of their own, and REFERENCE C2 lists
 * fit as a first-class operation rather than a one-shot initialisation.
 *
 * The check is written against the app's own Fit: after a resize, the zoom on
 * screen must already be the zoom Fit would give. That way it cannot be gamed
 * by a hard-coded number and it stays true whatever the fit rule is.
 */
import { FIXTURE, TESTIDS, expect, loadViaPicker, test, tid, waitForReady } from './helpers';

const zoomOf = async (page: import('@playwright/test').Page) =>
  Number(await page.locator(tid(TESTIDS.zoomLevel)).getAttribute('data-zoom'));

/** Resize the real BrowserWindow — this is a window event, not a CSS one. */
async function resizeWindow(
  app: import('@playwright/test').ElectronApplication,
  width: number,
  height: number,
) {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(size.width, size.height);
  }, { width, height });
}

test('[C2] shrinking the window re-fits the preview', async ({ app, page }) => {
  await loadViaPicker(page, FIXTURE.artwork);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomFit)).click();
  const fitAtFullSize = await zoomOf(page);

  await resizeWindow(app, 900, 640); // the app's minimum size
  await page.waitForTimeout(400);
  const afterResize = await zoomOf(page);

  await page.locator(tid(TESTIDS.zoomFit)).click();
  const fitAtMinSize = await zoomOf(page);

  expect(
    fitAtMinSize,
    'precondition: fitting a 900x640 window must differ from fitting a 1280x860 one',
  ).toBeLessThan(fitAtFullSize);
  expect(
    afterResize,
    `zoom stayed at ${(afterResize * 100).toFixed(0)}% in a window where fit is ` +
      `${(fitAtMinSize * 100).toFixed(0)}% — the artwork now overflows the pane until the user ` +
      'finds the Fit button',
  ).toBeCloseTo(fitAtMinSize, 2);
});

test('[C2] a zoom the user chose is not thrown away by a resize', async ({ app, page }) => {
  // The other half of the contract: re-fitting must be the *default* behaviour,
  // not an override that discards a deliberate zoom.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomIn)).click();
  await page.locator(tid(TESTIDS.zoomIn)).click();
  const chosen = await zoomOf(page);

  await resizeWindow(app, 1100, 780);
  await page.waitForTimeout(400);

  expect(await zoomOf(page), 'a manual zoom must survive a window resize').toBeCloseTo(chosen, 2);
});
