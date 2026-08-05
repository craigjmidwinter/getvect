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
 * An exemplar: rasterized so its artwork lands where the source's artwork is.
 *
 * Two cases, and getting them the wrong way round makes every ratio against the
 * exemplar meaningless.
 *
 * **Already in source coordinates.** `fixtures/reference/fox-sticker-clipart-8colors-smartAA.svg`
 * declares `width="1024" height="1024"` for a 1024x1024 source: the real product
 * wrote the source's own pixel dimensions into the file, so the drawing is
 * already registered against the source and the only correct thing to do is
 * rasterize it as declared. Trimming it would be actively wrong — this artwork
 * is a sticker with 76.5 % transparent margin, and cropping to the ink and
 * stretching that to the full frame scored the real product MAE 77.1 (against
 * 3.0 rasterized as declared), i.e. it moved the fox's paw into our muzzle.
 *
 * **Not in source coordinates.** Some captures declare a padded frame and draw
 * the artwork in a corner of it (the retired capture this fallback was first
 * measured on declared an 11520x9280 viewBox for a 1046x833 source and drew
 * inside the top-left quarter of it).
 * Rasterizing *that* box against the source scored the real product MAE 63.55 —
 * worse than any plausible output of ours — because it compared our paw against
 * the exemplar's empty margin. Rendering at 2x, trimming the uniform border and
 * resizing to the source is the comparison a critic makes by hand.
 *
 * The discriminator is the declared size, not a guess about the picture: an
 * exemplar that names the source's dimensions is registered, one that does not
 * has to be aligned by its content.
 */
export async function rasterizeExemplarContent(svg, width, height) {
  const declared = /<svg\b[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/.exec(svg);
  if (declared && Math.round(+declared[1]) === width && Math.round(+declared[2]) === height) {
    const { image } = await rasterizeSvg(svg, width, height);
    return { contentBox: { width, height }, image };
  }
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
