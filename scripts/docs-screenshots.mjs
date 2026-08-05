#!/usr/bin/env node
/**
 * `npm run docs:screenshots` — regenerate the three screenshots README.md shows.
 *
 * The contact sheet from `npm run screenshots` is evidence for a lap; these
 * three are the app's public face, so they have to be reproducible rather than
 * hand-captured — otherwise they drift, and a stale marketing shot showing a
 * clipped settings panel is a bug report nobody filed. Each shot is taken at
 * the app's own default window size, at 1x, with a fixed set of fixtures, so
 * re-running this on the same build gives the same pictures.
 *
 * Writes docs/assets/screenshot-{side-by-side,zoom-sync,palette}.png.
 * Requires a build first (`npm run build`), like `npm start` does.
 */
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, 'docs', 'assets');
const fixtures = join(root, 'fixtures');
const tid = (id) => `[data-testid="${id}"]`;
/** The app's default window width — shots wider than this are HiDPI buffers. */
const SHOT_WIDTH = 1280;

async function write(page, name) {
  const file = join(assets, `${name}.png`);
  const buffer = await page.screenshot({ fullPage: false });
  const meta = await sharp(buffer).metadata();
  if (meta.width > SHOT_WIDTH) {
    await sharp(buffer).resize({ width: SHOT_WIDTH }).png({ compressionLevel: 9 }).toFile(file);
  } else {
    await fs.writeFile(file, buffer);
  }
  console.log(`✓ ${name}.png (${Math.min(meta.width, SHOT_WIDTH)}px)`);
}

const waitReady = (page, timeout = 30000) =>
  page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('data-status') === 'ready',
    tid('status-text'),
    { timeout },
  );

async function main() {
  await fs.mkdir(assets, { recursive: true });
  const exportDir = mkdtempSync(join(tmpdir(), 'getvect-docs-'));
  const app = await electron.launch({
    args: [root, '--force-device-scale-factor=1'],
    cwd: root,
    env: { ...process.env, GETVECT_E2E: '1', GETVECT_EXPORT_DIR: exportDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.setDefaultTimeout(10000);
  await page.waitForTimeout(600);

  await page.setInputFiles(tid('file-input'), [
    join(fixtures, 'logo-flat-512.png'),
    join(fixtures, 'logo-noisy-512.png'),
    join(fixtures, 'photo-gradient-512x384.jpg'),
  ]);
  await waitReady(page);

  // 1. Side by side, on the noisy source: the pitch is "grain in, clean vector
  //    out", so the shot has to show both halves of that at once.
  await page.locator(tid('image-list-item')).nth(1).click();
  await waitReady(page);
  await page.locator(tid('enhance-toggle')).check();
  await waitReady(page);
  await page.locator(tid('preview-side-by-side')).click();
  await page.waitForTimeout(400);
  await write(page, 'screenshot-side-by-side');

  // 2. The same pair, zoomed in far enough that the edges are the subject —
  //    and zoomed *together*, which is REFERENCE C2's synchronized pan/zoom.
  for (let i = 0; i < 6; i++) await page.locator(tid('zoom-in')).click();
  await page.waitForTimeout(400);
  await write(page, 'screenshot-zoom-sync');

  // 3. The colour surface: input palette, swatch editor and — pinned below
  //    them — the output colour groups (REFERENCE B3).
  await page.locator(tid('zoom-fit')).click();
  await page.locator(tid('preview-toggle')).click();
  await page.locator(tid('image-list-item')).first().click();
  await waitReady(page);
  await page.locator(`${tid('palette-size-option')}[data-size="6"]`).click();
  await waitReady(page);
  await page.locator(tid('palette-swatch')).first().click();
  await page.waitForTimeout(300);
  await write(page, 'screenshot-palette');

  await app.close();
  await fs.rm(exportDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
