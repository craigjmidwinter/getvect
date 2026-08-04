import { test, expect, tid, TESTIDS } from './helpers';

/**
 * Harness smoke tests — NOT part of the REFERENCE.md checklist.
 * These must pass even on the bare skeleton; if they fail, the harness itself
 * (Electron launch, build output, preload bridge) is broken.
 */
test.describe('smoke', () => {
  test('smoke: electron app launches and renders the root element', async ({ page }) => {
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();
  });

  test('smoke: window title is GetVect', async ({ page }) => {
    await expect(page).toHaveTitle(/GetVect/i);
  });

  test('smoke: preload bridge exposes window.getvect', async ({ page }) => {
    const api = await page.evaluate(() => Object.keys((window as never as { getvect?: object }).getvect ?? {}));
    expect(api).toEqual(expect.arrayContaining(['openImages', 'readFile', 'saveExport']));
  });

  test('smoke: no renderer console errors on boot', async ({ app }) => {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForTimeout(1000);
    expect(errors).toEqual([]);
  });
});
