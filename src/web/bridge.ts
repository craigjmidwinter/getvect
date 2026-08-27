/**
 * GetVect in a browser tab — the Electron bridge, reimplemented for the web.
 *
 * There is no port of the engine here, because none is needed. `src/engine/` has
 * no Node-specific code at all, and `src/renderer/workers/vectorize.worker.ts`
 * has always run it in a Web Worker in Chromium. The renderer already decodes
 * with `createImageBitmap` and a canvas (`src/renderer/lib/decode.ts`) — sharp
 * appears nowhere under `src/`. So the web version is the same renderer with a
 * different shell, and this file is the shell.
 *
 * `api()` in src/renderer/api.ts returns `window.getvect` or null. Installing an
 * object there before the app mounts is the entire seam.
 *
 * NOTHING HERE TOUCHES THE NETWORK, and that is the point rather than a
 * side-effect. The claim the whole project rests on is that your image does not
 * leave your machine, and on the web that claim is falsifiable in ten seconds by
 * anyone who opens devtools or turns off their wifi. So:
 *
 *   - no fetch, no XHR, no WebSocket, no beacon, no analytics on the image;
 *   - AI Enhance is NOT offered. It is the one feature that talks to a server,
 *     and a browser has nowhere safe to keep an API key — `safeStorage` does not
 *     exist here, and someone's Gemini key in `localStorage` is a defect you
 *     would be choosing. Leaving it out is what makes "load the page, go
 *     offline, trace an image" true with no asterisk;
 *   - the update channel is not offered either. A page is always current.
 *
 * `tests/engine/web-bridge.test.mjs` asserts the first of those in the source,
 * because "we don't upload anything" is exactly the kind of claim that should
 * not rest on someone remembering.
 */
import type { GetVectApi } from '../renderer/api';

/**
 * Files chosen in this tab, keyed by a synthetic path.
 *
 * The renderer's file API is path-shaped because Electron's is: `openImages()`
 * returns paths and `readFile(path)` returns bytes. A browser has no paths, so
 * these are opaque handles that only mean something to this map. The renderer
 * never parses them — it takes the basename for a label and otherwise passes
 * them straight back, which is why this works without touching App.tsx.
 */
const chosen = new Map<string, File>();

const ACCEPT = '.png,.jpg,.jpeg,.bmp,image/png,image/jpeg,image/bmp';

/** The file picker, as a promise. Resolves empty if the user cancels. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = true;
    input.style.display = 'none';

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])));
    // A cancelled picker fires no `change` in most browsers, which would leave
    // the caller awaiting forever — and the renderer awaits this before it can
    // do anything else. `cancel` is not universal, so the window regaining focus
    // is the backstop: by then the dialog is closed either way.
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(Array.from(input.files ?? [])), 300),
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

/** Save by handing the browser a Blob. No server, no round trip. */
function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a later tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  eps: 'application/postscript',
  dxf: 'application/dxf',
  pdf: 'application/pdf',
  png: 'image/png',
};

export function createWebBridge(version: string): GetVectApi {
  return {
    async openImages(): Promise<string[]> {
      const files = await pickFiles();
      return files.map((file) => {
        // Unique per pick, so choosing the same file twice does not collide with
        // an earlier entry the renderer may still be holding.
        const key = `web:${chosen.size}:${file.name}`;
        chosen.set(key, file);
        return key;
      });
    },

    async readFile(filePath: string): Promise<Uint8Array> {
      const file = chosen.get(filePath);
      if (!file) throw new Error(`no such file in this tab: ${filePath}`);
      return new Uint8Array(await file.arrayBuffer());
    },

    async saveExport(payload): Promise<{ canceled: boolean; filePath: string | null }> {
      const type = MIME[payload.format] ?? 'application/octet-stream';
      const blob =
        payload.encoding === 'base64'
          ? new Blob([Uint8Array.from(atob(payload.contents), (c) => c.charCodeAt(0))], { type })
          : new Blob([payload.contents], { type });
      download(payload.defaultName, blob);
      // A browser download cannot be observed to completion or cancellation, so
      // this reports what is true: it was handed over. Claiming a filePath we
      // cannot know would be worse than admitting we do not know it.
      return { canceled: false, filePath: null };
    },

    async appInfo() {
      return { version, electron: '', e2e: false };
    },
  } as GetVectApi;
}

/** Install the bridge before the app mounts. */
export function installWebBridge(version: string): void {
  (window as unknown as { getvect: GetVectApi }).getvect = createWebBridge(version);
}
