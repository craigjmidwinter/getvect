/**
 * Controls that lie, and controls you cannot see.
 *
 * Both of these are affordance rather than breakage — the engine does the right
 * thing in each case — and both make the settings panel misreport the product:
 *
 *  - B2: with the Drawing preset selected the output is two-tone, but the
 *    COLORS slider still reads 4 and all eleven input-palette sizes stay live.
 *    `fixtures/reference/OBSERVED-UI.md` records that the real product swaps
 *    those controls out for Black/White checkboxes plus the luminance
 *    histogram when Drawing is active. Whatever the replacement, a control
 *    that cannot affect the result must not stay enabled.
 *  - B3: at the app's *default* window size the last two output controls
 *    (merge threshold, sort order) sit below the viewport — the panel scrolls,
 *    so they are reachable, but the thing that stays in view is a checkbox
 *    list rather than the controls.
 */
import { FIXTURE, TESTIDS, expect, loadViaPicker, test, tid, waitForReady } from './helpers';

test('[B2] the Drawing preset does not leave dead colour controls live', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetDrawing)).click();
  await waitForReady(page);

  // The B/W threshold is the input control Drawing actually has.
  await expect(page.locator(tid(TESTIDS.settingBwThreshold))).toBeEnabled();

  const colorCount = page.locator(tid(TESTIDS.settingColorCount));
  const liveColorCount = (await colorCount.count()) > 0 && (await colorCount.isEnabled());
  expect(
    liveColorCount,
    'the COLORS slider is still live under the Drawing preset, which always emits two colours',
  ).toBe(false);

  const sizes = page.locator(tid(TESTIDS.paletteSizeOption));
  const liveSizes = await sizes.evaluateAll((nodes) =>
    nodes.filter((n) => !(n as HTMLInputElement).disabled).length,
  );
  expect(
    liveSizes,
    'the eleven candidate input-palette sizes are still selectable under Drawing',
  ).toBe(0);
});

test('[B2] leaving the Drawing preset gives the colour controls back', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetDrawing)).click();
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetClipart)).click();
  await waitForReady(page);

  await expect(page.locator(tid(TESTIDS.settingColorCount))).toBeEnabled();
  await expect(page.locator(tid(TESTIDS.paletteSizeOption)).first()).toBeEnabled();
});

test('[B3] every output-colour control is on screen at the default window size', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  for (const id of [TESTIDS.colorMergeThreshold, TESTIDS.colorSortOrder]) {
    const box = await page.locator(tid(id)).boundingBox();
    expect(box, `${id} has no box`).not.toBeNull();
    expect(
      box!.y + box!.height,
      `${id} ends at y=${(box!.y + box!.height).toFixed(0)} in a ${viewport.h}px viewport — it is ` +
        'below the fold at the app\'s own default window size',
    ).toBeLessThanOrEqual(viewport.h);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.w);
  }
});

test('[B3] the output colour list itself is reachable without scrolling past the fold', async ({
  page,
}) => {
  /**
   * B3's headline behaviour is "disable the background colour to get a
   * transparent background", and the checkbox that does it is a
   * `color-group-toggle`. Measured at the app's own default window size
   * (1280x828 viewport) the first toggle's box was y=835 h=13 — entirely below
   * the fold, while `merge-threshold` and `color-sort` (the two controls the
   * test above asserts) sat at y=797 and fitted. The panel scrolls, so the
   * feature is reachable; what is not reachable is *knowing it is there*.
   *
   * At least the first toggle must be fully inside the viewport.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const first = page.locator(tid(TESTIDS.colorGroupToggle)).first();
  await expect(first).toHaveCount(1);
  const box = await first.boundingBox();
  expect(box, 'no color-group-toggle on screen at all').not.toBeNull();
  expect(
    box!.y + box!.height,
    `the first color-group-toggle ends at y=${(box!.y + box!.height).toFixed(0)} in a ` +
      `${viewport.h}px viewport — B3's transparent-background control is below the fold at the ` +
      "app's own default window size",
  ).toBeLessThanOrEqual(viewport.h);
  expect(box!.y, 'the first color-group-toggle starts above the viewport').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.w);
});

test('[B3] the colour-count hint is readable, not clipped mid-sentence', async ({ page }) => {
  // "6 colours in the result — the image has no more to give" cut off at the
  // panel edge is a hint nobody can act on.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const hint = page.locator(tid(TESTIDS.settingColorCountHint));
  const overflow = await hint.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(
    overflow.scrollWidth <= overflow.clientWidth + 1 &&
      overflow.scrollHeight <= overflow.clientHeight + 1,
    `color-count-hint is clipped (${overflow.scrollWidth}x${overflow.scrollHeight} of text in a ` +
      `${overflow.clientWidth}x${overflow.clientHeight} box)`,
  ).toBe(true);
});
