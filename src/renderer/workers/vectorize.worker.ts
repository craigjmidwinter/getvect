/**
 * Vectorization worker.
 *
 * Tracing a 1024x1024 image is hundreds of milliseconds of tight pixel loops;
 * running it on the UI thread would freeze the window (REFERENCE B1
 * "UI stays responsive"). The engine is pure data-in/data-out, so it drops
 * straight into a worker: the renderer posts the RGBA buffer (transferred, so
 * there is no copy) plus the settings, and gets progress messages and the
 * finished `VectorizeResult` back.
 */
import { vectorize, type RasterImage, type VectorizeSettings } from '../../engine';

export interface VectorizeRequest {
  id: number;
  width: number;
  height: number;
  /** Tightly packed RGBA, transferred from the renderer. */
  data: ArrayBuffer;
  settings: VectorizeSettings;
}

export type VectorizeResponse =
  | { id: number; type: 'progress'; phase: string; progress: number }
  | { id: number; type: 'done'; result: import('../../engine').VectorizeResult }
  | { id: number; type: 'error'; message: string };

const post = (message: VectorizeResponse) => (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent<VectorizeRequest>) => {
  const { id, width, height, data, settings } = event.data;
  try {
    const image: RasterImage = { width, height, data: new Uint8ClampedArray(data) };
    const result = await vectorize(image, settings, (p) => {
      post({ id, type: 'progress', phase: p.phase, progress: p.progress });
    });
    post({ id, type: 'done', result });
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
