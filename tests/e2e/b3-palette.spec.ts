import { Resvg } from '@resvg/resvg-js';
import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  fillsIn,
  layerFills,
  loadViaPicker,
  previewSvg,
  setSelect,
  waitForReady,
} from './helpers';

/**
 * REFERENCE B3 — input palette + output colour groups.
 *
 * The palette *editor* already exists (see b-engine.spec.ts). What is checked
 * here is the other half of B3, which the reference product leads with:
 *   - auto-generated candidate palettes at eleven fixed sizes, as radio rows,
 *   - an output colour-groups panel with a per-colour disable checkbox,
 *     a merge threshold and a sort order,
 *   - and the headline sticker/decal workflow: disabling the background colour
 *     yields a genuinely transparent background.
 */

/** ARTWORK.md step ②: the exact sizes the reference product offers. */
const PALETTE_SIZES = [1, 2, 3, 4, 5, 6, 8, 12, 15, 16, 18];

test('[B3] the eleven documented candidate palette sizes are offered', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const sizes = await page
    .locator(tid(TESTIDS.paletteSizeOption))
    .evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute('data-size'))));
  expect(sizes).toEqual(PALETTE_SIZES);
});

test('[B3] choosing a candidate palette size drives the palette', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await page.locator(`${tid(TESTIDS.paletteSizeOption)}[data-size="4"]`).click();
  await waitForReady(page);

  expect([...fillsIn(await previewSvg(page))].length).toBeLessThanOrEqual(4);
  await expect(page.locator(tid(TESTIDS.paletteSwatch))).toHaveCount(4);
});

test('[B3] the output colour-groups panel lists one toggle per output colour', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await expect(page.locator(tid(TESTIDS.colorGroups))).toBeVisible();
  const toggles = page.locator(tid(TESTIDS.colorGroupToggle));
  const swatches = await page.locator(tid(TESTIDS.paletteSwatch)).count();
  await expect(toggles).toHaveCount(swatches);
  await expect(toggles.first()).toHaveAttribute('data-index', '0');
  await expect(toggles.first()).toHaveAttribute('data-color', /^(#[0-9a-fA-F]{6}|rgb\()/);
});

test('[B3] disabling the background colour yields a transparent background', async ({
  page,
  exportDir,
}) => {
  const { promises: fs } = await import('node:fs');
  const { exportAs } = await import('./helpers');

  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  // Index 0 is the dominant colour — the background, by the engine's own
  // descending-coverage ordering.
  const background = await page
    .locator(tid(TESTIDS.colorGroupToggle))
    .first()
    .getAttribute('data-color');
  await page.locator(tid(TESTIDS.colorGroupToggle)).first().click();
  await waitForReady(page);

  const svg = await fs.readFile(await exportAs(page, 'svg', exportDir), 'utf8');
  expect(layerFills(svg), 'the disabled colour still has a layer').not.toContain(
    (background ?? '').toLowerCase(),
  );

  // Structural absence is not enough: the corner pixel must actually be
  // transparent when rendered without a background.
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render();
  const { width, height, pixels } = rendered;
  const alphaAt = (x: number, y: number) => pixels[(y * width + x) * 4 + 3];
  expect(alphaAt(0, 0), 'top-left pixel must be transparent').toBe(0);
  expect(alphaAt(width - 1, height - 1), 'bottom-right pixel must be transparent').toBe(0);
});

test('[B3] re-enabling a disabled colour restores its layer', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const before = await previewSvg(page);

  const toggle = page.locator(tid(TESTIDS.colorGroupToggle)).first();
  await toggle.click();
  await waitForReady(page);
  expect(await previewSvg(page)).not.toEqual(before);

  await toggle.click();
  await waitForReady(page);
  expect(await previewSvg(page)).toEqual(before);
});

test('[B3] the merge threshold observably changes the output', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.noisy512);
  await waitForReady(page);

  const options = await page
    .locator(`${tid(TESTIDS.colorMergeThreshold)} option`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(options.length).toBeGreaterThanOrEqual(2);

  await setSelect(page, TESTIDS.colorMergeThreshold, options[0]);
  await waitForReady(page);
  const low = await previewSvg(page);

  await setSelect(page, TESTIDS.colorMergeThreshold, options[options.length - 1]);
  await waitForReady(page);
  const high = await previewSvg(page);

  expect(high).not.toEqual(low);
  expect(layerFills(high).length).toBeLessThanOrEqual(layerFills(low).length);
});

test('[B3] the palette editor never crowds out the artwork', async ({ app, page }) => {
  // At the app's own minimum window size with a large palette, the controls
  // must not take the majority of the workspace: the picture is the product.
  const win = await app.browserWindow(page);
  await win.evaluate((w: any) => w.setBounds({ width: 900, height: 640 }));
  await page.waitForTimeout(200);

  await loadViaPicker(page, FIXTURE.jpeg);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.settingColorCount)).evaluate((node) => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '64');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitForReady(page);

  const heights = await page.evaluate(
    ({ paneSel, panelSel, rootSel }) => ({
      pane: document.querySelector(paneSel)?.getBoundingClientRect().height ?? 0,
      panel: document.querySelector(panelSel)?.getBoundingClientRect().height ?? 0,
      root: document.querySelector(rootSel)?.getBoundingClientRect().height ?? 1,
    }),
    {
      paneSel: tid(TESTIDS.previewPane),
      panelSel: tid(TESTIDS.settingsPanel),
      rootSel: tid(TESTIDS.appRoot),
    },
  );

  expect(
    heights.panel / heights.root,
    `settings panel takes ${((heights.panel / heights.root) * 100).toFixed(0)}% of the window`,
  ).toBeLessThan(0.45);
  expect(heights.pane).toBeGreaterThan(heights.root * 0.4);
});

test('[B3] the sort order reorders the colour layers', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const options = await page
    .locator(`${tid(TESTIDS.colorSortOrder)} option`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
  expect(options.length).toBeGreaterThanOrEqual(2);

  await setSelect(page, TESTIDS.colorSortOrder, options[0]);
  await waitForReady(page);
  const first = layerFills(await previewSvg(page));

  await setSelect(page, TESTIDS.colorSortOrder, options[1]);
  await waitForReady(page);
  const second = layerFills(await previewSvg(page));

  expect(second).not.toEqual(first);
  expect([...second].sort()).toEqual([...first].sort());
});
