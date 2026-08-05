import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  fillsIn,
  loadViaPicker,
  previewSvg,
  setSelect,
  setSlider,
  waitForReady,
} from './helpers';

/**
 * REFERENCE B2 — model presets.
 *
 * `fixtures/reference/OBSERVED-UI.md` step ① is the ground truth: Clipart (with
 * a Detail Level dropdown of Maximum/Ultra/Very High/High/Medium/Low/Minimum),
 * Photo, Sketch (grayscale) and Drawing (black/white with a luminance threshold).
 * These are the first controls a user touches in the real product, and two of
 * the four output modes (Sketch, Drawing) are unreachable without them.
 *
 * Each preset must observably change the output — not merely the bytes.
 */

const PRESETS = [
  ['clipart', TESTIDS.presetClipart],
  ['photo', TESTIDS.presetPhoto],
  ['sketch', TESTIDS.presetSketch],
  ['drawing', TESTIDS.presetDrawing],
] as const;

/** OBSERVED-UI.md: the Clipart preset's Detail Level enum, most to least. */
const DETAIL_LEVELS = ['maximum', 'ultra', 'very-high', 'high', 'medium', 'low', 'minimum'];

test('[B2] all four model presets are present', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  for (const [name, id] of PRESETS) {
    await expect(page.locator(tid(id)), `preset ${name} is missing`).toBeVisible();
  }
});

test('[B2] each preset produces a different picture', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);

  const seen = new Map<string, string>();
  for (const [name, id] of PRESETS) {
    await page.locator(tid(id)).click();
    await waitForReady(page);
    const svg = await previewSvg(page);
    for (const [other, previous] of seen) {
      expect(svg, `preset ${name} produced the same SVG as ${other}`).not.toEqual(previous);
    }
    seen.set(name, svg);
  }
});

test('[B2] the selected preset is reflected as pressed state', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetSketch)).click();
  await waitForReady(page);
  await expect(page.locator(tid(TESTIDS.presetSketch))).toHaveAttribute('data-selected', 'true');
  await expect(page.locator(tid(TESTIDS.presetClipart))).toHaveAttribute('data-selected', 'false');
});

test('[B2] Sketch is grayscale — every layer colour has r == g == b', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetSketch)).click();
  await waitForReady(page);

  const fills = [...fillsIn(await previewSvg(page))];
  expect(fills.length).toBeGreaterThan(1);
  for (const fill of fills) {
    const [r, g, b] = [fill.slice(1, 3), fill.slice(3, 5), fill.slice(5, 7)];
    expect(`${fill} -> ${r}/${g}/${b}`, `Sketch layer ${fill} is not grey`).toBe(
      `${fill} -> ${r}/${r}/${r}`,
    );
    expect(g).toBe(r);
    expect(b).toBe(r);
  }
});

test('[B2] Drawing is black & white and the luminance threshold moves the edge', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.jpeg);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetDrawing)).click();
  await waitForReady(page);

  const fills = [...fillsIn(await previewSvg(page))].sort();
  expect(fills.length).toBeLessThanOrEqual(2);
  expect(fills.every((f) => f === '#000000' || f === '#ffffff')).toBe(true);

  // The threshold control only exists for this preset, and must repaint.
  const threshold = page.locator(tid(TESTIDS.settingBwThreshold));
  await expect(threshold).toBeVisible();
  await setSlider(page, TESTIDS.settingBwThreshold, 60);
  await waitForReady(page);
  const dark = await previewSvg(page);
  await setSlider(page, TESTIDS.settingBwThreshold, 200);
  await waitForReady(page);
  expect(await previewSvg(page)).not.toEqual(dark);
});

test('[B2] Clipart exposes the seven documented detail levels', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetClipart)).click();
  await waitForReady(page);

  const values = await page
    .locator(`${tid(TESTIDS.settingDetailLevel)} option`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(values).toEqual(DETAIL_LEVELS);
});

test('[B2] detail level changes the output and Minimum is simpler than Maximum', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.presetClipart)).click();
  await waitForReady(page);

  await setSelect(page, TESTIDS.settingDetailLevel, 'maximum');
  await waitForReady(page);
  const max = await previewSvg(page);

  await setSelect(page, TESTIDS.settingDetailLevel, 'minimum');
  await waitForReady(page);
  const min = await previewSvg(page);

  expect(min).not.toEqual(max);
  expect(min.length).toBeLessThan(max.length);
});

test('[B2] the colour slider explains when it cannot deliver what was asked', async ({ page }) => {
  // The flat fixture only has six colours, so asking for 32 yields 6. The real
  // product never leaves the control and the result silently disagreeing.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await setSlider(page, TESTIDS.settingColorCount, 32);
  await waitForReady(page);

  const hint = page.locator(tid(TESTIDS.settingColorCountHint));
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAttribute('data-requested', '32');
  const actual = await page.locator(tid(TESTIDS.paletteSwatch)).count();
  await expect(hint).toHaveAttribute('data-actual', String(actual));
  await expect(hint).toContainText(String(actual));
});
