import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Electron main process.
 *
 * Skeleton only: it opens a window onto the renderer and provides the minimal
 * IPC plumbing the acceptance suite needs (file open, export save). Feature
 * work belongs in the renderer + src/engine.
 */

const isE2E = process.env.GETVECT_E2E === '1';
/** Directory used instead of the native save dialog when running under e2e. */
const e2eExportDir = process.env.GETVECT_EXPORT_DIR ?? '';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#12141a',
    title: 'GetVect',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

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

/**
 * REFERENCE D4: native save dialog + write.
 *
 * Under `GETVECT_E2E=1` the dialog is bypassed and the file is written to
 * `GETVECT_EXPORT_DIR/<defaultName>`, so export flows are testable headlessly.
 * The returned shape is identical either way.
 */
ipcMain.handle(
  'export:save',
  async (
    _e,
    payload: { defaultName: string; contents: string; format: 'svg' | 'eps' | 'dxf' },
  ): Promise<{ canceled: boolean; filePath: string | null }> => {
    const { defaultName, contents, format } = payload;

    let target: string | null = null;
    if (isE2E && e2eExportDir) {
      await fs.mkdir(e2eExportDir, { recursive: true });
      target = path.join(e2eExportDir, defaultName);
    } else {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const result = await dialog.showSaveDialog(win!, {
        title: `Export ${format.toUpperCase()}`,
        defaultPath: defaultName,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true, filePath: null };
      target = result.filePath;
    }

    await fs.writeFile(target, contents, 'utf8');
    return { canceled: false, filePath: target };
  },
);

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
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

void app.whenReady().then(() => {
  createWindow();
});
