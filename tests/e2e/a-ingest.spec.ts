import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  dropFiles,
  loadViaPicker,
  waitForReady,
} from './helpers';

/**
 * REFERENCE.md section A — Launch & ingest.
 * Every test title is prefixed with its checklist id so a run maps 1:1 onto the
 * acceptance checklist.
 */

test('[A1] app launches to a visible drop zone', async ({ page }) => {
  await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.dropZone))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.filePickerButton))).toBeVisible();
});

test('[A1] accepts a PNG via the file picker input', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
  await expect(page.locator(tid(TESTIDS.imageListItem)).first()).toContainText('logo-flat-512.png');
});

test('[A1] accepts a JPEG via the file picker input', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.jpeg);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
  await waitForReady(page);
});

test('[A1] accepts a BMP via the file picker input', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.bmp);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
  await waitForReady(page);
});

test('[A1] accepts a PNG via drag-and-drop onto the drop zone', async ({ page }) => {
  await dropFiles(page, FIXTURE.flat512);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
});

test('[A2] rejects an unsupported .txt with a clear message', async ({ page }) => {
  await dropFiles(page, FIXTURE.txt);
  const toast = page.locator(tid(TESTIDS.errorToast));
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/unsupported|not supported|can'?t open|PNG|JPEG|BMP/i);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(0);
});

test('[A2] rejects an unsupported .gif with a clear message', async ({ page }) => {
  await dropFiles(page, FIXTURE.gif);
  await expect(page.locator(tid(TESTIDS.errorToast))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(0);
});

test('[A2] a mixed drop keeps the supported files and reports the rejected one', async ({ page }) => {
  await dropFiles(page, FIXTURE.flat512, FIXTURE.gif);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
  await expect(page.locator(tid(TESTIDS.errorToast))).toBeVisible();
});

test('[A3] multiple images form a list', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.noisy512, FIXTURE.bmp);
  await expect(page.locator(tid(TESTIDS.imageList))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(3);
});

test('[A3] selecting a list item switches the workspace to it', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512, FIXTURE.noisy512);
  const items = page.locator(tid(TESTIDS.imageListItem));
  await items.nth(1).click();
  await expect(items.nth(1)).toHaveAttribute('data-selected', 'true');
  await expect(items.nth(0)).toHaveAttribute('data-selected', 'false');

  const selectedId = await items.nth(1).getAttribute('data-image-id');
  await expect(page.locator(tid(TESTIDS.workspace))).toHaveAttribute(
    'data-image-id',
    selectedId ?? '__missing__',
  );
});
