import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  countPixelSubPaths,
  countSubPaths,
  curveCommandRatio,
  loadViaPicker,
  previewSvg,
  setCheckbox,
  setSelect,
  waitForReady,
} from './helpers';

/**
 * REFERENCE B5 — advanced vectorization controls, "each observably changing
 * output": Roundness (3 curve-fitting levels), Minimum Area (0/5/90 px²),
 * Overlap (Full/High), Circle Detection (Off/On).
 *
 * "Observably" is taken to mean the geometry changes in the direction the
 * control promises, not merely that the bytes differ.
 */

test('[B5] every advanced control is present', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  for (const id of [
    TESTIDS.settingRoundness,
    TESTIDS.settingMinArea,
    TESTIDS.settingOverlap,
    TESTIDS.settingCircleDetection,
  ]) {
    await expect(page.locator(tid(id)), `${id} is missing`).toBeVisible();
  }
});

test('[B5] roundness offers three levels and each changes the curve fitting', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const levels = await page
    .locator(`${tid(TESTIDS.settingRoundness)} option`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(levels, 'REFERENCE B5: three curve-fitting levels').toHaveLength(3);

  const seen: { level: string; svg: string; curve: number }[] = [];
  for (const level of levels) {
    await setSelect(page, TESTIDS.settingRoundness, level);
    await waitForReady(page);
    const svg = await previewSvg(page);
    for (const other of seen) {
      expect(svg, `roundness ${level} matches ${other.level}`).not.toEqual(other.svg);
    }
    seen.push({ level, svg, curve: curveCommandRatio(svg) });
  }
  // Rounder settings must fit more curve than the least round one.
  expect(seen[seen.length - 1].curve).toBeGreaterThan(seen[0].curve);
});

test('[B5] minimum area offers 0/5/90 px2 and removes specks', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);

  const values = await page
    .locator(`${tid(TESTIDS.settingMinArea)} option`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(values).toEqual(['0', '5', '90']);

  await setSelect(page, TESTIDS.settingMinArea, '0');
  await waitForReady(page);
  const keepAll = await previewSvg(page);

  await setSelect(page, TESTIDS.settingMinArea, '5');
  await waitForReady(page);
  const min5 = await previewSvg(page);

  await setSelect(page, TESTIDS.settingMinArea, '90');
  await waitForReady(page);
  const min90 = await previewSvg(page);

  expect(min5).not.toEqual(keepAll);
  expect(min90).not.toEqual(min5);

  // 5 px² is defined to drop 1x1 specks; 90 px² must be strictly quieter still.
  expect(countPixelSubPaths(min5), 'Minimum Area 5px2 must drop single-pixel shapes').toBe(0);
  expect(countSubPaths(min90)).toBeLessThan(countSubPaths(min5));
  expect(countSubPaths(min5)).toBeLessThan(countSubPaths(keepAll));
});

test('[B5] overlap Full/High changes how layers stack', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const values = await page
    .locator(`${tid(TESTIDS.settingOverlap)} option`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(values).toEqual(['full', 'high']);

  await setSelect(page, TESTIDS.settingOverlap, 'full');
  await waitForReady(page);
  const full = await previewSvg(page);

  await setSelect(page, TESTIDS.settingOverlap, 'high');
  await waitForReady(page);
  const high = await previewSvg(page);

  expect(high).not.toEqual(full);
  // Full overlap paints lower layers under the upper ones, so it can only ever
  // carry at least as much geometry as the trimmed "high" variant.
  expect(countSubPaths(high)).toBeLessThanOrEqual(countSubPaths(full));
});

test('[B5] circle detection changes round shapes into circular geometry', async ({ page }) => {
  // The BMP fixture is drawn from hard-edged discs — the case the control exists for.
  await loadViaPicker(page, FIXTURE.bmp);
  await waitForReady(page);

  await setCheckbox(page, TESTIDS.settingCircleDetection, false);
  await waitForReady(page);
  const off = await previewSvg(page);

  await setCheckbox(page, TESTIDS.settingCircleDetection, true);
  await waitForReady(page);
  const on = await previewSvg(page);

  expect(on).not.toEqual(off);
  // A detected circle is either a <circle> element or an arc/curve pair — in
  // both cases far fewer segments than the polygonal trace it replaces.
  const circles = (on.match(/<(circle|ellipse)\b/g) ?? []).length;
  expect(circles > 0 || curveCommandRatio(on) > curveCommandRatio(off)).toBe(true);
});
