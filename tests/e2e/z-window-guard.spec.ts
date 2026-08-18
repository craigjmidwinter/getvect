import { test, expect, tid, TESTIDS, FIXTURE, loadViaPicker } from './helpers';

/**
 * The suite must never put a window on a human's screen.
 *
 * This is not a nicety. The acceptance suite launches Electron once per spec,
 * and it used to call `showInactive()` on every launch — which does not take
 * keyboard focus but does map the window. The result was dozens of
 * "VECTORIZING…" windows appearing over whatever the person at the machine was
 * doing, in the middle of a timed game. Politeness settings that stop the app
 * becoming *active* (`app.dock.hide()`, `setActivationPolicy('accessory')`) are
 * correct and were never sufficient on their own.
 *
 * So this spec fails if any window is visible or focused, and if anything tried
 * to make one so. `src/main/windowGuard.ts` neuters the calls and records the
 * attempts; without this assertion the guard would be silent and a future
 * `show()` could come back unnoticed.
 *
 * Deliberately runs a REAL workload first — a bare launch proves nothing about
 * the code paths that would want to raise a window when work completes.
 */
test.describe('[harness] the suite is invisible to the person at the machine', () => {
  test('no window is ever shown or focused, through a full vectorize', async ({ app, page }) => {
    await loadViaPicker(page, FIXTURE.fox);
    await expect(page.locator(tid(TESTIDS.appRoot))).toBeVisible();
    // wait for the trace to land, which is the moment a "done!" raise would fire
    await expect(page.locator(tid(TESTIDS.previewVector))).toBeVisible({ timeout: 30_000 });

    const state = await app.evaluate(({ BrowserWindow, app: electronApp }) => ({
      windows: BrowserWindow.getAllWindows().map((w) => ({
        title: w.getTitle(),
        visible: w.isVisible(),
        focused: w.isFocused(),
        minimized: w.isMinimized(),
      })),
      // on macOS an accessory app cannot become active; anywhere else this is
      // still the question worth asking
      appFocused: typeof electronApp.isHidden === 'function' ? !electronApp.isHidden() : null,
    }));

    expect(state.windows.length, 'the app should have a window at all').toBeGreaterThan(0);

    const onScreen = state.windows.filter((w) => w.visible);
    expect(
      onScreen,
      `window(s) visible during the suite: ${JSON.stringify(onScreen)} — see src/main/windowGuard.ts`,
    ).toEqual([]);

    const focused = state.windows.filter((w) => w.focused);
    expect(focused, `window(s) focused during the suite: ${JSON.stringify(focused)}`).toEqual([]);
  });

  test('nothing even attempted to show or raise a window', async ({ app, page }) => {
    await loadViaPicker(page, FIXTURE.flat512);
    await expect(page.locator(tid(TESTIDS.previewVector))).toBeVisible({ timeout: 30_000 });

    const report = await app.evaluate(() => {
      const read = (globalThis as unknown as Record<string, unknown>).__getvectWindowGuard;
      return typeof read === 'function' ? (read as () => unknown)() : null;
    });

    expect(report, 'the window guard is not installed — is installWindowGuard(isE2E) still called?').not.toBeNull();

    const attempts = (report as { violations: { call: string; stack: string }[] }).violations;
    expect(
      attempts,
      'something tried to show, focus or raise a window under test:\n' +
        attempts.map((v) => `  ${v.call}\n${v.stack}`).join('\n'),
    ).toEqual([]);
  });
});
