/**
 * Raster decoding for the renderer.
 *
 * Ingest (drag-drop and the file picker) both end up here: a `File`/`Blob` in,
 * a tightly packed RGBA `RasterImage` out — exactly the shape src/engine wants.
 * Decoding deliberately uses only web APIs (`createImageBitmap`, `<img>`,
 * `<canvas>`) so it works on the synthetic `File` objects the acceptance suite
 * drops, which have no `path` property (docs/TESTIDS.md "Drag-and-drop").
 */
import type { RasterImage } from '../../engine';

export interface DecodedRaster extends RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Decode any supported blob (PNG/JPEG/BMP) into RGBA pixels. */
export async function decodeBlob(blob: Blob): Promise<DecodedRaster> {
  const bitmap = await toBitmap(blob);
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (!width || !height) throw new Error('decoded image has zero size');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    return { width, height, data: imageData.data };
  } finally {
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) bitmap.close();
  }
}

async function toBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> decoder (older BMP variants, mainly) */
    }
  }
  return loadImageElement(blob);
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the file could not be decoded as an image'));
    };
    img.src = url;
  });
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  gif: 'image/gif',
};

/** Best-effort MIME type for a path/filename — used for picker-sourced files. */
export function mimeForName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Filename component of a path, POSIX or Windows. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Filename without its extension — the stem used for export default names (D4). */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
