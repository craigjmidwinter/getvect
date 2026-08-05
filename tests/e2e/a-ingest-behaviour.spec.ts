import {
  test,
  expect,
  tid,
  TESTIDS,
  FIXTURE,
  dragOver,
  dropFiles,
  loadViaPicker,
  waitForReady,
} from './helpers';

/**
 * REFERENCE A1/A2 — ingest behaviour, as opposed to ingest capability.
 *
 * a-ingest.spec.ts proves the app *accepts* the documented formats. These
 * cover what the reference product does with them: it switches you to the image
 * you just uploaded, it tells you a drop will be accepted before you let go,
 * and its rejection message neither sticks forever nor vanishes unacknowledged.
 */

test('[A1] dropping a second image selects and vectorizes the new one', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await dropFiles(page, FIXTURE.noisy512);
  const items = page.locator(tid(TESTIDS.imageListItem));
  await expect(items).toHaveCount(2);

  await expect(items.nth(1), 'the newly dropped image must become the selected one').toHaveAttribute(
    'data-selected',
    'true',
  );
  await expect(items.nth(0)).toHaveAttribute('data-selected', 'false');

  const newId = await items.nth(1).getAttribute('data-image-id');
  await expect(page.locator(tid(TESTIDS.workspace))).toHaveAttribute(
    'data-image-id',
    newId ?? '__missing__',
  );
  await waitForReady(page);
});

test('[A1] picking a second image through the file input selects it too', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await loadViaPicker(page, FIXTURE.bmp);

  const items = page.locator(tid(TESTIDS.imageListItem));
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveAttribute('data-selected', 'true');
  await waitForReady(page);
});

test('[A1] a batch drop selects the first image of the batch', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await dropFiles(page, FIXTURE.noisy512, FIXTURE.bmp);

  const items = page.locator(tid(TESTIDS.imageListItem));
  await expect(items).toHaveCount(3);
  await expect(items.nth(1)).toHaveAttribute('data-selected', 'true');
});

test('[A1] the window shows it will accept a dragged file', async ({ page }) => {
  const root = page.locator(tid(TESTIDS.appRoot));
  await expect(root).not.toHaveAttribute('data-dragging', 'true');

  await dragOver(page, TESTIDS.dropZone, 'dragenter');
  await dragOver(page, TESTIDS.dropZone, 'dragover');
  await expect(root, 'no visual feedback while a file is dragged over').toHaveAttribute(
    'data-dragging',
    'true',
  );

  await dragOver(page, TESTIDS.dropZone, 'dragleave');
  await expect(root).not.toHaveAttribute('data-dragging', 'true');
});

test('[A1] a drop anywhere in the window is accepted, not just on the sidebar', async ({ page }) => {
  await dropFiles(page, FIXTURE.flat512);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);

  await dragOver(page, TESTIDS.previewPane, 'dragenter');
  await expect(page.locator(tid(TESTIDS.appRoot))).toHaveAttribute('data-dragging', 'true');
});

test('[A1] the empty preview tells you where you can drop, and it is everywhere', async ({
  page,
}) => {
  // The window accepts a drop anywhere, so copy that points at the sidebar
  // sends people to the one place they do not have to aim at.
  const empty = page.locator('.preview-empty');
  await expect(empty).toBeVisible();
  const copy = ((await empty.textContent()) ?? '').toLowerCase();
  expect(copy, `empty-state copy misdirects the drop: "${copy}"`).not.toMatch(
    /on the left|on the right|sidebar/,
  );
  expect(copy).toMatch(/drop/);
});

test('[A2] the rejection toast is not wiped by an unrelated success', async ({ page }) => {
  await dropFiles(page, FIXTURE.txt);
  await expect(page.locator(tid(TESTIDS.errorToast))).toBeVisible();

  await dropFiles(page, FIXTURE.flat512);
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
  await expect(
    page.locator(tid(TESTIDS.errorToast)),
    'the rejection vanished without the user ever acknowledging it',
  ).toBeVisible();
});

test('[A2] the rejection toast dismisses itself instead of sitting forever', async ({ page }) => {
  await dropFiles(page, FIXTURE.gif);
  await expect(page.locator(tid(TESTIDS.errorToast))).toBeVisible();
  await expect(page.locator(tid(TESTIDS.errorToast))).toBeHidden({ timeout: 12_000 });
});

test('[A2] the rejection toast can be dismissed by hand', async ({ page }) => {
  await dropFiles(page, FIXTURE.txt);
  const toast = page.locator(tid(TESTIDS.errorToast));
  await expect(toast).toBeVisible();
  await toast.getByRole('button').first().click();
  await expect(toast).toBeHidden();
});
