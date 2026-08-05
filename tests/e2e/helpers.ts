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
  /** Real artwork (1046x833) — the REFERENCE gold-standard source. Slow enough
   *  to observe in-flight states, busy enough to exercise the quality knobs. */
  artwork: join(FIXTURES, 'reference', 'artwork.png'),
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
    // playwright.config.ts's `use.actionTimeout` only reaches pages created by
    // the browser fixtures; an Electron window needs it set explicitly, and
    // without it a missing testid costs 30s instead of 8 (docs/HARNESS.md).
    page.setDefaultTimeout(8_000);
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

/**
 * Dispatch drag events (without dropping) so the app's drag-hover feedback can
 * be asserted. `dropFiles` covers the drop half; this covers "the window must
 * tell you it will accept the file" (REFERENCE A1).
 */
export async function dragOver(page: Page, testid: string, type: 'dragenter' | 'dragover' | 'dragleave') {
  await page.evaluate(
    ({ selector, type }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
      const el = document.querySelector(selector);
      if (!el) throw new Error(`${selector} not found`);
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { selector: tid(testid), type },
  );
}

// --- SVG structure helpers -------------------------------------------------
// Mirrors of instruments/lib/metrics.mjs, kept small and dependency-free so
// specs can assert on shape economy and layer structure. Anything heavier
// (bounding boxes, fidelity) belongs in the instruments, not here.

/** Parse `#rrggbb` or `rgb(r,g,b)` — REFERENCE D1 documents the latter. */
export function parseColor(value: string): { r: number; g: number; b: number } | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  return null;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Normalize any fill notation to lowercase `#rrggbb` for comparison. */
export function normalizeColor(value: string): string | null {
  const c = parseColor(value);
  return c ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : null;
}

/** Every `<g fill="…">` colour layer in document order, normalized to hex. */
export function layerFills(svg: string): string[] {
  return [...svg.matchAll(/<g[^>]*\bfill="([^"]+)"/g)]
    .map((m) => normalizeColor(m[1]))
    .filter((c): c is string => c !== null);
}

/** Every distinct fill anywhere in the document (`none` excluded). */
export function fillsIn(svg: string): Set<string> {
  const set = new Set<string>();
  for (const m of svg.matchAll(/fill="([^"]+)"/g)) {
    const c = normalizeColor(m[1]);
    if (c) set.add(c);
  }
  return set;
}

/** Every `<g stroke="…">` layer, normalized to hex (REFERENCE B6 stroked style). */
export function layerStrokes(svg: string): string[] {
  return [...svg.matchAll(/<g[^>]*\bstroke="([^"]+)"/g)]
    .map((m) => normalizeColor(m[1]))
    .filter((c): c is string => c !== null);
}

/**
 * Sub-paths (`M`/`m` starts) across every `<path d>`. A tracer that emits one
 * compound path per colour hides every speck inside a single `<path>` element,
 * so this — not `<path>` count — is the honest shape count (REFERENCE Economy).
 */
export function countSubPaths(svg: string): number {
  let n = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) n += (m[1].match(/[Mm]/g) ?? []).length;
  return n;
}

/** Sub-paths that are exactly one source pixel (`h1v1h-1z` and friends). */
export function countPixelSubPaths(svg: string): number {
  let n = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    n += (m[1].match(/[Mm][^MmZz]*?h1v1h-1\s*[Zz]/gi) ?? []).length;
  }
  return n;
}

/** Curve commands / (curve + line) commands. The exemplar scores ~0.64. */
export function curveCommandRatio(svg: string): number {
  let curves = 0;
  let lines = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    curves += (m[1].match(/[CcSsQqTtAa]/g) ?? []).length;
    lines += (m[1].match(/[LlHhVv]/g) ?? []).length;
  }
  return curves + lines === 0 ? 0 : curves / (curves + lines);
}

/** Set a `<select>` by testid, firing input+change the way React expects. */
export async function setSelect(page: Page, id: string, value: string) {
  await page.locator(tid(id)).selectOption(value);
}

/** Set a checkbox by testid to an explicit state (click only if it differs). */
export async function setCheckbox(page: Page, id: string, checked: boolean) {
  const box = page.locator(tid(id));
  if ((await box.isChecked()) !== checked) await box.click();
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
  format: 'svg' | 'eps' | 'dxf' | 'pdf' | 'png',
  exportDir: string,
): Promise<string> {
  const button = {
    svg: TESTIDS.exportSvg,
    eps: TESTIDS.exportEps,
    dxf: TESTIDS.exportDxf,
    pdf: TESTIDS.exportPdf,
    png: TESTIDS.exportPng,
  }[format];
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
