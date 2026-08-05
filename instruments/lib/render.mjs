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
import { flattenOnWhite } from './decode.mjs';
import { meanColorError } from './metrics.mjs';

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
 * declares `width="1024" height="1024"` for a 1024x1024 source: the reference product
 * wrote the source's own pixel dimensions into the file, so the drawing is
 * already registered against the source and the only correct thing to do is
 * rasterize it as declared. Trimming it would be actively wrong — this artwork
 * is a sticker with 76.5 % transparent margin, and cropping to the ink and
 * stretching that to the full frame scored the reference product MAE 77.1 (against
 * 3.0 rasterized as declared), i.e. it moved the fox's paw into our muzzle.
 *
 * **Not in source coordinates.** Some captures declare a padded frame and draw
 * the artwork in a corner of it (the retired capture this fallback was first
 * measured on declared an 11520x9280 viewBox for a 1046x833 source and drew
 * inside the top-left quarter of it).
 * Rasterizing *that* box against the source scored the reference product MAE 63.55 —
 * worse than any plausible output of ours — because it compared our paw against
 * the exemplar's empty margin. Rendering at 2x, trimming the uniform border and
 * resizing to the source is the comparison a critic makes by hand.
 *
 * **The discriminator cannot be the declared size, and it cannot be the aspect
 * ratio either.** Exact-match-on-declared-size was the first rule, and the
 * mascot broke it from the other direction: its capture declares 1184x896 for an
 * 1195x896 source — the reference product trimmed 11 px of transparent margin — so an
 * exemplar that is registered to within 1 % failed the equality test and went
 * down the trim path. That path then made things much worse, because this
 * artwork is a die-cut sticker whose outermost feature is a WHITE BORDER:
 * flattened on white it is indistinguishable from the page, the trim ate it, and
 * what survived got stretched over the frame at an aspect ratio the drawing does
 * not have. The reference product scored MAE 37.8 and 0.34 ink recall — numbers that
 * describe a misregistration, not a tracer. Rasterized straight to the source
 * frame the same file scores MAE 4.3 and 0.997.
 *
 * Aspect ratio does not separate the two cases: the retired padded capture
 * declared 11520x9280 for a 1046x833 source, which is within 1.2 % of the
 * source's aspect while the artwork sits in one corner of it.
 *
 * So the registration is CHOSEN BY MEASUREMENT. Both candidates are built and
 * scored against the source, and the better one wins. That is the comparison a
 * critic makes by hand — you align two pictures before judging them — and it is
 * a choice between exactly two alignments, so it cannot flatter an exemplar into
 * looking like anything other than what it is. `registration` in the returned
 * object names which one was used, and the instruments print it.
 *
 * With no source to score against, the old declared-size heuristic stands.
 */
export async function rasterizeExemplarContent(svg, width, height, source = null) {
  const declared = /<svg\b[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/.exec(svg);
  const declaredMatches =
    declared && Math.round(+declared[1]) === width && Math.round(+declared[2]) === height;

  /** Candidate A: the file is already in source coordinates. */
  const asFrame = async () => ({
    registration: 'frame',
    contentBox: { width, height },
    image: (await rasterizeSvg(svg, width, height)).image,
  });

  /** Candidate B: the artwork sits inside a padded frame; crop to it and fit. */
  const asContent = async () => {
    const big = new Resvg(svg, {
      fitTo: { mode: 'width', value: width * 2 },
      background: 'white',
      font: { loadSystemFonts: false },
    })
      .render()
      .asPng();
    const trimmed = await sharp(big)
      .flatten({ background: '#fff' })
      .trim({ threshold: 10 })
      .toBuffer();
    const meta = await sharp(trimmed).metadata();
    const { data, info } = await sharp(trimmed)
      .resize(width, height, { fit: 'fill' })
      .flatten({ background: '#fff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      registration: 'content',
      contentBox: { width: meta.width, height: meta.height },
      image: {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      },
    };
  };

  if (!source) return declaredMatches ? asFrame() : asContent();

  const candidates = [await asFrame(), await asContent()];
  let best = null;
  for (const candidate of candidates) {
    const error = meanColorError(source, flattenOnWhite(candidate.image));
    candidate.registrationError = error;
    if (!best || error < best.registrationError) best = candidate;
  }
  best.registrationRejected = candidates
    .filter((c) => c !== best)
    .map((c) => ({ registration: c.registration, meanColorError: c.registrationError }));
  return best;
}
