import { app, BrowserWindow } from 'electron';

/**
 * Under test, no window may ever reach the screen.
 *
 * This exists because the polite-by-default settings kept being correct and
 * insufficient. `app.dock.hide()` and `setActivationPolicy('accessory')` stop
 * the app becoming *active*; `showInactive()` was then used on the theory that
 * a window which does not take the keyboard is harmless. It is not. Mapping a
 * window puts it on the screen, and a suite that launches Electron once per
 * spec put dozens of "VECTORIZING…" windows over a human's foreground app
 * mid-game. Not stealing focus is no comfort when you are covering their
 * screen.
 *
 * So the rule is stronger and simpler: under `GETVECT_E2E=1` the calls that can
 * put a window on screen or pull the app forward are neutered. They do not
 * throw — a spec that trips one should fail on the assertion with the full list,
 * not die at the call site with one stack and no context — but they never do
 * what they were asked to do, and every attempt is recorded with the stack that
 * made it.
 *
 * `tests/e2e/z-window-guard.spec.ts` asserts the record is empty and that no
 * window is visible, so a future `show()` cannot quietly come back.
 */

export interface WindowGuardViolation {
  /** The call that was intercepted, e.g. `BrowserWindow#show`. */
  call: string;
  /** Milliseconds since the app started, so a violation can be placed in a run. */
  atMs: number;
  /** Where it was called from, minus the guard's own frames. */
  stack: string;
}

const violations: WindowGuardViolation[] = [];
const started = Date.now();

/** Everything that can map a window or pull the process to the foreground. */
const WINDOW_METHODS = [
  'show',
  'showInactive',
  'focus',
  'moveTop',
  'setAlwaysOnTop',
  'maximize',
  'restore',
  'setFullScreen',
] as const;

function record(call: string): void {
  const stack = (new Error().stack ?? '')
    .split('\n')
    .filter((l) => !l.includes('windowGuard'))
    .slice(1, 6)
    .join('\n');
  violations.push({ call, atMs: Date.now() - started, stack });
}

/**
 * Install the guard. Call before any window is created; a no-op unless `enabled`
 * so nothing here can affect a shipped build.
 */
export function installWindowGuard(enabled: boolean): void {
  if (!enabled) return;

  const proto = BrowserWindow.prototype as unknown as Record<string, unknown>;
  for (const name of WINDOW_METHODS) {
    if (typeof proto[name] !== 'function') continue;
    proto[name] = function guarded(this: BrowserWindow): void {
      record(`BrowserWindow#${name}`);
    };
  }

  // `app.focus()` pulls the whole process forward without touching a window.
  const appAny = app as unknown as Record<string, unknown>;
  if (typeof appAny.focus === 'function') {
    appAny.focus = function guardedAppFocus(): void {
      record('app#focus');
    };
  }

  // A window that is created with `show: true` never calls `show()` — it is
  // already mapped by the time we could intercept anything. Catch that at
  // construction instead of trusting every call site to pass `show: false`.
  app.on('browser-window-created', (_event, win) => {
    if (win.isVisible()) {
      record('BrowserWindow constructed with show: true');
      win.hide();
    }
  });

  /**
   * Exposed as a main-process global rather than over IPC on purpose:
   * `electronApp.evaluate()` runs in the main process and can read this
   * directly, while the renderer — which has no business knowing the guard
   * exists — cannot reach it at all.
   */
  (globalThis as unknown as Record<string, unknown>).__getvectWindowGuard = () => ({
    violations: violations.slice(),
    windows: BrowserWindow.getAllWindows().map((w) => ({
      title: w.getTitle(),
      visible: w.isVisible(),
      focused: w.isFocused(),
    })),
  });
}
