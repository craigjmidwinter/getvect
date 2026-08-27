import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  /** Real artwork (1024x1024, 76.5% transparent) — the REFERENCE gold-standard
   *  source. Slow enough to observe in-flight states, busy enough to exercise
   *  the quality knobs, and transparent enough to catch an invented backdrop. */
  fox: join(FIXTURES, 'reference', 'fox-sticker.png'),
  /** 384x256, antialiased on purpose: outlined spikes over two flat bands. The
   *  only fixture whose ink edges carry a real one-pixel ramp, which is what
   *  makes it the honest subject for the zoom-sharpness measurements (C4). */
  spikes: join(FIXTURES, 'spikes-bands-384.png'),
  /** 256x256 with a fully transparent surround — the checkerboard subject (C5). */
  stickerAlpha: join(FIXTURES, 'sticker-alpha-256.png'),
} as const;

export { TESTIDS, expect };

/** `[data-testid="..."]` selector for a documented id (docs/TESTIDS.md). */
export const tid = (id: string) => `[data-testid="${id}"]`;

type Fixtures = {
  app: ElectronApplication;
  page: Page;
  /** Directory the app writes exports into while GETVECT_E2E=1 (bypasses the native dialog). */
  exportDir: string;
  /**
   * Directory the AI Enhance key store uses while GETVECT_E2E=1.
   *
   * Test-scoped on purpose: a suite that wrote to `app.getPath('userData')`
   * would read, overwrite and delete the developer's own saved key, and on
   * macOS `safeStorage` would reach into their login keychain to do it. Under
   * e2e the store is this temp directory and safeStorage is never called
   * (src/main/aiEnhance.ts, `keyStoreDir`).
   */
  aiDir: string;
  /**
   * Directory the update check's dismissal store uses while GETVECT_E2E=1.
   *
   * Same reasoning as `aiDir`: `app.getPath('userData')` is the developer's own
   * state, and a suite that dismissed an update banner there would silently
   * suppress it on their machine (src/main/updater.ts, `storeDir`). Specs read
   * `update-state.json` out of this directory to prove the dismissal is
   * main-process state and not localStorage.
   */
  updateDir: string;
  /**
   * Directory the one-time prompt store uses while GETVECT_E2E=1.
   *
   * Per test, and that matters more here than for the other stores: the prompt
   * is once-per-install by design, so a shared directory would let the first
   * test that exports consume it for all the others — the feature working
   * exactly as intended, looking like a bug.
   */
  promptsDir: string;
};

type Options = {
  /**
   * Extra environment for the Electron launch, for specs that need to steer a
   * main-process branch — e.g. `GETVECT_AI_STUB_DELAY_MS` to widen the window
   * in which an in-flight state is observable. Use with `test.use({...})`.
   */
  extraEnv: Record<string, string>;
};

export const test = base.extend<Fixtures & Options>({
  extraEnv: [{}, { option: true }],

  exportDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'getvect-export-'));
    await use(dir);
    await fs.rm(dir, { recursive: true, force: true });
  },

  promptsDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'getvect-prompts-'));
    await use(dir);
    await fs.rm(dir, { recursive: true, force: true });
  },

  aiDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'getvect-ai-'));
    await use(dir);
    await fs.rm(dir, { recursive: true, force: true });
  },

  updateDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'getvect-update-'));
    await use(dir);
    await fs.rm(dir, { recursive: true, force: true });
  },

  app: async ({ exportDir, aiDir, updateDir, promptsDir, extraEnv }, use) => {
    const app = await electron.launch({
      args: [REPO_ROOT],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GETVECT_E2E: '1',
        GETVECT_EXPORT_DIR: exportDir,
        GETVECT_AI_DIR: aiDir,
        GETVECT_UPDATE_DIR: updateDir,
        GETVECT_PROMPTS_DIR: promptsDir,
        NODE_ENV: 'test',
        ...extraEnv,
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

/**
 * Save an AI Enhance key through the UI.
 *
 * Under e2e the stored value also steers the offline stub: `fail-auth`,
 * `fail-network`, `fail-timeout` and `fail-bad-response` make the run come back
 * with that typed error, which is how the fallback path is exercised without a
 * network (src/main/aiEnhance.ts, `stub`).
 */
export async function saveAiKey(page: Page, key: string) {
  await page.locator(tid(TESTIDS.aiKeyInput)).fill(key);
  await page.locator(tid(TESTIDS.aiKeySaveButton)).click();
  await expect(page.locator(tid(TESTIDS.aiKeyStatus))).toHaveAttribute('data-has-key', 'true');
}

/** The `viewBox` of the SVG currently in the preview, as `[w, h]`. */
export async function previewViewBox(page: Page): Promise<[number, number]> {
  const svg = await previewSvg(page);
  const match = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  if (!match) throw new Error(`no viewBox in the preview SVG: ${svg.slice(0, 120)}`);
  return [Number(match[1]), Number(match[2])];
}

/**
 * Zoom to an exact factor (1 = 100%).
 *
 * The buttons only move in 1.25 steps from whatever Fit happens to be, so a
 * spec that wants "exactly 400%" has to go through the wheel. The handler is
 * `zoom' = zoom * WHEEL_STEP ** -deltaY` with `WHEEL_STEP = 1.0015` (App.tsx),
 * which inverts to the delta below; sent from the pane centre, the pointer
 * offset is zero, so the pan does not move and the framing stays deterministic.
 */
export async function zoomTo(page: Page, target: number) {
  const level = page.locator(tid(TESTIDS.zoomLevel));
  const current = Number(await level.getAttribute('data-zoom'));
  const box = await page.locator(tid(TESTIDS.previewPane)).boundingBox();
  if (!box) throw new Error('preview pane has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -Math.log(target / current) / Math.log(1.0015));
  await expect
    .poll(async () => Number(await level.getAttribute('data-zoom')), {
      message: `zoom did not reach ${target}`,
    })
    .toBeCloseTo(target, 3);
}

/**
 * Wait until the stage has been re-laid-out at the current zoom.
 *
 * The layout size (and therefore the rasterization) lags the zoom by up to a
 * frame on purpose — see `useLayoutZoom` in Preview.tsx. Anything that measures
 * pixels has to wait for the resting state rather than catch a transient.
 *
 * Past the stage's layout ceiling (`MAX_STAGE_PX`, i.e. beyond ~16x on a 1024px
 * image) `data-render-zoom` deliberately stops short of `data-zoom` and the
 * remainder is a transform again. "Settled" there means "stopped moving".
 */
export async function waitForSettledRender(page: Page) {
  for (const id of [TESTIDS.previewOriginal, TESTIDS.previewVector]) {
    const read = () =>
      page
        .locator(tid(id))
        .evaluate((el) => [el.getAttribute('data-render-zoom'), el.getAttribute('data-zoom')]);
    await expect
      .poll(
        async () => {
          const [render, zoom] = await read();
          if (render === zoom) return true;
          await page.waitForTimeout(80);
          return (await read())[0] === render;
        },
        { message: `${id} never settled: data-render-zoom kept moving` },
      )
      .toBe(true);
  }
}

/**
 * Screenshot one preview view and hand back its pixels.
 *
 * `scale` is captured pixels per CSS pixel — 1 on a normal display, 2 on a
 * Retina one — so a measurement in device pixels can be stated in CSS pixels
 * and mean the same thing on both.
 */
export interface PanePixels {
  width: number;
  height: number;
  scale: number;
  /** Rec.709 luminance, 0-255. */
  lum(x: number, y: number): number;
  /** `"r,g,b"`, for exact-colour comparisons like the checkerboard. */
  rgb(x: number, y: number): string;
}

export async function capturePane(page: Page, testid: string): Promise<PanePixels> {
  const sharp = createRequire(__filename)('sharp');
  const locator = page.locator(tid(testid));
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${testid} has no bounding box`);
  const { data, info } = await sharp(await locator.screenshot())
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => (y * info.width + x) * info.channels;
  return {
    width: info.width,
    height: info.height,
    scale: info.width / box.width,
    lum: (x, y) => {
      const o = at(x, y);
      return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    },
    rgb: (x, y) => {
      const o = at(x, y);
      return `${data[o]},${data[o + 1]},${data[o + 2]}`;
    },
  };
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

/**
 * Choose an Enhance mode (docs/TESTIDS.md B4).
 *
 * `enhance-toggle` is one `<select>` with three answers — `off` (trace the
 * image as it arrived), `local` (the engine's denoise/simplify bundle) and `ai`
 * (send it to the provider and trace what comes back, which *replaces* the
 * local bundle). It was two independent checkboxes that read as the same switch
 * twice; the `ai` option is disabled until a key is saved.
 */
export async function setEnhanceMode(page: Page, mode: 'off' | 'local' | 'ai') {
  await page.locator(tid(TESTIDS.enhanceToggle)).selectOption(mode);
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
