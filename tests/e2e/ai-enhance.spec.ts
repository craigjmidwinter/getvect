/**
 * AI Enhance (optional, bring your own key).
 *
 * The feature that sends an image to a third party, so the things worth
 * asserting are the guard rails rather than the picture: the switch cannot be
 * armed without a key, the key never comes back out of the main process, a
 * successful run replaces the working image the engine traces, and a failure
 * falls back to the un-enhanced image with a message rather than hanging or
 * failing silently.
 *
 * **Fully offline.** Under `GETVECT_E2E=1` the provider — and only the provider
 * — is the deterministic local stub in `src/main/aiEnhance.ts`: it returns a
 * fixed 256x160 four-colour PNG, which no fixture resembles, so "the enhanced
 * bitmap became the working image" is a statement about the traced document's
 * own viewBox. The key store is a temp directory per test (`aiDir` in
 * helpers.ts), so the suite never touches the real one.
 */
import {
  FIXTURE,
  TESTIDS,
  expect,
  loadViaPicker,
  previewViewBox,
  saveAiKey,
  setCheckbox,
  test,
  tid,
  waitForReady,
} from './helpers';

/** The stub's canned output — see `STUB_WIDTH`/`STUB_HEIGHT` in src/main/aiEnhance.ts. */
const STUB_SIZE: [number, number] = [256, 160];
/** The stub's canned *JPEG* output — `STUB_JPEG_WIDTH`/`STUB_JPEG_HEIGHT`. */
const STUB_JPEG_SIZE: [number, number] = [192, 128];

test('[AI] the toggle is inert until a key is saved, and live once it is', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const group = page.locator(tid(TESTIDS.aiEnhanceGroup));
  await expect(group).toHaveAttribute('data-has-key', 'false');
  await expect(group).toHaveAttribute('data-enabled', 'false');

  const toggle = page.locator(tid(TESTIDS.aiEnhanceToggle));
  await expect(
    toggle,
    'the AI Enhance switch is live with no key saved — arming it can only produce an error',
  ).toBeDisabled();
  await expect(page.locator(tid(TESTIDS.aiKeyStatus))).toHaveAttribute('data-has-key', 'false');

  await saveAiKey(page, 'e2e-secret-key-1234');
  await expect(toggle).toBeEnabled();
  await expect(group).toHaveAttribute('data-has-key', 'true');

  // ...and clearing it takes the switch away again.
  await page.locator(tid(TESTIDS.aiKeyClearButton)).click();
  await expect(page.locator(tid(TESTIDS.aiKeyStatus))).toHaveAttribute('data-has-key', 'false');
  await expect(toggle).toBeDisabled();
});

test('[AI] the key never comes back to the renderer', async ({ page }) => {
  /**
   * The security claim in one test: after saving, the key must not be
   * recoverable from the field, the DOM, or renderer storage. The main process
   * exposes no `getKey` at all (src/main/preload.ts) — this is the check that
   * nobody adds one, and that the field does not helpfully re-display what was
   * typed into it.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const secret = 'e2e-secret-key-abcdef';
  await saveAiKey(page, secret);

  await expect(
    page.locator(tid(TESTIDS.aiKeyInput)),
    'the key field still holds the key after saving',
  ).toHaveValue('');
  await expect(page.locator(tid(TESTIDS.aiKeyInput))).toHaveAttribute('type', 'password');

  const leaked = await page.evaluate((needle) => {
    const places: string[] = [];
    if (document.documentElement.outerHTML.includes(needle)) places.push('the DOM');
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? '';
      if (k.includes(needle) || (localStorage.getItem(k) ?? '').includes(needle)) {
        places.push(`localStorage[${k}]`);
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i) ?? '';
      if (k.includes(needle) || (sessionStorage.getItem(k) ?? '').includes(needle)) {
        places.push(`sessionStorage[${k}]`);
      }
    }
    // The bridge must offer no way to read one back.
    const bridge = (window as unknown as { getvect?: { aiEnhance?: Record<string, unknown> } }).getvect;
    for (const name of Object.keys(bridge?.aiEnhance ?? {})) {
      if (/^get|read|reveal/i.test(name)) places.push(`window.getvect.aiEnhance.${name}`);
    }
    return places;
  }, secret);
  expect(leaked, `the API key is readable from the renderer via ${leaked.join(', ')}`).toEqual([]);

  // The status readout says whether a key exists, and nothing else.
  await expect(page.locator(tid(TESTIDS.aiKeyStatus))).not.toContainText(secret);
});

test('[AI] the privacy notice is visible at the switch, not in a tooltip', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  const notice = page.locator(tid(TESTIDS.aiEnhanceNotice));
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/sends this image to/i);
  await expect(notice).toContainText(/stays on your machine/i);

  // Rendered text, in the same box as the toggle — not a title attribute and
  // not clipped to nothing.
  const box = await notice.boundingBox();
  expect(box, 'the privacy notice has no box').not.toBeNull();
  expect(box!.height, 'the privacy notice is collapsed to a sliver').toBeGreaterThan(8);
});

test.describe('with the stub slowed down so the in-flight state is observable', () => {
  test.use({ extraEnv: { GETVECT_AI_STUB_DELAY_MS: '1500' } });

  test('[AI] an enhanced run swaps the working image and re-traces it', async ({ page }) => {
    await loadViaPicker(page, FIXTURE.flat512);
    await waitForReady(page);
    expect(await previewViewBox(page), 'the source fixture is 512x512').toEqual([512, 512]);

    await saveAiKey(page, 'e2e-secret-key-1234');
    await page.locator(tid(TESTIDS.aiEnhanceToggle)).click();

    // A distinct progress state, separate from "Tracing…": the image is on its
    // way to a server and the status line has to say so.
    const status = page.locator(tid(TESTIDS.statusText));
    await expect(page.locator(tid(TESTIDS.aiEnhanceStatus))).toHaveAttribute(
      'data-ai-state',
      'running',
    );
    await expect(status).toHaveAttribute('data-status', 'vectorizing');
    await expect(status).toContainText(/enhancing with ai/i);
    await expect(page.locator(tid(TESTIDS.progressIndicator))).toBeVisible();

    // ...then the trace runs on the returned bitmap, at the provider's own
    // dimensions — which is what the real product does.
    await waitForReady(page);
    await expect(page.locator(tid(TESTIDS.aiEnhanceStatus))).toHaveAttribute(
      'data-ai-state',
      'done',
    );
    expect(
      await previewViewBox(page),
      'the traced document is still the source size — the enhanced bitmap did not become the ' +
        'working image',
    ).toEqual(STUB_SIZE);

    // Turning it off puts the original back, without a second provider call.
    await page.locator(tid(TESTIDS.aiEnhanceToggle)).click();
    await waitForReady(page);
    expect(await previewViewBox(page)).toEqual([512, 512]);
    await expect(page.locator(tid(TESTIDS.aiEnhanceStatus))).toHaveAttribute('data-ai-state', 'off');
  });
});

test('[AI] a provider failure falls back to the original image and says why', async ({ page }) => {
  /**
   * `fail-auth` is the stub's stand-in for a bad key (401/403). The outcome
   * that matters is not the error text but what happens around it: the app
   * must trace the un-enhanced image and reach `ready`, never hang on
   * "Enhancing with AI…" and never quietly show a result the user cannot
   * account for.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await saveAiKey(page, 'fail-auth');
  await page.locator(tid(TESTIDS.aiEnhanceToggle)).click();

  const toast = page.locator(tid(TESTIDS.errorToast));
  await expect(toast).toBeVisible();
  await expect(toast, 'the failure message does not name the cause').toContainText(
    /rejected the API key|401|403/i,
  );
  await expect(toast, 'the message does not say what happened to the image instead').toContainText(
    /tracing the original/i,
  );

  await waitForReady(page);
  await expect(page.locator(tid(TESTIDS.aiEnhanceStatus))).toHaveAttribute('data-ai-state', 'failed');
  expect(
    await previewViewBox(page),
    'the fallback did not trace the un-enhanced image',
  ).toEqual([512, 512]);
});

test('[AI] a provider that answers in JPEG is accepted, not rejected as "not a PNG"', async ({
  page,
}) => {
  /**
   * The bug this exists to prevent, in full: `runEnhance` checked the returned
   * bytes against the PNG signature and rejected everything else.
   * `gemini-2.5-flash-image` (the `fast` tier) answers `image/png` and passed;
   * `gemini-3-pro-image-preview` (the `best` tier) answers **`image/jpeg`**, so
   * *every* Best run failed with "the provider did not return a PNG" —
   * 20 seconds and a paid API call to reach a message about the wrong thing.
   *
   * The whole suite stayed green through it because the stub only ever spoke
   * PNG. `reply-jpeg` is the hook that fixes that: the provider's format is now
   * sniffed from the bytes and travels with the image, and the traced document
   * is the JPEG's own size — proof it decoded and became the working bitmap.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await saveAiKey(page, 'reply-jpeg');
  await page.locator(tid(TESTIDS.aiEnhanceToggle)).click();
  await waitForReady(page);

  await expect(page.locator(tid(TESTIDS.aiEnhanceStatus))).toHaveAttribute('data-ai-state', 'done');
  expect(
    await previewViewBox(page),
    'a JPEG reply was refused: the un-enhanced image is what got traced',
  ).toEqual(STUB_JPEG_SIZE);
  await expect(page.locator(tid(TESTIDS.errorToast))).toHaveCount(0);
});

test('[AI] a network failure is reported as a network failure', async ({ page }) => {
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await saveAiKey(page, 'fail-network');
  await page.locator(tid(TESTIDS.aiEnhanceToggle)).click();

  await expect(page.locator(tid(TESTIDS.errorToast))).toContainText(/could not reach/i);
  await waitForReady(page);
  expect(await previewViewBox(page)).toEqual([512, 512]);
});

test('[AI] the classical Enhance switch is untouched by any of it', async ({ page }) => {
  /**
   * Two different features that happen to share a word. The engine's Enhance
   * bundle (denoise + smart AA + area floors) keeps its name, its position and
   * its behaviour; AI Enhance is a separate switch that changes the bitmap
   * *before* the engine sees it. With both on, the AI pass runs first and the
   * classical bundle runs second, inside `vectorize()`.
   */
  await loadViaPicker(page, FIXTURE.flat512);
  await waitForReady(page);

  await setCheckbox(page, TESTIDS.enhanceToggle, true);
  await waitForReady(page);

  await saveAiKey(page, 'e2e-secret-key-1234');
  await page.locator(tid(TESTIDS.aiEnhanceToggle)).click();
  await waitForReady(page);

  await expect(
    page.locator(tid(TESTIDS.enhanceToggle)),
    'arming AI Enhance changed the classical Enhance switch',
  ).toBeChecked();
  expect(await previewViewBox(page), 'both switches on: the AI bitmap is what got traced').toEqual(
    STUB_SIZE,
  );
});
