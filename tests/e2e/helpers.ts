import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { TESTIDS } from '../../src/shared/testids';

export const REPO_ROOT = resolve(__dirname, '../..');
export const FIXTURES = resolve(REPO_ROOT, 'fixtures');

export const FIXTURE = {
  flat512: join(FIXTURES, 'logo-flat-512.png'),
  noisy512: join(FIXTURES, 'logo-noisy-512.png'),
  flat1024: join(FIXTURES, 'logo-flat-1024.png'),
  jpeg: join(FIXTURES, 'photo-gradient-512x384.jpg'),
  bmp: join(FIXTURES, 'shapes-256.bmp'),
  gif: join(FIXTURES, 'unsupported-animation.gif'),
  txt: join(FIXTURES, 'unsupported-notes.txt'),
} as const;

export { TESTIDS, expect };

/** `[data-testid="..."]` selector for a documented id (docs/TESTIDS.md). */
export const tid = (id: string) => `[data-testid="${id}"]`;

type Fixtures = {
  app: ElectronApplication;
  page: Page;
  /** Directory the app writes exports into while GETVECT_E2E=1 (bypasses the native dialog). */
  exportDir: string;
};

export const test = base.extend<Fixtures>({
  exportDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'getvect-export-'));
    await use(dir);
    await fs.rm(dir, { recursive: true, force: true });
  },

  app: async ({ exportDir }, use) => {
    const app = await electron.launch({
      args: [REPO_ROOT],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GETVECT_E2E: '1',
        GETVECT_EXPORT_DIR: exportDir,
        NODE_ENV: 'test',
      },
    });
    await use(app);
    await app.close();
  },

  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

/**
 * Load images through the hidden `<input type="file">` the drop zone must
 * expose (TESTIDS.fileInput). This is the file-picker half of REFERENCE A1 and
 * the most deterministic way to inject files into an Electron renderer.
 */
export async function loadViaPicker(page: Page, ...files: string[]) {
  await page.setInputFiles(tid(TESTIDS.fileInput), files);
}

/**
 * Simulate a real drag-and-drop onto the drop zone by constructing a
 * DataTransfer with actual File objects in the renderer.
 *
 * DOM CONTRACT: the drop handler must read `event.dataTransfer.files` and
 * consume the File objects with web APIs (arrayBuffer/createImageBitmap).
 * It must NOT depend on Electron's non-standard `File.path`, or drag-drop
 * becomes untestable.
 */
export async function dropFiles(page: Page, ...files: string[]) {
  const payload = await Promise.all(
    files.map(async (f) => ({
      name: basename(f),
      type: mimeFor(f),
      base64: (await fs.readFile(f)).toString('base64'),
    })),
  );
  await page.evaluate(
    ({ payload, dropSelector }) => {
      const dt = new DataTransfer();
      for (const item of payload) {
        const bin = atob(item.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], item.name, { type: item.type }));
      }
      const zone = document.querySelector(dropSelector);
      if (!zone) throw new Error(`drop zone ${dropSelector} not found`);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      }
    },
    { payload, dropSelector: tid(TESTIDS.dropZone) },
  );
}

function mimeFor(file: string): string {
  const f = file.toLowerCase();
  if (f.endsWith('.png')) return 'image/png';
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'image/jpeg';
  if (f.endsWith('.bmp')) return 'image/bmp';
  if (f.endsWith('.gif')) return 'image/gif';
  return 'text/plain';
}

/** Wait until the workspace reports a finished vectorization (data-status="ready"). */
export async function waitForReady(page: Page, timeout = 25_000) {
  await expect(page.locator(tid(TESTIDS.statusText))).toHaveAttribute('data-status', 'ready', {
    timeout,
  });
}

/** The SVG markup currently shown in the vector preview (REFERENCE C3). */
export async function previewSvg(page: Page): Promise<string> {
  return page.locator(`${tid(TESTIDS.previewVector)} svg`).first().evaluate((el) => el.outerHTML);
}

/** Set a range/number input by testid and fire input+change. */
export async function setSlider(page: Page, id: string, value: number) {
  const el = page.locator(tid(id));
  await el.evaluate((node, v) => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** Click an export button and return the path the app wrote. */
export async function exportAs(
  page: Page,
  format: 'svg' | 'eps' | 'dxf',
  exportDir: string,
): Promise<string> {
  const button = { svg: TESTIDS.exportSvg, eps: TESTIDS.exportEps, dxf: TESTIDS.exportDxf }[format];
  await page.locator(tid(button)).click();
  const status = page.locator(tid(TESTIDS.exportStatus));
  await expect(status).toHaveAttribute('data-last-export-path', /.+/, { timeout: 15_000 });
  const written = await status.getAttribute('data-last-export-path');
  if (!written) throw new Error('export status did not report a path');
  const files = await fs.readdir(exportDir);
  if (!files.some((f) => written.endsWith(f))) {
    throw new Error(`export path ${written} is not inside the e2e export dir (${files.join(', ')})`);
  }
  return written;
}
