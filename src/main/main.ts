import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { registerAiEnhanceIpc } from './aiEnhance';
import { registerUpdaterIpc } from './updater';
import { installWindowGuard } from './windowGuard';
import { looksLikeCliInvocation } from '../cli';

/**
 * IS THIS A COMMAND-LINE RUN? Decided from argv, at module load, before
 * anything can put a window on screen.
 *
 * Homebrew's shim execs Electron against the app directory and passes every
 * remaining argument straight through, so a user typing `getvect logo.png` has
 * always been handing this process an image path. It used to ignore it and open
 * a window; now it traces and exits, which is why brew's command needs no
 * formula change and the dmg gets a CLI for free.
 *
 * `process.defaultApp` is true when Electron was pointed at a directory
 * (`electron .`, and that shim), in which case the directory is argv[1] and the
 * user's arguments start at 2. In a packaged app they start at 1.
 */
const CLI_ARGV = process.defaultApp ? process.argv.slice(2) : process.argv.slice(1);
const IS_CLI = looksLikeCliInvocation(CLI_ARGV);

/**
 * Electron main process.
 *
 * Skeleton only: it opens a window onto the renderer and provides the minimal
 * IPC plumbing the acceptance suite needs (file open, export save). Feature
 * work belongs in the renderer + src/engine.
 */

const isE2E = process.env.GETVECT_E2E === '1';

/**
 * Under e2e the app must be invisible to the human's session from the *first
 * frame*, not from `whenReady`.
 *
 * `showInactive()` and `setActivationPolicy('accessory')` (both below) are
 * correct and both happen too late: macOS activates a freshly launched GUI
 * process in the window between exec and app-ready, so a suite that launches
 * Electron once per spec still steals focus dozens of times. `app.dock.hide()`
 * is synchronous, legal before ready, and makes the process LSUIElement-like
 * immediately — which closes that window.
 */
if (isE2E && process.platform === 'darwin') {
  try {
    app.dock?.hide();
  } catch {
    /* headless / non-macOS builds have no dock; nothing to hide */
  }
}

// Before anything can construct a window: under test, neuter every call that
// could put one on screen and record the attempt. See src/main/windowGuard.ts.
installWindowGuard(isE2E);

/**
 * Application identity — everything that makes the running process say
 * "GetVect" instead of "Electron".
 *
 * All of it is skipped under e2e on purpose. `setName()` moves
 * `app.getPath('userData')`, which is where the AI Enhance key store lives, and
 * a Dock icon is the opposite of what the suite wants (see the `dock.hide()`
 * note above). Under test the app keeps its default identity and stays
 * invisible; identity work must not be observable by the harness.
 */
const isPackaged = app.isPackaged;

/**
 * Absolute path to a brand asset. In development the compiled main process
 * lives at `dist/main/`, so `build/` is two levels up; in a packaged app the
 * same files are copied next to the bundle's resources (see the
 * `extraResources` block in package.json's `build` config).
 */
function brandAsset(name: string): string {
  return isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', '..', 'build', name);
}

/** `build/icon.png` if it is actually there — the repo can be used without it. */
function appIconPath(): string | undefined {
  const candidate = brandAsset('icon.png');
  return existsSync(candidate) ? candidate : undefined;
}

if (!isE2E) {
  // Before `whenReady`: the default application menu is built at ready from
  // `app.name`, and setting the name afterwards leaves it stale.
  //
  // What this does and does not buy, measured on macOS: in *development* the
  // leftmost menu title is the running bundle's CFBundleName — literally
  // `node_modules/electron/dist/Electron.app` — and no API can change it, so it
  // still reads "Electron". What does change is everything derived from
  // `app.name`: "About GetVect", "Hide GetVect", "Quit GetVect", and the
  // window/notification identity. A packaged build has CFBundleName=GetVect
  // (electron-builder.yml) and gets the menu title too.
  app.setName('GetVect');
}

/**
 * The bundled third-party licence notice, or undefined if this build has none.
 *
 * Generated at build time into `build/third-party/` and shipped by
 * `extraResources`, because MIT, BSD and Apache-2.0 require their text to
 * accompany the DISTRIBUTION — a notice that only exists in the repository does
 * not discharge that.
 */
function thirdPartyNotice(): string | undefined {
  const dir = isPackaged
    ? path.join(process.resourcesPath, 'third-party')
    : path.join(__dirname, '..', '..', 'build', 'third-party');
  const file = path.join(dir, 'THIRD-PARTY-LICENSES.md');
  return existsSync(file) ? file : undefined;
}

/**
 * Put the notice somewhere a person can actually reach.
 *
 * Electron's native About panel takes no custom buttons, so "reachable from
 * About" means a menu item next to it. The app otherwise runs on the default
 * menu, so this rebuilds that menu from standard roles — which keeps every
 * default behaviour (copy, paste, quit, window management, the About item
 * itself) rather than reimplementing them — and appends one entry.
 *
 * If the notice is missing the item is not added, because a menu entry that
 * opens nothing is worse than no entry: it tells the reader the file exists.
 */
function installLicenceMenu(): void {
  const notice = thirdPartyNotice();
  if (!notice) return;

  const openNotice = {
    label: 'Third-Party Licences',
    click: () => void shell.openPath(notice),
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'GetVect',
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              openNotice,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'GetVect on GitHub',
          click: () => void shell.openExternal('https://github.com/craigjmidwinter/getvect'),
        },
        // On macOS this is the second way in; on Windows and Linux, where there
        // is no native About panel, it is the only one.
        openNotice,
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Dock icon + About panel. Called at ready, never under e2e. */
function applyAppIdentity(): void {
  app.setAboutPanelOptions({
    applicationName: 'GetVect',
    applicationVersion: app.getVersion(),
    // The licence belongs on the same surface as the copyright. A bare © with
    // no licence named reads as all-rights-reserved to anyone who does not
    // already know, which quietly contradicts the one fact this project most
    // wants a reader to notice.
    copyright: '© 2026 Craig Midwinter · MIT Licensed',
    website: 'https://github.com/craigjmidwinter/getvect',
  });

  installLicenceMenu();

  // A packaged .app already carries its icon in the bundle (CFBundleIconFile ->
  // icon.icns), which is higher fidelity than a single 512px PNG; only dev runs
  // need the override, otherwise `npm start` shows the default Electron atom.
  if (process.platform === 'darwin' && !isPackaged) {
    const icon = appIconPath();
    if (icon) {
      try {
        app.dock?.setIcon(icon);
      } catch {
        /* no dock (headless / non-macOS build): nothing to brand */
      }
    }
  }
}

/** Directory used instead of the native save dialog when running under e2e. */
const e2eExportDir = process.env.GETVECT_EXPORT_DIR ?? '';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const icon = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#12141a',
    title: 'GetVect',
    // Ignored on macOS (the bundle/Dock owns the icon there); this is what puts
    // the fox in the window decoration and taskbar on Linux and Windows.
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Not the hardened default, and not free to flip: with `sandbox: true`
      // 33 acceptance specs fail (the AI-enhance stubs and the export paths —
      // measured 2026-08-20). contextIsolation plus the typed preload bridge
      // is the boundary the renderer actually gets; closing the sandbox too
      // means reworking how the e2e harness stubs the main process first.
      sandbox: false,
      // A window that is never shown is a background window, and Chromium
      // throttles timers and rAF in those. Under test that turns into slow,
      // flaky specs, so the throttle comes off — the window is hidden for the
      // human's sake, not to make it idle.
      ...(isE2E ? { backgroundThrottling: false } : {}),
    },
  });

  /**
   * Under e2e the window is never put on screen at all.
   *
   * This used to be `showInactive()`, on the theory that not taking keyboard
   * focus was enough. It is not: `showInactive` still *maps the window*, so a
   * suite that launches Electron once per spec throws dozens of "VECTORIZING…"
   * windows over whatever the human is doing. Not stealing the keyboard is no
   * comfort when the window is covering their screen.
   *
   * Playwright drives the renderer over CDP, which needs no visible surface, and
   * `paintWhenInitiallyHidden` (on by default) keeps the compositor running so
   * the DOM still lays out and paints. `installWindowGuard` above neuters the
   * calls that could undo this, and tests/e2e/z-window-guard.spec.ts fails if
   * anything tries.
   */
  if (!isE2E) mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- IPC -------------------------------------------------------------------

const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }];

/** REFERENCE A1: file picker path of ingest. Returns absolute paths. */
ipcMain.handle('dialog:openImages', async (): Promise<string[]> => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    title: 'Open images',
    properties: ['openFile', 'multiSelections'],
    filters: IMAGE_FILTERS,
  });
  return result.canceled ? [] : result.filePaths;
});

/** Read an image file as raw bytes so the renderer can decode it. */
ipcMain.handle('file:read', async (_e, filePath: string): Promise<Uint8Array> => {
  const buf = await fs.readFile(filePath);
  return new Uint8Array(buf);
});

/** Export formats the save handler knows how to label and name (REFERENCE D1-D3, D5). */
type ExportFormat = 'svg' | 'eps' | 'dxf' | 'pdf' | 'png';

const FORMAT_LABEL: Record<ExportFormat, string> = {
  svg: 'SVG image',
  eps: 'Encapsulated PostScript',
  dxf: 'AutoCAD DXF',
  pdf: 'PDF document',
  png: 'PNG image',
};

/**
 * Directory of the last successful export, used as the starting point for the
 * next one. Saving four formats of the same artwork should not mean navigating
 * back to the same folder four times.
 */
let lastExportDir: string | null = null;

interface SaveExportPayload {
  defaultName: string;
  contents: string;
  format: ExportFormat;
  /** How `contents` is encoded. `base64` is how binary formats (PNG) travel. */
  encoding?: 'utf8' | 'base64';
}

/**
 * REFERENCE D4: native save dialog + write.
 *
 * Under `GETVECT_E2E=1` the dialog is bypassed and the file is written to
 * `GETVECT_EXPORT_DIR/<defaultName>`, so export flows are testable headlessly
 * (docs/TESTIDS.md, "Export dialog under test"). This is the ONLY place that
 * knows about tests: the IPC hop, the default filename and the file write are
 * the same code either way, so the suite exercises the production path.
 */
ipcMain.handle(
  'export:save',
  async (_e, payload: SaveExportPayload): Promise<{ canceled: boolean; filePath: string | null }> => {
    const { defaultName, contents, format, encoding = 'utf8' } = payload;
    if (typeof contents !== 'string') throw new TypeError('export:save expects string contents');

    let target: string;
    if (isE2E && e2eExportDir) {
      await fs.mkdir(e2eExportDir, { recursive: true });
      target = path.join(e2eExportDir, withExtension(defaultName, format));
    } else {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const suggested = withExtension(defaultName, format);
      const result = await dialog.showSaveDialog(win!, {
        title: `Export ${format.toUpperCase()}`,
        defaultPath: lastExportDir ? path.join(lastExportDir, suggested) : suggested,
        filters: [
          { name: `${FORMAT_LABEL[format] ?? format.toUpperCase()} (*.${format})`, extensions: [format] },
          { name: 'All files', extensions: ['*'] },
        ],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return { canceled: true, filePath: null };
      // A user who types "logo" in the dialog means "logo.svg"; macOS in
      // particular does not append the filter's extension for you.
      target = withExtension(result.filePath, format);
      lastExportDir = path.dirname(target);
    }

    // Binary formats arrive base64-encoded because the IPC payload is a string.
    const data = encoding === 'base64' ? Buffer.from(contents, 'base64') : Buffer.from(contents, 'utf8');
    await fs.writeFile(target, data);
    return { canceled: false, filePath: target };
  },
);

/** Ensure `name` ends in `.<format>`, case-insensitively. */
function withExtension(name: string, format: string): string {
  return name.toLowerCase().endsWith(`.${format.toLowerCase()}`) ? name : `${name}.${format}`;
}

/**
 * AI Enhance (optional, bring your own key) — the key store and the provider
 * call, both main-process only. See src/main/aiEnhance.ts for why the renderer
 * gets booleans and never the key.
 */
registerAiEnhanceIpc();

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  e2e: isE2E,
}));

// --- lifecycle -------------------------------------------------------------

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // A CLI run has no windows by design, so the macOS "reopen" gesture must not
  // conjure one — that would be the failure this whole path exists to prevent,
  // arriving late.
  if (IS_CLI) return;
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

void app.whenReady().then(async () => {
  /**
   * The command-line path, and it RETURNS — it never falls through to the GUI
   * boot below. `createWindow()` is called further down in this same callback,
   * so returning here is what guarantees no window; `activate` returns early for
   * the same reason.
   *
   * `app.exit` rather than `app.quit`: quit runs the normal lifecycle, and
   * `window-all-closed` on a run that never opened a window is a different path
   * that would discard the exit code the caller is waiting on.
   */
  if (IS_CLI) {
    const { runHeadless } = await import('./cliMain');
    let code = 70;
    try {
      code = await runHeadless(CLI_ARGV);
    } catch (err) {
      process.stderr.write(`getvect: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    app.exit(code);
    return;
  }

  if (isE2E) {
    if (process.platform === 'darwin') {
      // Accessory apps get no Dock icon and cannot become the active app, so
      // test runs stay invisible to the user's session. Must be set before any
      // window shows.
      app.setActivationPolicy('accessory');
    }
  } else {
    applyAppIdentity();
  }
  createWindow();

  /**
   * The update check — the app's second and last network touchpoint, after
   * optional AI Enhance.
   *
   * Registered unconditionally because the IPC handlers must exist for the
   * renderer to ask "anything new?" and get an honest "no". Whether a socket is
   * ever opened is decided inside (src/main/updater.ts): a packaged build with
   * no `GETVECT_NO_UPDATE_CHECK=1` checks once, and nothing else does.
   */
  registerUpdaterIpc();
});
