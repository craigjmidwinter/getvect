/**
 * A2 — rejection is a *decision*, not just a message.
 *
 * `isSupportedInput()` filters by extension, which lets a file that is not an
 * image at all through the front door under a `.png` name. When the decoder
 * then throws, the entry must not survive: docs/TESTIDS.md A2 requires a
 * rejected file to show `error-toast` AND not create an `image-list-item`, and
 * nothing about that changes because the rejection happened one step later.
 *
 * The observed failure: a 24-byte text file named `corrupt.png` is added to the
 * sidebar, selected, leaves `status-text` stuck at `error`, and leaves the
 * previous image's byte count next to disabled export buttons — a permanently
 * dead workspace the user can only escape by removing the entry by hand.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE,
  TESTIDS,
  expect,
  loadViaPicker,
  test,
  tid,
  waitForReady,
} from './helpers';

/** A file with a supported extension whose bytes are not an image. */
async function writeCorruptPng(dir: string) {
  const file = join(dir, 'corrupt.png');
  await fs.writeFile(file, 'this is not a PNG, it is a note to self.\n');
  return file;
}

test('[A2] a file that fails to decode leaves no entry behind', async ({ page, exportDir }) => {
  const corrupt = await writeCorruptPng(exportDir);
  await loadViaPicker(page, corrupt);

  await expect(page.locator(tid(TESTIDS.errorToast))).toBeVisible();
  await expect(
    page.locator(tid(TESTIDS.imageListItem)),
    'the undecodable file was added to the image list anyway (docs/TESTIDS.md A2)',
  ).toHaveCount(0);
  await expect(page.locator(tid(TESTIDS.statusText))).toHaveAttribute('data-status', 'idle');
});

test('[A2] a decode failure does not poison the workspace', async ({ page, exportDir }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  const goodBytes = await page.locator(tid(TESTIDS.exportSize)).getAttribute('data-bytes');
  expect(goodBytes).toMatch(/^\d+$/);

  const corrupt = await writeCorruptPng(exportDir);
  await loadViaPicker(page, corrupt);
  await expect(page.locator(tid(TESTIDS.errorToast))).toBeVisible();

  // The good image is still the selected one, still ready, still exportable.
  await expect(page.locator(tid(TESTIDS.imageListItem))).toHaveCount(1);
  await expect(page.locator(tid(TESTIDS.statusText))).toHaveAttribute('data-status', 'ready');
  await expect(page.locator(tid(TESTIDS.exportSvg))).toBeEnabled();
  await expect(page.locator(tid(TESTIDS.exportSize))).toHaveAttribute('data-bytes', goodBytes!);
});

test('[A2] with no result on screen the export size does not describe an old one', async ({
  page,
  exportDir,
}) => {
  // `export-size` is documented as "the byte length of the SVG currently in the
  // preview". With no current SVG there is no honest number to show, so the
  // attribute must be absent or 0 rather than the last image's size sitting
  // next to disabled buttons.
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);
  await page.locator(tid(TESTIDS.imageRemoveButton)).first().click();

  await expect(page.locator(tid(TESTIDS.statusText))).toHaveAttribute('data-status', 'idle');
  const bytes = await page.locator(tid(TESTIDS.exportSize)).getAttribute('data-bytes');
  expect(bytes === null || bytes === '' || bytes === '0', `export-size still reads ${bytes}`).toBe(
    true,
  );
});
