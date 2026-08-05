/**
 * SVG -> pixels, the way every measurement in this repo does it.
 *
 * Both the instruments and the engine tests rasterize output and exemplars, and
 * they must do it identically or the numbers in `artifacts/metrics.json` and the
 * numbers in a `node --test` failure message describe different pictures. So
 * both import from here.
 */
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

/** Our own output: rasterized straight against its declared viewBox. */
export async function rasterizeSvg(svg, width, height) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'white',
    font: { loadSystemFonts: false },
  });
  const png = resvg.render().asPng();
  const { data, info } = await sharp(png)
    .resize(width, height, { fit: 'fill', kernel: 'nearest' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    png,
    image: {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    },
  };
}

/**
 * An exemplar: rasterized from its **content box**, not its viewBox.
 *
 * `fixtures/reference/artwork.svg` declares an 11520x9280 viewBox and draws its
 * artwork in the top-left quarter of it. Rasterizing that box against the source
 * scored the real product a mean colour error of 63.55 — worse than any
 * plausible output of ours — so every ratio against it was meaningless, and a
 * "we beat the exemplar" assertion written that way passes for the wrong reason
 * (it compares our paw against the exemplar's empty margin). Rendering at 2x,
 * trimming the uniform border and resizing to the source is the comparison a
 * critic makes by hand: the same exemplar then scores MAE 13.50 / SSIM 0.886 /
 * ink recall 0.973.
 *
 * For an exemplar that already fills its frame the trim is a no-op, so this is
 * safe for every exemplar we ship.
 */
export async function rasterizeExemplarContent(svg, width, height) {
  const big = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * 2 },
    background: 'white',
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  const trimmed = await sharp(big).flatten({ background: '#fff' }).trim({ threshold: 10 }).toBuffer();
  const meta = await sharp(trimmed).metadata();
  const { data, info } = await sharp(trimmed)
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: '#fff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    contentBox: { width: meta.width, height: meta.height },
    image: {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    },
  };
}
