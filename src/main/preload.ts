import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge. Keep this surface small and typed; the renderer must never
 * get raw `ipcRenderer` or Node APIs.
 */
const api = {
  /** REFERENCE A1 — open the native picker, resolve to absolute paths. */
  openImages: (): Promise<string[]> => ipcRenderer.invoke('dialog:openImages'),
  /** Read a file the user picked/dropped as raw bytes. */
  readFile: (filePath: string): Promise<Uint8Array> => ipcRenderer.invoke('file:read', filePath),
  /**
   * REFERENCE D4 — native save dialog + write.
   *
   * `contents` is always a string; binary formats (PNG) pass `encoding:
   * 'base64'` and the main process decodes before writing.
   */
  saveExport: (payload: {
    defaultName: string;
    contents: string;
    format: 'svg' | 'eps' | 'dxf' | 'pdf' | 'png';
    encoding?: 'utf8' | 'base64';
  }): Promise<{ canceled: boolean; filePath: string | null }> =>
    ipcRenderer.invoke('export:save', payload),
  appInfo: (): Promise<{ version: string; electron: string; e2e: boolean }> =>
    ipcRenderer.invoke('app:info'),
};

contextBridge.exposeInMainWorld('getvect', api);

export type GetVectApi = typeof api;
