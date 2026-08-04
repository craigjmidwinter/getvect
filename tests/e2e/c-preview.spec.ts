import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  loadViaPicker,
  previewSvg,
  waitForReady,
} from './helpers';

/** REFERENCE.md section C — Preview. */

test('[C1] original/vector toggle switches the preview mode', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const pane = page.locator(tid(TESTIDS.previewPane));
  const toggle = page.locator(tid(TESTIDS.previewToggle));

  await expect(pane).toHaveAttribute('data-mode', /original|vector/);
  const first = await pane.getAttribute('data-mode');
  await toggle.click();
  await expect(pane).not.toHaveAttribute('data-mode', first ?? '');
  await toggle.click();
  await expect(pane).toHaveAttribute('data-mode', first ?? '');
});

test('[C1] side-by-side mode shows both views at once', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await expect(page.locator(tid(TESTIDS.previewPane))).toHaveAttribute('data-mode', 'side-by-side');
  await expect(page.locator(tid(TESTIDS.previewOriginal))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.previewVector))).toBeVisible();
});

test('[C2] zoom in / out / fit change the zoom level', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const level = page.locator(tid(TESTIDS.zoomLevel));
  const read = async () => Number(await level.getAttribute('data-zoom'));

  await page.locator(tid(TESTIDS.zoomFit)).click();
  const fit = await read();
  expect(fit).toBeGreaterThan(0);

  await page.locator(tid(TESTIDS.zoomIn)).click();
  const zoomedIn = await read();
  expect(zoomedIn).toBeGreaterThan(fit);

  await page.locator(tid(TESTIDS.zoomOut)).click();
  await page.locator(tid(TESTIDS.zoomOut)).click();
  expect(await read()).toBeLessThan(zoomedIn);

  await page.locator(tid(TESTIDS.zoomFit)).click();
  expect(await read()).toBeCloseTo(fit, 3);
});

test('[C2] panning updates the pan state', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.zoomIn)).click();

  const pan = page.locator(tid(TESTIDS.panState));
  const before = await pan.getAttribute('data-pan-x');

  const box = await page.locator(tid(TESTIDS.previewPane)).boundingBox();
  if (!box) throw new Error('preview pane has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 40, { steps: 8 });
  await page.mouse.up();

  await expect(pan).not.toHaveAttribute('data-pan-x', before ?? '');
});

test('[C2] zoom and pan are synchronized across both views', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.previewSideBySide)).click();
  await page.locator(tid(TESTIDS.zoomIn)).click();

  const readView = async (id: string) =>
    page.locator(tid(id)).evaluate((el) => ({
      zoom: el.getAttribute('data-zoom'),
      panX: el.getAttribute('data-pan-x'),
      panY: el.getAttribute('data-pan-y'),
    }));

  const original = await readView(TESTIDS.previewOriginal);
  const vector = await readView(TESTIDS.previewVector);
  expect(vector).toEqual(original);
});

test('[C3] the vector preview is the SVG that gets exported', async ({ page, exportDir }) => {
  const { promises: fs } = await import('node:fs');
  const { exportAs } = await import('./helpers');

  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const shown = await previewSvg(page);
  const file = await exportAs(page, 'svg', exportDir);
  const written = await fs.readFile(file, 'utf8');

  const viewBox = (s: string) => s.match(/viewBox="([^"]+)"/)?.[1];
  expect(viewBox(written)).toBe(viewBox(shown));
  expect((written.match(/<path/g) ?? []).length).toBe((shown.match(/<path/g) ?? []).length);
});
