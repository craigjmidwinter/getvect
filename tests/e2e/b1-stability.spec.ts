import { test, expect, tid, TESTIDS, FIXTURE, loadViaPicker, waitForReady } from './helpers';

/**
 * REFERENCE B1 — "auto-vectorizes on load; visible progress state; UI stays
 * responsive".
 *
 * Responsive also means *stable*: the real product keeps its control surface in
 * place while it works. Ours unmounts the palette editor whenever the selected
 * image has no result yet, so the settings row and the preview pane jump by
 * ~100px twice in under 100ms on every image switch. That is measurable, so it
 * is measured.
 */

/** Vertical position + height of an element, or null when it is not mounted. */
async function box(page: import('@playwright/test').Page, id: string) {
  return page
    .locator(tid(id))
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { y: r.y, height: r.height };
    })
    .catch(() => null);
}

test('[B1] the settings panel does not jump while an image is being traced', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.noisy512);
  await waitForReady(page);

  const settled = await box(page, TESTIDS.settingsPanel);
  expect(settled).not.toBeNull();

  // Sample continuously across a switch to a not-yet-traced image.
  const samples: { y: number; height: number }[] = [];
  const sampling = (async () => {
    for (let i = 0; i < 40; i++) {
      const b = await box(page, TESTIDS.settingsPanel);
      if (b) samples.push(b);
      await page.waitForTimeout(15);
    }
  })();

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  await waitForReady(page);
  await sampling;

  const ys = samples.map((s) => s.y);
  const drift = Math.max(...ys) - Math.min(...ys);
  expect(drift, `settings panel moved ${drift.toFixed(0)}px during the switch`).toBeLessThanOrEqual(
    2,
  );
});

test('[B1] the palette editor stays mounted while a re-trace is in flight', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.noisy512);
  await waitForReady(page);
  await expect(page.locator(tid(TESTIDS.paletteEditor))).toBeVisible();

  let disappeared = false;
  const watching = (async () => {
    for (let i = 0; i < 40; i++) {
      if ((await page.locator(tid(TESTIDS.paletteEditor)).count()) === 0) disappeared = true;
      await page.waitForTimeout(15);
    }
  })();

  await page.locator(tid(TESTIDS.imageListItem)).nth(1).click();
  await waitForReady(page);
  await watching;

  expect(disappeared, 'the palette editor unmounted mid-trace').toBe(false);
});

test('[B1] a not-yet-traced image still shows the full control surface', async ({ page }) => {
  // The very first load is the worst case: nothing has been traced yet, so an
  // app that only mounts the palette editor once a result exists reflows twice.
  const heights: number[] = [];
  const sampling = (async () => {
    for (let i = 0; i < 80; i++) {
      // Only frames where an image already exists count — the idle layout is
      // allowed to look different.
      const frame = await page.evaluate(
        ({ itemSel, paneSel }) => ({
          hasImage: document.querySelectorAll(itemSel).length > 0,
          height: document.querySelector(paneSel)?.getBoundingClientRect().height ?? 0,
        }),
        { itemSel: tid(TESTIDS.imageListItem), paneSel: tid(TESTIDS.previewPane) },
      );
      if (frame.hasImage && frame.height > 0) heights.push(frame.height);
      await page.waitForTimeout(10);
    }
  })();

  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await sampling;

  expect(heights.length, 'no frames were sampled while an image was loaded').toBeGreaterThan(5);
  const drift = Math.max(...heights) - Math.min(...heights);
  expect(drift, `preview pane resized by ${drift.toFixed(0)}px while tracing`).toBeLessThanOrEqual(
    2,
  );
});
