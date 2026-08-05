/**
 * Update check — the second, and last, thing in GetVect that touches the
 * network.
 *
 * WHAT IT DOES. Once per launch, a packaged build asks the GitHub Releases
 * feed whether there is a newer GetVect. If there is, the renderer gets a
 * dismissible banner with a Download link. That is the whole of it: no
 * telemetry, no identifiers, no second request, no polling. If the machine is
 * offline the check fails, the failure goes to the log, and the app is
 * indistinguishable from one that found nothing.
 *
 * THREE WAYS TO SWITCH IT OFF, in the order they are consulted:
 *   1. `GETVECT_NO_UPDATE_CHECK=1` in the environment — the user's opt-out,
 *      documented in the README and on the site.
 *   2. not a packaged build — `npm start`, `npm run dev` and the e2e suite
 *      never reach the network.
 *   3. the check itself failing, which is a no-op by design.
 *
 * NOTIFY VS AUTO. See src/shared/update.ts for why an unsigned macOS build
 * cannot silently self-update. Both paths live here; `UPDATE_MODE` picks one.
 *
 * WHERE electron-updater COMES FROM. Not from `node_modules`. The packaged app
 * excludes node_modules outright (electron-builder.yml, `files`), so the
 * updater is compiled into `dist/main/vendor/electron-updater.js` by
 * `scripts/bundle-updater.mjs` and required from there — lazily, inside a
 * try/catch, so a build that somehow lacks the bundle loses its update check
 * and nothing else. Types come from the real package via `import type`, which
 * emits no require at all.
 */
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import {
  UPDATE_CHANNEL,
  releaseUrlFor,
  type UpdateMode,
  type UpdateStatus,
} from '../shared/update';

const isE2E = process.env.GETVECT_E2E === '1';

/** Prefix for every line this module logs, so it is greppable in a crash report. */
function log(message: string, detail?: unknown): void {
  if (detail === undefined) console.log(`[updater] ${message}`);
  else console.log(`[updater] ${message}`, detail);
}

// --- mode ------------------------------------------------------------------

/**
 * `notify` today, `auto` the day the app is signed.
 *
 * The value is baked into the packaged `package.json` by electron-builder's
 * `extraMetadata.updateMode`, so it is a property of the *build*, not of the
 * source: a signed build and an unsigned build can come off the same commit and
 * behave correctly. Read once, at startup, and never re-read.
 *
 * `GETVECT_UPDATE_MODE` overrides it. That is not a user-facing knob — it is
 * how the dormant `auto` path stays exercisable (and reviewable) while the
 * shipped builds are all `notify`.
 */
export function readUpdateMode(): UpdateMode {
  const override = process.env.GETVECT_UPDATE_MODE;
  if (override === 'auto' || override === 'notify') return override;
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { updateMode?: string };
    return pkg.updateMode === 'auto' ? 'auto' : 'notify';
  } catch {
    // A missing or unreadable package.json means a development checkout, and
    // the conservative answer is the one that downloads nothing.
    return 'notify';
  }
}

// --- the dismissal store ---------------------------------------------------
//
// Deliberately main-process state on disk, not localStorage: the renderer is
// reloadable, clearable and (under a stricter CSP) not guaranteed storage at
// all, and "I already said no to 0.2.0" must survive all three. One version
// string is the entire contents; there is nothing here worth encrypting.

interface UpdateStore {
  /** The version whose banner the user dismissed, if any. */
  dismissedVersion?: string;
}

function storeDir(): string {
  if (isE2E) return process.env.GETVECT_UPDATE_DIR || path.join(app.getPath('temp'), 'getvect-e2e-update');
  return app.getPath('userData');
}

function storePath(): string {
  return path.join(storeDir(), 'update-state.json');
}

async function readStore(): Promise<UpdateStore> {
  try {
    return JSON.parse(await fs.readFile(storePath(), 'utf8')) as UpdateStore;
  } catch {
    return {};
  }
}

async function writeStore(store: UpdateStore): Promise<void> {
  try {
    await fs.mkdir(storeDir(), { recursive: true });
    await fs.writeFile(storePath(), JSON.stringify(store), 'utf8');
  } catch (err) {
    // Not being able to remember a dismissal is a papercut, not a failure.
    log('could not persist the dismissal', err);
  }
}

// --- status ----------------------------------------------------------------

let status: UpdateStatus = {
  mode: 'notify',
  state: 'idle',
  version: null,
  currentVersion: '0.0.0',
  releaseUrl: null,
  dismissed: false,
  progress: null,
};

/** The version the user has already waved away, loaded once at init. */
let dismissedVersion: string | null = null;

function publish(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next };
  // `dismissed` is derived, never stored: it is "did they say no to *this*
  // version". Keeping it as independent state is how a dismissal of 0.2.0
  // silently swallows the banner for 0.3.0.
  status.dismissed = status.version !== null && dismissedVersion === status.version;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_CHANNEL.changed, status);
  }
}

/** Current status — exported for tests and for the `update:status` handler. */
export function updateStatus(): UpdateStatus {
  return status;
}

// --- the check itself ------------------------------------------------------

/** Lazily loaded so a missing vendor bundle costs the update check and nothing else. */
let updater: AppUpdater | null = null;

function loadUpdater(): AppUpdater | null {
  if (updater) return updater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vendored = require('./vendor/electron-updater.js') as typeof import('electron-updater');
    updater = vendored.autoUpdater;
    return updater;
  } catch (err) {
    log('electron-updater is not in this build; skipping the check', err);
    return null;
  }
}

/**
 * `GETVECT_UPDATE_STUB=<version>` fakes an available update without a socket.
 *
 * This is how the acceptance suite reaches the banner
 * (tests/e2e/u-update-banner.spec.ts) and how a developer can look at it under
 * `npm start`. It is honoured only in builds that could not have reached the
 * network anyway — unpackaged, or under `GETVECT_E2E=1` — so no shipped app has
 * a code path that invents an update.
 *
 * `GETVECT_UPDATE_STUB_STATE` picks which state it publishes. That is what
 * keeps the dormant `auto` path (downloading → downloaded → Restart) reachable
 * and asserted while every shipped build is `notify`: dead UI is UI that will
 * be broken on the day it matters.
 */
function stubVersion(): string | null {
  const stub = process.env.GETVECT_UPDATE_STUB;
  if (!stub) return null;
  if (app.isPackaged && !isE2E) {
    log('GETVECT_UPDATE_STUB ignored in a packaged build');
    return null;
  }
  return stub;
}

/** Why we are not checking, or null if we are. */
function skipReason(): string | null {
  if (process.env.GETVECT_NO_UPDATE_CHECK === '1') return 'GETVECT_NO_UPDATE_CHECK=1';
  if (stubVersion()) return null;
  if (!app.isPackaged) return 'not a packaged build';
  if (isE2E) return 'GETVECT_E2E=1';
  return null;
}

/**
 * Wire the updater's events onto our status. Split out so the `auto` branch is
 * plain reading rather than a nest of conditionals — every listener here runs
 * in both modes; only `autoDownload` decides whether the download ones ever
 * fire.
 */
function attach(u: AppUpdater, mode: UpdateMode): void {
  u.autoDownload = mode === 'auto';
  u.autoInstallOnAppQuit = mode === 'auto';
  // electron-updater is chatty at info level and this app has no log file; the
  // lines that matter are the ones below.
  u.logger = null;

  u.on('update-available', (info: UpdateInfo) => {
    log(`update available: ${info.version} (mode=${mode})`);
    publish({
      state: mode === 'auto' ? 'downloading' : 'available',
      version: info.version,
      releaseUrl: releaseUrlFor(info.version),
    });
  });

  u.on('update-not-available', () => {
    log('up to date');
    publish({ state: 'up-to-date' });
  });

  u.on('download-progress', (progress: { percent: number }) => {
    publish({ state: 'downloading', progress: Math.max(0, Math.min(1, progress.percent / 100)) });
  });

  u.on('update-downloaded', (info: UpdateInfo) => {
    log(`update downloaded: ${info.version}`);
    publish({
      state: 'downloaded',
      version: info.version,
      releaseUrl: releaseUrlFor(info.version),
      progress: 1,
    });
  });

  u.on('error', (err: Error) => {
    // The whole failure surface — no network, DNS, rate limit, malformed feed,
    // and (in `auto` mode on an unsigned build) Squirrel refusing the install.
    // None of it is the user's problem and none of it interrupts them.
    log('check failed (silently)', err?.message ?? err);
    publish({ state: 'error' });
  });
}

/**
 * Run the one check.
 *
 * Called a few seconds after the window is up so it never competes with the
 * first paint, and never awaited by anything that matters.
 */
async function check(mode: UpdateMode): Promise<void> {
  const stub = stubVersion();
  if (stub) {
    const stubbed = process.env.GETVECT_UPDATE_STUB_STATE;
    const state =
      stubbed === 'downloading' || stubbed === 'downloaded'
        ? stubbed
        : mode === 'auto'
          ? 'downloading'
          : 'available';
    log(`stubbed update: ${stub} (${state})`);
    publish({
      state,
      version: stub,
      releaseUrl: releaseUrlFor(stub),
      progress: state === 'downloaded' ? 1 : state === 'downloading' ? 0.42 : null,
    });
    return;
  }

  const u = loadUpdater();
  if (!u) return;
  attach(u, mode);
  publish({ state: 'checking' });
  try {
    await u.checkForUpdates();
  } catch (err) {
    log('check failed (silently)', err instanceof Error ? err.message : err);
    publish({ state: 'error' });
  }
}

// --- IPC + init ------------------------------------------------------------

/**
 * Register the update IPC and, unless something says not to, schedule the one
 * check. Safe to call unconditionally at `whenReady`.
 */
export function registerUpdaterIpc(): void {
  const mode = readUpdateMode();
  status = { ...status, mode, currentVersion: app.getVersion() };

  ipcMain.handle(UPDATE_CHANNEL.status, () => status);

  ipcMain.handle(UPDATE_CHANNEL.dismiss, async (_e, version: string) => {
    dismissedVersion = version;
    await writeStore({ dismissedVersion: version });
    publish({ dismissed: true });
    return status;
  });

  /**
   * The Download button. In `notify` mode this hands off to the browser — the
   * honest thing to do when we cannot install what we would download. In `auto`
   * mode it starts the background download instead, and the banner turns into a
   * progress line.
   */
  ipcMain.handle(UPDATE_CHANNEL.download, async () => {
    if (status.mode === 'auto') {
      const u = loadUpdater();
      if (!u) return status;
      publish({ state: 'downloading', progress: 0 });
      try {
        await u.downloadUpdate();
      } catch (err) {
        log('download failed (silently)', err instanceof Error ? err.message : err);
        publish({ state: 'error' });
      }
      return status;
    }
    const url = status.releaseUrl;
    if (url) await shell.openExternal(url);
    return status;
  });

  /** `auto` only: relaunch into the downloaded version. */
  ipcMain.handle(UPDATE_CHANNEL.install, () => {
    if (status.mode !== 'auto' || status.state !== 'downloaded') return status;
    const u = loadUpdater();
    if (!u) return status;
    log('quitting to install');
    u.quitAndInstall();
    return status;
  });

  const loaded = readStore().then((store) => {
    dismissedVersion = store.dismissedVersion ?? null;
    publish({});
  });

  const skip = skipReason();
  if (skip) {
    log(`no update check: ${skip}`);
    return;
  }

  // A short delay after ready: the window is painted, the user is looking at
  // their work, and a socket opening behind it costs them nothing. Under e2e
  // the stub answers immediately — a suite should not spend seconds waiting for
  // politeness. The store has to be read first either way, or a dismissal made
  // last launch loses a race with this launch's answer.
  const delay = isE2E ? 150 : 4_000;
  setTimeout(() => void loaded.then(() => check(mode)), delay);
}
