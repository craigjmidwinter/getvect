/**
 * Fixture decoding for the headless instruments.
 *
 * PNG/JPEG go through sharp. BMP is decoded here because libvips has no BMP
 * loader — the app itself never needs this (Chromium decodes BMP natively),
 * it exists so the instruments can measure the BMP fixture too.
 *
 * All decoders return the engine's `RasterImage` shape:
 *   { width, height, data: Uint8ClampedArray /* RGBA, top-left origin *\/ }
 */
import { promises as fs } from 'node:fs';
import { extname } from 'node:path';
import sharp from 'sharp';

export async function decodeImageFile(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.bmp') return decodeBmp(await fs.readFile(file));

  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected 4 channels from ${file}, got ${info.channels}`);
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

/** Uncompressed 24/32-bit BI_RGB BMP (what scripts/generate-fixtures.mjs writes). */
export function decodeBmp(buf) {
  if (buf.readUInt16LE(0) !== 0x4d42) throw new Error('not a BMP (bad magic)');
  const pixelOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) throw new Error(`unsupported BMP header size ${headerSize}`);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (compression !== 0) throw new Error(`unsupported BMP compression ${compression}`);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported BMP bit depth ${bpp}`);

  const bytesPerPixel = bpp / 8;
  const rowBytes = width * bytesPerPixel;
  const stride = rowBytes + ((4 - (rowBytes % 4)) % 4);
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const srcRow = bottomUp ? height - 1 - y : y;
    let o = pixelOffset + srcRow * stride;
    let d = y * width * 4;
    for (let x = 0; x < width; x++) {
      const b = buf[o++];
      const g = buf[o++];
      const r = buf[o++];
      const a = bpp === 32 ? buf[o++] : 255;
      out[d++] = r;
      out[d++] = g;
      out[d++] = b;
      out[d++] = a;
    }
  }
  return { width, height, data: out };
}

/**
 * Emulate what the app's ingest actually hands the engine.
 *
 * `src/renderer/lib/decode.ts` draws the decoded bitmap into a 2D canvas and
 * reads `getImageData()`. Canvas stores premultiplied 8-bit RGBA and
 * unpremultiplies on read, so a pixel that is fully transparent comes back as
 * `(0,0,0,0)` no matter what colour the file recorded there — which is why the
 * instruments must not feed the engine `flattenOnWhite()` pixels the UI can
 * never produce (see docs/HARNESS.md "One decode contract").
 */
export function canvasIngest(image) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i + 3] = a;
    if (a === 0) continue; // premultiply -> 0, unpremultiply -> 0/0 -> 0
    for (let c = 0; c < 3; c++) {
      const premultiplied = Math.round((data[i + c] * a) / 255);
      out[i + c] = Math.round((premultiplied * 255) / a);
    }
  }
  return { width, height, data: out };
}

/** Fraction of pixels the file marks as (near-)transparent. */
export function transparentRatio(image, threshold = 128) {
  let n = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < threshold) n++;
  return n / (image.width * image.height);
}

/** Flatten RGBA onto white — comparisons are done on opaque images. */
export function flattenOnWhite(image) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}
