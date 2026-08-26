import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { TESTIDS, expect, test, tid } from './helpers';

/**
 * The update banner (docs/TESTIDS.md, section U).
 *
 * NOTHING HERE TOUCHES THE NETWORK. `GETVECT_UPDATE_STUB=<version>` makes the
 * main process publish an available-update status without opening a socket
 * (src/main/updater.ts, `stubVersion`) — which is also the only way to reach
 * this UI under test, since a real check is refused in anything that is not a
 * packaged build. A suite that hit github.com to test an update banner would be
 * flaky offline, slow everywhere, and would be asserting GitHub's uptime.
 *
 * The claim under test is not "electron-updater works". It is the product
 * behaviour around it: the banner appears, it is not modal, Download is
 * offered rather than taken, dismissal sticks, and the opt-out is honoured.
 */

const STUB_VERSION = '9.9.9';

test.describe('an available update', () => {
  test.use({ extraEnv: { GETVECT_UPDATE_STUB: STUB_VERSION } });

  test('is announced in a dismissible banner, and the dismissal is main-process state', async ({
    page,
    updateDir,
  }) => {
    const banner = page.locator(tid(TESTIDS.updateBanner));

    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-version', STUB_VERSION);
    // Unsigned builds notify; they never claim they will install anything.
    await expect(banner).toHaveAttribute('data-mode', 'notify');
    await expect(banner).toHaveAttribute('data-state', 'available');
    await expect(banner).toContainText(STUB_VERSION);

    // Non-modal: the app underneath is still fully usable. The drop zone is the
    // cheapest proof that nothing is overlaid or focus-trapped.
    await expect(page.locator(tid(TESTIDS.filePickerButton))).toBeEnabled();
    await expect(page.locator(tid(TESTIDS.dropZone))).toBeVisible();

    // In notify mode the action is a link out, not an install: there is a
    // Download button and deliberately no Restart one.
    await expect(page.locator(tid(TESTIDS.updateDownloadButton))).toBeVisible();
    await expect(page.locator(tid(TESTIDS.updateInstallButton))).toHaveCount(0);

    await page.locator(tid(TESTIDS.updateDismissButton)).click();
    await expect(banner).toHaveCount(0);

    // The dismissal must survive a renderer that is reloaded, cleared or
    // running under a CSP with no storage — so it lives in the main process's
    // store, on disk, not in localStorage.
    const stored = JSON.parse(await fs.readFile(join(updateDir, 'update-state.json'), 'utf8'));
    expect(stored).toEqual({ dismissedVersion: STUB_VERSION });
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  });
});

test.describe('the signed-build path, which no shipped build takes yet', () => {
  test.use({
    extraEnv: {
      GETVECT_UPDATE_STUB: STUB_VERSION,
      GETVECT_UPDATE_STUB_STATE: 'downloaded',
      GETVECT_UPDATE_MODE: 'auto',
    },
  });

  test('offers a restart instead of a download once an update is downloaded', async ({ page }) => {
    // `auto` is the mode this app switches to the day it has a Developer ID
    // certificate (electron-builder.yml, `extraMetadata.updateMode`). Until
    // then this spec is the only thing standing between that flip and a broken
    // banner: the UI it exercises ships in every build, dormant.
    const banner = page.locator(tid(TESTIDS.updateBanner));
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-mode', 'auto');
    await expect(banner).toHaveAttribute('data-state', 'downloaded');
    await expect(page.locator(tid(TESTIDS.updateInstallButton))).toBeVisible();
    await expect(page.locator(tid(TESTIDS.updateDownloadButton))).toHaveCount(0);
    // Not clicked: `install` is `quitAndInstall`, and a spec that quits the app
    // under test is a spec that tests the harness's error handling.
  });
});

test.describe('the update-check opt-out', () => {
  test.use({
    extraEnv: { GETVECT_UPDATE_STUB: STUB_VERSION, GETVECT_NO_UPDATE_CHECK: '1' },
  });

  test('suppresses the check entirely, even with an update waiting', async ({ page }) => {
    // GETVECT_NO_UPDATE_CHECK=1 is the documented promise on the site and in
    // the README: no update check, no banner, no exceptions. It is consulted
    // before the stub, so even a forced update stays invisible.
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.locator(tid(TESTIDS.updateBanner))).toHaveCount(0);
  });
});

test.describe('the update-check opt-out, on a build that CAN install', () => {
  test.use({
    extraEnv: {
      GETVECT_UPDATE_STUB: STUB_VERSION,
      GETVECT_UPDATE_MODE: 'auto',
      GETVECT_NO_UPDATE_CHECK: '1',
    },
  });

  test('downloads nothing and shows nothing, even in auto mode', async ({ page }) => {
    // The opt-out matters MORE once a build can install in place. In `notify`
    // mode ignoring it would cost one HTTPS request; in `auto` mode it would
    // start a ~120 MB background download on a machine whose owner asked for no
    // update check at all, and then install it on quit.
    //
    // `skipReason()` is consulted before `check()` is ever scheduled, so no
    // updater is constructed and `autoInstallOnAppQuit` is never set. That
    // ordering is the whole promise, and ordering is exactly what a refactor
    // moves without noticing.
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.locator(tid(TESTIDS.updateBanner))).toHaveCount(0);
    const status = await page.evaluate(() => window.getvect?.update?.status?.());
    // Assert the shape FIRST. `expect(undefined).not.toBe('downloading')` passes
    // for a bridge that does not exist, which would make the two checks below
    // agree with anything — the same vacuous-green shape as a claim regex that
    // matches nothing.
    expect(status, 'the update bridge should be reachable').toBeTruthy();
    expect(status?.mode).toBe('auto');
    expect(status?.state).not.toBe('downloading');
    expect(status?.state).not.toBe('downloaded');
  });
});

test.describe('a launch with nothing new', () => {
  test('shows no banner at all', async ({ page }) => {
    // No stub, not packaged: the check never runs and the status stays idle.
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.locator(tid(TESTIDS.updateBanner))).toHaveCount(0);
  });
});
