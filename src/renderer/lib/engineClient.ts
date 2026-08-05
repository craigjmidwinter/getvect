/**
 * Renderer-side handle on the vectorization engine.
 *
 * Work runs in a worker (src/renderer/workers/vectorize.worker.ts) so the UI
 * thread stays free while a trace is in flight. The worker is bundled inline by
 * Vite, which instantiates it from a blob URL — that is why index.html's CSP
 * carries `worker-src 'self' blob:`.
 *
 * If a worker cannot be created for any reason the client degrades to running
 * the same engine call on the UI thread rather than failing the conversion; the
 * engine yields to the event loop between phases, so the window still repaints.
 */
import {
  vectorize as vectorizeInline,
  type RasterImage,
  type VectorizeProgress,
  type VectorizeResult,
  type VectorizeSettings,
} from '../../engine';
import VectorizeWorker from '../workers/vectorize.worker?worker&inline';
import type { VectorizeResponse } from '../workers/vectorize.worker';

interface Pending {
  resolve: (result: VectorizeResult) => void;
  reject: (error: Error) => void;
  onProgress?: (p: VectorizeProgress) => void;
  /** Re-run inline if the worker dies mid-flight. */
  retry: () => void;
}

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  try {
    const instance = new VectorizeWorker();
    instance.onmessage = (event: MessageEvent<VectorizeResponse>) => {
      const message = event.data;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') {
        entry.onProgress?.({ phase: message.phase as VectorizeProgress['phase'], progress: message.progress });
        return;
      }
      pending.delete(message.id);
      if (message.type === 'done') entry.resolve(message.result);
      else entry.reject(new Error(message.message));
    };
    instance.onerror = () => {
      // The worker is gone (CSP, bundling, OOM...). Fall back for everything
      // still in flight and for every future call.
      workerUnavailable = true;
      worker = null;
      const stranded = [...pending.values()];
      pending.clear();
      for (const entry of stranded) entry.retry();
    };
    worker = instance;
    return worker;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/** True when tracing is actually running off the UI thread. */
export function usingWorker(): boolean {
  return !workerUnavailable;
}

/**
 * Vectorize an image. `image.data` is copied before transfer, so the caller
 * keeps its raster and can re-vectorize with different settings.
 */
export function vectorizeImage(
  image: RasterImage,
  settings: VectorizeSettings,
  onProgress?: (p: VectorizeProgress) => void,
): Promise<VectorizeResult> {
  const instance = ensureWorker();
  if (!instance) return vectorizeInline(image, settings, onProgress);

  return new Promise<VectorizeResult>((resolve, reject) => {
    const id = nextId++;
    const retry = () => {
      vectorizeInline(image, settings, onProgress).then(resolve, reject);
    };
    pending.set(id, { resolve, reject, onProgress, retry });
    const copy = new Uint8ClampedArray(image.data);
    try {
      instance.postMessage(
        {
          id,
          width: image.width,
          height: image.height,
          data: copy.buffer,
          settings,
        },
        [copy.buffer],
      );
    } catch (error) {
      pending.delete(id);
      workerUnavailable = true;
      worker = null;
      void error;
      retry();
    }
  });
}
