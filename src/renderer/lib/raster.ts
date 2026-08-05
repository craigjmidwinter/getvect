/**
 * Raster plumbing for the renderer: SVG → PNG for the PNG export (REFERENCE
 * D5), and RGBA → PNG for the AI Enhance upload.
 *
 * The engine is pure geometry and has no renderer, so the raster export is
 * produced where a renderer already exists: the SVG that is on screen is drawn
 * into a canvas and read back as PNG bytes. That guarantees the exported PNG is
 * a picture of *the exported vector* — same document, same viewBox — rather
 * than a second-guess re-render of the source image (REFERENCE C3/D1).
 *
 * Everything here is web APIs only, so it works under the acceptance suite.
 */

/**
 * Rasterize an SVG document string to PNG bytes, base64-encoded for the IPC hop
 * to the main process (see `saveExport` in src/main/preload.ts).
 *
 * @param svg     complete standalone SVG document
 * @param width   output width in pixels (source pixels × scale)
 * @param height  output height in pixels
 */
export async function svgToPngBase64(svg: string, width: number, height: number): Promise<string> {
  if (!(width > 0 && height > 0)) throw new Error('PNG export needs a non-zero size');

  const image = await loadSvgImage(svg);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    // No background fill: a vector whose background colour was disabled must
    // export with real transparency, exactly as the SVG renders it.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/png') || comma < 0) {
      throw new Error('canvas did not produce a PNG');
    }
    return dataUrl.slice(comma + 1);
  } finally {
    if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  }
}

/**
 * The largest edge we upload to an AI Enhance provider.
 *
 * The image model returns its own resolution regardless (the reference product
 * resamples too, which is why the enhanced result becomes the new working
 * image), so sending a 6000px scan buys nothing and costs a multi-megabyte
 * base64 body that providers reject outright.
 */
export const ENHANCE_MAX_EDGE = 2048;

/**
 * Encode a decoded raster back to PNG bytes — the payload AI Enhance sends.
 *
 * The *decoded* pixels are re-encoded rather than the original file being
 * forwarded, for two reasons: the source may be a JPEG or a BMP and the
 * provider contract is PNG, and these are the exact pixels the engine would
 * otherwise have traced, so what gets enhanced is what the app was working on.
 */
export async function rasterToPngBytes(
  raster: { width: number; height: number; data: Uint8ClampedArray },
  maxEdge: number = ENHANCE_MAX_EDGE,
): Promise<Uint8Array> {
  const { width, height } = raster;
  if (!(width > 0 && height > 0)) throw new Error('cannot encode an empty image');

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext('2d');
  if (!sourceCtx) throw new Error('2D canvas context unavailable');
  sourceCtx.putImageData(new ImageData(new Uint8ClampedArray(raster.data), width, height), 0, 0);

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  let canvas = source;
  if (scale < 1) {
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }

  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png') || comma < 0) {
    throw new Error('canvas did not produce a PNG');
  }
  return base64ToBytes(dataUrl.slice(comma + 1));
}

/**
 * Does this image carry alpha worth preserving?
 *
 * Not "is any pixel non-opaque": a JPEG decoded through canvas is opaque, and a
 * PNG can carry a handful of antialiased edge pixels without being a sticker.
 * The question the prompt needs answered is "would flattening this onto white
 * change the artwork", so the bar is a real transparent area (0.5 % of the
 * image), which is what a cut-out subject always has and a photo never does.
 */
export function hasMeaningfulAlpha(
  raster: { width: number; height: number; data: Uint8ClampedArray },
  minRatio = 0.005,
): boolean {
  const pixels = raster.width * raster.height;
  if (pixels === 0) return false;
  let transparent = 0;
  const needed = Math.max(1, Math.floor(pixels * minRatio));
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] < 128 && ++transparent >= needed) return true;
  }
  return false;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode an SVG string into an `<img>`.
 *
 * A blob URL is used rather than a `data:` URL because the traced documents run
 * to tens of kilobytes and blob URLs have no length limit. The SVG is fully
 * self-contained (no external references), so the canvas it is drawn into stays
 * untainted and `toDataURL` is allowed to read it back.
 */
function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('the vector result could not be rasterized'));
    };
    img.src = url;
  });
}
