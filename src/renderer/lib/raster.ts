/**
 * SVG → PNG rasterization for the PNG export (REFERENCE D5).
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
