import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  fillsIn,
  loadViaPicker,
  previewSvg,
  setSlider,
  waitForReady,
} from './helpers';

/** REFERENCE.md section B — Vectorization engine. */

test('[B1] auto-vectorizes on load with defaults and reaches a ready state', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const svg = await previewSvg(page);
  expect(svg).toMatch(/<svg[\s>]/);
  expect(svg).toMatch(/<path/);
});

test('[B1] shows a progress state while vectorizing', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat1024);
  // The progress indicator must appear before the ready state.
  await expect(page.locator(tid(TESTIDS.progressIndicator))).toBeVisible({ timeout: 5_000 });
  await waitForReady(page);
});

test('[B1] a 1024x1024 image vectorizes in under 10s and the UI never freezes', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat1024);
  const started = Date.now();

  // Poke the renderer while it works: a round trip must complete promptly,
  // i.e. tracing must not block the UI thread (REFERENCE "Responsiveness").
  const probeStart = Date.now();
  await page.evaluate(() => document.body.getBoundingClientRect().width);
  expect(Date.now() - probeStart).toBeLessThan(1_000);

  await waitForReady(page);
  expect(Date.now() - started).toBeLessThan(10_000);
});

for (const [setting, id, from, to] of [
  ['color count', TESTIDS.settingColorCount, 8, 3],
  ['detail', TESTIDS.settingDetail, 60, 5],
  ['smoothing', TESTIDS.settingSmoothing, 50, 100],
  ['despeckle', TESTIDS.settingDespeckle, 20, 90],
] as const) {
  test(`[B2] ${setting} observably changes the output`, async ({ page }) => {
    await loadViaPicker(page, FIXTURE.noisy512);
    await waitForReady(page);
    await setSlider(page, id, from);
    await waitForReady(page);
    const before = await previewSvg(page);

    await setSlider(page, id, to);
    await waitForReady(page);
    const after = await previewSvg(page);

    expect(after).not.toEqual(before);
  });
}

test('[B2] color count controls the number of distinct fills in the SVG', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await setSlider(page, TESTIDS.settingColorCount, 3);
  await waitForReady(page);
  expect(fillsIn(await previewSvg(page)).size).toBeLessThanOrEqual(3);
});

test('[B3] palette editor shows the computed palette', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await expect(page.locator(tid(TESTIDS.paletteEditor))).toBeVisible();
  const swatches = page.locator(tid(TESTIDS.paletteSwatch));
  await expect(swatches.first()).toBeVisible();
  expect(await swatches.count()).toBeGreaterThanOrEqual(2);
  await expect(swatches.first()).toHaveAttribute('data-color', /^#[0-9a-fA-F]{6}$/);
});

test('[B3] a palette colour can be changed and the result re-renders', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const swatch = page.locator(tid(TESTIDS.paletteSwatch)).first();
  await swatch.click();
  await setColorInput(page, '#ff00ff');
  await waitForReady(page);
  // Notation-agnostic: REFERENCE D1 documents `rgb(r, g, b)` layer fills, so
  // the assertion is about which colour is painted, not how it is spelled.
  expect([...fillsIn(await previewSvg(page))]).toContain('#ff00ff');
});

test('[B3] two palette colours can be merged', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const swatches = page.locator(tid(TESTIDS.paletteSwatch));
  const before = await swatches.count();
  await swatches.nth(1).click();
  await page.locator(tid(TESTIDS.paletteMergeTarget)).selectOption({ index: 0 });
  await page.locator(tid(TESTIDS.paletteMergeButton)).click();
  await waitForReady(page);
  await expect(swatches).toHaveCount(before - 1);
});

test('[B3] a palette colour can be removed', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const swatches = page.locator(tid(TESTIDS.paletteSwatch));
  const before = await swatches.count();
  const removed = await swatches.nth(1).getAttribute('data-color');
  await swatches.nth(1).click();
  await page.locator(tid(TESTIDS.paletteRemoveButton)).click();
  await waitForReady(page);
  await expect(swatches).toHaveCount(before - 1);
  expect([...fillsIn(await previewSvg(page))]).not.toContain(
    (removed ?? '#000000').toLowerCase(),
  );
});

test('[B4] enhance toggle observably changes a noisy image', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);
  const before = await previewSvg(page);
  const beforePaths = (before.match(/<path/g) ?? []).length;

  await page.locator(tid(TESTIDS.enhanceToggle)).click();
  await waitForReady(page);
  const after = await previewSvg(page);
  const afterPaths = (after.match(/<path/g) ?? []).length;

  expect(after).not.toEqual(before);
  // Denoise + colour simplification should not make the trace busier.
  expect(afterPaths).toBeLessThanOrEqual(beforePaths);
});

async function setColorInput(page: import('@playwright/test').Page, hex: string) {
  await page.locator(tid(TESTIDS.paletteColorInput)).evaluate((node, value) => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, hex);
}
