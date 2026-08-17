import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  countSubPaths,
  fillsIn,
  layerFills,
  loadViaPicker,
  previewSvg,
  setEnhanceMode,
  setSelect,
  waitForReady,
} from './helpers';

/**
 * REFERENCE B4 — "Enhance image with AI (Beta)" plus Noise Reduction
 * (Off/Low/High) and Anti-aliasing (Off/Smart/Mid).
 *
 * The enhance toggle is covered in b-engine.spec.ts; what is checked here is
 * the rest of the group and the two behaviours ARTWORK.md recorded from the
 * reference product: a busy patterned background collapses toward one colour, and
 * antialiased edges do not spawn their own near-duplicate colour layers.
 */

test('[B4] noise reduction and anti-aliasing controls exist with the documented options', async ({
  page,
}) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);

  const options = async (id: string) =>
    page.locator(`${tid(id)} option`).evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLOptionElement).value),
    );

  await expect(page.locator(tid(TESTIDS.settingNoiseReduction))).toBeVisible();
  expect(await options(TESTIDS.settingNoiseReduction)).toEqual(['off', 'low', 'high']);

  await expect(page.locator(tid(TESTIDS.settingAntiAliasing))).toBeVisible();
  expect(await options(TESTIDS.settingAntiAliasing)).toEqual(['off', 'smart', 'mid']);
});

test('[B4] noise reduction observably simplifies a noisy trace', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);

  // Isolated from Smart anti-aliasing, which is on by default and removes the
  // same impulse noise this control exists for — with it on there is nothing
  // left for Noise Reduction to remove.
  await setSelect(page, TESTIDS.settingAntiAliasing, 'off');
  await waitForReady(page);

  await setSelect(page, TESTIDS.settingNoiseReduction, 'off');
  await waitForReady(page);
  const off = await previewSvg(page);

  await setSelect(page, TESTIDS.settingNoiseReduction, 'low');
  await waitForReady(page);
  const low = await previewSvg(page);

  await setSelect(page, TESTIDS.settingNoiseReduction, 'high');
  await waitForReady(page);
  const high = await previewSvg(page);

  expect(low).not.toEqual(off);
  expect(high).not.toEqual(low);
  // Denoising must not make the drawing busier — the same rule the enhance
  // toggle is already held to.
  expect(countSubPaths(low)).toBeLessThanOrEqual(countSubPaths(off));
  expect(countSubPaths(high)).toBeLessThanOrEqual(countSubPaths(low));
});

test('[B4] anti-aliasing suppresses near-duplicate halo layers', async ({ page }) => {
  // The JPEG fixture has soft, antialiased boundaries — exactly the input that
  // makes transition pixels quantize into their own thin colour layers and get
  // painted over the artwork.
  await loadViaPicker(page, FIXTURE.jpeg);
  await waitForReady(page);

  const nearDuplicates = (svg: string) => {
    const fills = layerFills(svg).map((hex) => ({
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    }));
    let pairs = 0;
    for (let i = 0; i < fills.length; i++) {
      for (let j = i + 1; j < fills.length; j++) {
        const d =
          (fills[i].r - fills[j].r) ** 2 +
          (fills[i].g - fills[j].g) ** 2 +
          (fills[i].b - fills[j].b) ** 2;
        // 32, matching instruments/lib/metrics.mjs: at 24 the metric could not
        // see the two-cream patchwork the gold-standard output ships (layers
        // 26.6 and 27.0 apart), while the real exemplar's own layers are never
        // closer than 37.
        if (d <= 32 * 32) pairs++;
      }
    }
    return pairs;
  };

  await setSelect(page, TESTIDS.settingAntiAliasing, 'off');
  await waitForReady(page);
  const off = await previewSvg(page);

  await setSelect(page, TESTIDS.settingAntiAliasing, 'smart');
  await waitForReady(page);
  const smart = await previewSvg(page);

  await setSelect(page, TESTIDS.settingAntiAliasing, 'mid');
  await waitForReady(page);
  const mid = await previewSvg(page);

  expect(smart).not.toEqual(off);
  expect(mid).not.toEqual(smart);
  expect(
    nearDuplicates(smart),
    'Smart anti-aliasing must not leave more near-duplicate colour layers than Off',
  ).toBeLessThanOrEqual(nearDuplicates(off));
});

test('[B4] enhance never invents a colour the source does not contain', async ({ page }) => {
  // logo-flat-512 is generated without antialiasing from exactly six colours.
  const SOURCE_COLORS = new Set([
    '#f2efe6',
    '#1b3a5c',
    '#2b2b2b',
    '#e4572e',
    '#2e9e5b',
    '#f2c14e',
  ]);

  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await setEnhanceMode(page, 'local');
  await waitForReady(page);

  const fills = [...fillsIn(await previewSvg(page))];
  expect(fills.length).toBeLessThanOrEqual(SOURCE_COLORS.size);
  for (const fill of fills) {
    expect(SOURCE_COLORS.has(fill), `enhance invented ${fill}`).toBe(true);
  }
});
