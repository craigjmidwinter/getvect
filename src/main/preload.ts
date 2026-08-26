import { contextBridge, ipcRenderer } from 'electron';
import type {
  EnhanceKeyResult,
  EnhanceProviderId,
  EnhanceRunRequest,
  EnhanceRunResult,
} from '../shared/aiEnhance';
import { UPDATE_CHANNEL, type UpdateStatus } from '../shared/update';

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

  /**
   * AI Enhance (optional, bring your own key).
   *
   * Note the shape of this surface: a key goes **in**, a boolean comes **out**.
   * There is deliberately no `getKey` — the renderer can save, clear and ask
   * "is one saved?", and nothing else. The key itself never crosses this
   * bridge, so it cannot end up in React state, a devtools snapshot, a crash
   * report or localStorage.
   */
  aiEnhance: {
    setKey: (provider: EnhanceProviderId, key: string): Promise<EnhanceKeyResult> =>
      ipcRenderer.invoke('aiEnhance:setKey', provider, key),
    clearKey: (provider: EnhanceProviderId): Promise<EnhanceKeyResult> =>
      ipcRenderer.invoke('aiEnhance:clearKey', provider),
    hasKey: (provider: EnhanceProviderId): Promise<boolean> =>
      ipcRenderer.invoke('aiEnhance:hasKey', provider),
    /** True when this machine can encrypt a key at rest (Electron safeStorage). */
    /** Cheap and keychain-free — safe to call at mount. */
    available: (): Promise<boolean> => ipcRenderer.invoke('aiEnhance:available'),
    /**
     * The real capability check. MAY PROMPT for the OS keychain password on
     * macOS, so it is only ever sent from a deliberate user action.
     */
    checkStorage: (): Promise<boolean> => ipcRenderer.invoke('aiEnhance:checkStorage'),
    /** Re-illustrate PNG bytes. Always resolves — failures are typed results. */
    run: (request: EnhanceRunRequest): Promise<EnhanceRunResult> =>
      ipcRenderer.invoke('aiEnhance:run', request),
  },

  /**
   * Update check (src/main/updater.ts).
   *
   * Read-only from the renderer's side but for three verbs, none of which can
   * originate a network call the main process was not already going to make:
   * `download` opens the release page (or, in a signed `auto` build, starts the
   * download the check already found), `install` only does anything once
   * something has been downloaded, and `dismiss` writes one version string to
   * disk. There is no `check()` — the check happens once, on the main
   * process's schedule, and a renderer cannot ask for another.
   */
  update: {
    /** Current status; the renderer calls this on mount, then listens. */
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_CHANNEL.status),
    /** Stop showing the banner for this version, permanently. */
    dismiss: (version: string): Promise<UpdateStatus> =>
      ipcRenderer.invoke(UPDATE_CHANNEL.dismiss, version),
    download: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_CHANNEL.download),
    install: (): Promise<UpdateStatus> => ipcRenderer.invoke(UPDATE_CHANNEL.install),
    /** Subscribe to pushes; returns its own unsubscribe. */
    onChanged: (callback: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: UpdateStatus) => callback(status);
      ipcRenderer.on(UPDATE_CHANNEL.changed, listener);
      return () => ipcRenderer.removeListener(UPDATE_CHANNEL.changed, listener);
    },
  },
};

contextBridge.exposeInMainWorld('getvect', api);

export type GetVectApi = typeof api;
