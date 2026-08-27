/**
 * A PNG decoder, because both command-line front doors must agree exactly.
 *
 * WHY NOT `nativeImage`, THE OBVIOUS ANSWER FOR AN ELECTRON BUILD.
 *
 * `nativeImage.toBitmap()` returns **premultiplied** BGRA. Undoing that does not
 * reproduce straight alpha: Chromium already rounded when it premultiplied, and
 * rounding a second time to undo it lands somewhere else. Measured on
 * `fixtures/third-party/sticker-figure-900.png` — 38,598 semi-transparent
 * pixels — the unpremultiplied bitmap and the app's own ingest hash differently.
 * So a CLI built on `nativeImage` would trace soft-edged artwork slightly
 * differently from the standalone CLI, and the two front doors would quietly
 * disagree about the same file.
 *
 * That divergence is invisible in the easy case, which is what makes it worth a
 * decoder. A hard-edged sticker has NO semi-transparent pixels, so every hash
 * matches and the approach looks correct — `frankie-sticker.png` agrees four
 * ways. Only artwork with a soft edge shows the problem.
 *
 * WHY NOT sharp, THE OTHER OBVIOUS ANSWER. `electron-builder.yml` excludes
 * `node_modules/**` from the packaged app, deliberately, to keep sharp's LGPL
 * libvips out of a distributed build. So the packaged app cannot have it, and a
 * decoder it can have is the only way the app itself can trace.
 *
 * SCOPE. 8-bit non-interlaced PNG in all five colour types, which is what every
 * exporter this app is aimed at produces. Anything else is REFUSED with a
 * specific message rather than decoded approximately — a wrong picture that
 * traces successfully is worse than an error, because nothing downstream can
 * tell.
 */
import { inflateSync } from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, straight (non-premultiplied) alpha, top-left origin. */
  data: Uint8ClampedArray;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes per pixel for each PNG colour type at 8 bits. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf: Buffer): DecodedImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('not a PNG (bad signature)');
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];

  let p = 8;
  while (p < buf.length) {
    const length = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const start = p + 8;
    switch (type) {
      case 'IHDR':
        width = buf.readUInt32BE(start);
        height = buf.readUInt32BE(start + 4);
        depth = buf[start + 8];
        colorType = buf[start + 9];
        interlace = buf[start + 12];
        break;
      case 'PLTE':
        palette = buf.subarray(start, start + length);
        break;
      case 'tRNS':
        transparency = buf.subarray(start, start + length);
        break;
      case 'IDAT':
        idat.push(buf.subarray(start, start + length));
        break;
      default:
        break;
    }
    if (type === 'IEND') break;
    p = start + length + 4; // + CRC
  }

  if (!width || !height) throw new Error('PNG has no IHDR');
  // Refuse rather than approximate. Both are rare in exported artwork, and a
  // silently mis-decoded picture traces perfectly into the wrong shape.
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth} (only 8 is supported)`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (!(colorType in CHANNELS)) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error('indexed PNG with no PLTE chunk');

  const channels = CHANNELS[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);

  // Un-filter in place: each scanline is prefixed with its filter type and is
  // defined relative to the reconstructed line above it, so this cannot be done
  // out of order or in parallel.
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let src = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    raw.copy(line, 0, src, src + stride);
    src += stride;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0; // left
      const b = prev[i]; // up
      const c = i >= channels ? prev[i - channels] : 0; // up-left
      switch (filter) {
        case 0: break;
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
    }

    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      switch (colorType) {
        case 0: // greyscale
          out[o] = out[o + 1] = out[o + 2] = line[i];
          out[o + 3] = transparency && transparency.readUInt16BE(0) === line[i] ? 0 : 255;
          break;
        case 2: // truecolour
          out[o] = line[i];
          out[o + 1] = line[i + 1];
          out[o + 2] = line[i + 2];
          out[o + 3] =
            transparency &&
            transparency.readUInt16BE(0) === line[i] &&
            transparency.readUInt16BE(2) === line[i + 1] &&
            transparency.readUInt16BE(4) === line[i + 2]
              ? 0
              : 255;
          break;
        case 3: { // indexed
          const idx = line[i];
          out[o] = palette![idx * 3];
          out[o + 1] = palette![idx * 3 + 1];
          out[o + 2] = palette![idx * 3 + 2];
          out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
          break;
        }
        case 4: // greyscale + alpha
          out[o] = out[o + 1] = out[o + 2] = line[i];
          out[o + 3] = line[i + 1];
          break;
        default: // 6, truecolour + alpha
          out[o] = line[i];
          out[o + 1] = line[i + 1];
          out[o + 2] = line[i + 2];
          out[o + 3] = line[i + 3];
      }
    }
    line.copy(prev);
  }

  return { width, height, data: out };
}
