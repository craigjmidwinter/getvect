#!/usr/bin/env node
/**
 * `npm run screenshots` — visual evidence harness.
 *
 * Launches the built Electron app with Playwright and walks the whole product
 * flow (load -> vectorize -> settings -> palette -> preview modes -> zoom ->
 * export), dropping a labelled PNG after every step into
 * artifacts/screenshots/ plus a manifest.json describing what happened.
 *
 * Unlike `npm test` this NEVER fails the run: steps that are not implemented
 * yet are recorded as `skipped` with the reason, and the screenshot is still
 * taken. The point is a before/after contact sheet for each lap, not a gate.
 */
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shotDir = join(root, 'artifacts', 'screenshots');
const fixtures = join(root, 'fixtures');
const tid = (id) => `[data-testid="${id}"]`;

const T = {
  fileInput: 'file-input',
  imageListItem: 'image-list-item',
  statusText: 'status-text',
  colorCount: 'color-count',
  detail: 'detail',
  paletteEditor: 'palette-editor',
  paletteSwatch: 'palette-swatch',
  enhanceToggle: 'enhance-toggle',
  previewToggle: 'preview-toggle',
  previewSideBySide: 'preview-side-by-side',
  zoomIn: 'zoom-in',
  zoomFit: 'zoom-fit',
  exportSvg: 'export-svg',
  exportStatus: 'export-status',
};

const log = [];
let index = 0;

async function shot(page, label) {
  index += 1;
  const name = `${String(index).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: join(shotDir, name), fullPage: false });
  return name;
}

/** Run a step; never throw. Always screenshot. */
async function step(page, label, fn) {
  const started = Date.now();
  let status = 'ok';
  let reason = null;
  try {
    await fn();
  } catch (err) {
    status = 'skipped';
    reason = String(err.message ?? err).split('\n')[0];
  }
  const file = await shot(page, label);
  log.push({ step: label, status, reason, file, ms: Date.now() - started });
  console.log(`${status === 'ok' ? '✓' : '·'} ${label}${reason ? ` — ${reason}` : ''}`);
}

const click = (page, id) => page.locator(tid(id)).click({ timeout: 4000 });

async function setValue(page, id, value) {
  await page.locator(tid(id)).evaluate((node, v) => {
    const input = node;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function waitReady(page, timeout = 20000) {
  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('data-status') === 'ready',
    tid(T.statusText),
    { timeout },
  );
}

async function main() {
  await fs.rm(shotDir, { recursive: true, force: true });
  await fs.mkdir(shotDir, { recursive: true });
  const exportDir = mkdtempSync(join(tmpdir(), 'getvect-shots-'));

  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, GETVECT_E2E: '1', GETVECT_EXPORT_DIR: exportDir },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Keep unimplemented steps cheap: fail fast rather than sitting on the 30s default.
  page.setDefaultTimeout(5000);
  await page.waitForTimeout(600);

  await step(page, 'launch-drop-zone', async () => {});

  await step(page, 'images-loaded', async () => {
    await page.setInputFiles(tid(T.fileInput), [
      join(fixtures, 'logo-flat-512.png'),
      join(fixtures, 'logo-noisy-512.png'),
      join(fixtures, 'photo-gradient-512x384.jpg'),
    ], { timeout: 5000 });
    await page.locator(tid(T.imageListItem)).first().waitFor({ timeout: 5000 });
  });

  await step(page, 'auto-vectorized-defaults', () => waitReady(page));

  await step(page, 'settings-low-color-count', async () => {
    await setValue(page, T.colorCount, 3);
    await waitReady(page);
  });

  await step(page, 'settings-low-detail', async () => {
    await setValue(page, T.detail, 10);
    await waitReady(page);
  });

  await step(page, 'palette-editor', async () => {
    await page.locator(tid(T.paletteEditor)).waitFor({ timeout: 4000 });
    await page.locator(tid(T.paletteSwatch)).first().click({ timeout: 4000 });
  });

  await step(page, 'second-image-noisy', async () => {
    await page.locator(tid(T.imageListItem)).nth(1).click({ timeout: 4000 });
    await waitReady(page);
  });

  await step(page, 'enhance-enabled', async () => {
    await click(page, T.enhanceToggle);
    await waitReady(page);
  });

  await step(page, 'preview-toggle-original', () => click(page, T.previewToggle));
  await step(page, 'preview-side-by-side', () => click(page, T.previewSideBySide));

  await step(page, 'zoomed-in', async () => {
    await click(page, T.zoomIn);
    await click(page, T.zoomIn);
  });

  await step(page, 'zoom-fit', () => click(page, T.zoomFit));

  await step(page, 'exported-svg', async () => {
    await click(page, T.exportSvg);
    await page
      .locator(`${tid(T.exportStatus)}[data-last-export-path]`)
      .waitFor({ timeout: 10000 });
  });

  await app.close();
  await fs.rm(exportDir, { recursive: true, force: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    ok: log.filter((l) => l.status === 'ok').length,
    skipped: log.filter((l) => l.status !== 'ok').length,
    steps: log,
  };
  await fs.writeFile(join(shotDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\n${manifest.ok} ok · ${manifest.skipped} skipped`);
  console.log(`screenshots in ${shotDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
