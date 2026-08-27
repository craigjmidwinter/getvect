/**
 * The command line, shared by both front doors.
 *
 * There are two ways to reach the tracer without the app: `bin/getvect.mjs` on a
 * clone, and the packaged app itself when Homebrew's shim (or a user) passes it
 * arguments. They must behave identically, so the argument grammar, the
 * defaults, the exit codes and the writing all live here and are imported by
 * both. The only thing either side supplies is how to turn a JPEG into pixels,
 * because that is the one format whose decoder differs between a clone (sharp)
 * and a packaged app (Electron's nativeImage) — measured equal, and injected
 * rather than assumed.
 *
 * WHY THE EXIT CODES ARE SPECIFIC. A caller that cannot read prose still has to
 * distinguish "you passed me nonsense" from "I could not read that file" from
 * "the trace failed". They follow sysexits, which is what a shell script author
 * will expect.
 */
import { decodePng } from './decodePng';

export const FORMATS = ['svg', 'eps', 'dxf', 'pdf', 'png'] as const;
export const PRESETS = ['clipart', 'photo', 'sketch', 'drawing'] as const;
export const DETAIL_LEVELS = [
  'maximum', 'ultra', 'very-high', 'high', 'medium', 'low', 'minimum',
] as const;
export const AA = ['off', 'smart', 'mid'] as const;
export const NOISE = ['off', 'low', 'high'] as const;
export const INPUT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp'] as const;

/** sysexits, so a shell can branch on the reason. */
export const EXIT = {
  ok: 0,
  usage: 64,
  badInput: 65,
  noInput: 66,
  notBuilt: 69,
  traceFailed: 70,
  cannotWrite: 73,
} as const;

export interface CliOptions {
  positional: string[];
  settings: Record<string, unknown>;
  format: string | null;
  stats: boolean;
  dxfLines: boolean;
  help: boolean;
  version: boolean;
}

export interface ParseResult {
  ok: boolean;
  opts?: CliOptions;
  error?: string;
  code?: number;
}

export function helpText(name: string): string {
  return `${name} — turn a raster image into a vector, locally.

USAGE
  ${name} <input> [output] [options]

  <input>   .png, .jpg, .jpeg or .bmp
  [output]  written here. Defaults to the input path with the format's
            extension. Use - to write to stdout.

OPTIONS
  -f, --format <fmt>       ${FORMATS.join(' | ')}   (default: from the output
                           extension, else svg)
  -c, --colors <2-64>      palette size (default 8)
  -p, --preset <name>      ${PRESETS.join(' | ')} (default clipart)
      --detail <0-100>     how closely paths follow pixel edges (default 60)
      --smoothing <0-100>  curve-fitting aggressiveness (default 50)
      --despeckle <0-100>  drop specks below this size (default 20)
      --detail-level <lvl> ${DETAIL_LEVELS.join(' | ')} (default high)
      --anti-aliasing <a>  ${AA.join(' | ')} (default smart)
      --noise-reduction <n> ${NOISE.join(' | ')} (default off)
      --min-area <px>      0 | 5 | 90  (default 5)
      --roundness <0-2>    curve-fitting level (default 1)
      --threshold <0-255>  luminance cut for --preset drawing (default 128)
      --dxf-lines          emit R12 POLYLINE instead of splines
      --stats              print one JSON object of metrics to stdout
  -h, --help               this
  -v, --version            print the version

EXAMPLES
  ${name} logo.png                       # -> logo.svg, 8 colours, Clipart
  ${name} logo.png logo.dxf              # format from the extension
  ${name} shot.jpg -f svg -c 16 -p photo
  ${name} logo.png - > logo.svg          # stdout, for a pipe
  ${name} logo.png out.svg --stats       # SVG to the file, JSON to stdout

Runs entirely on this machine. No account, no upload, no network.
`;
}

/**
 * Parse argv (already stripped of the runtime and script).
 *
 * Unknown flags are an ERROR rather than ignored: silently dropping `--colours`
 * and returning a default-coloured trace is help nobody asked for.
 */
export function parseArgs(argv: string[]): ParseResult {
  const opts: CliOptions = {
    positional: [], settings: {}, format: null,
    stats: false, dxfLines: false, help: false, version: false,
  };
  const fail = (error: string): ParseResult => ({ ok: false, error, code: EXIT.usage });

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | null => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('-') && v !== '-')) return null;
      i++;
      return v;
    };
    const num = (raw: string | null, lo: number, hi: number): number | string => {
      if (raw === null) return `${a} needs a value`;
      const n = Number(raw);
      if (!Number.isFinite(n)) return `${a} expects a number, got ${JSON.stringify(raw)}`;
      if (n < lo || n > hi) return `${a} must be between ${lo} and ${hi}, got ${n}`;
      return n;
    };
    const oneOf = (raw: string | null, allowed: readonly string[]): string => {
      if (raw === null) return `${a} needs a value`;
      if (!allowed.includes(raw)) {
        return `${a} must be one of ${allowed.join(', ')} — got ${JSON.stringify(raw)}`;
      }
      return '';
    };
    const set = (key: string, v: number | string) => {
      if (typeof v === 'string' && v) return v;
      opts.settings[key] = v;
      return '';
    };

    let err = '';
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '--stats': opts.stats = true; break;
      case '--dxf-lines': opts.dxfLines = true; break;
      case '-f': case '--format': {
        const raw = value();
        err = oneOf(raw, FORMATS);
        if (!err) opts.format = raw;
        break;
      }
      case '-c': case '--colors': case '--colours':
        err = set('colorCount', num(value(), 2, 64)); break;
      case '-p': case '--preset': {
        const raw = value();
        err = oneOf(raw, PRESETS);
        if (!err) opts.settings.preset = raw;
        break;
      }
      case '--detail': err = set('detail', num(value(), 0, 100)); break;
      case '--smoothing': err = set('smoothing', num(value(), 0, 100)); break;
      case '--despeckle': err = set('despeckle', num(value(), 0, 100)); break;
      case '--detail-level': {
        const raw = value();
        err = oneOf(raw, DETAIL_LEVELS);
        if (!err) opts.settings.detailLevel = raw;
        break;
      }
      case '--anti-aliasing': case '--antialiasing': {
        const raw = value();
        err = oneOf(raw, AA);
        if (!err) opts.settings.antiAliasing = raw;
        break;
      }
      case '--noise-reduction': {
        const raw = value();
        err = oneOf(raw, NOISE);
        if (!err) opts.settings.noiseReduction = raw;
        break;
      }
      case '--min-area': err = set('minArea', num(value(), 0, 10000)); break;
      case '--roundness': err = set('roundness', num(value(), 0, 2)); break;
      case '--threshold': err = set('bwThreshold', num(value(), 0, 255)); break;
      default:
        if (a !== '-' && a.startsWith('-')) return fail(`unknown option ${a} (try --help)`);
        opts.positional.push(a);
    }
    if (err) return fail(err);
  }
  return { ok: true, opts };
}

/**
 * Does this argv mean "trace something and exit" rather than "open the app"?
 *
 * Used by the packaged app to decide BEFORE it creates a window. It has to be
 * conservative in one direction only: a false positive opens no window when the
 * user wanted one, which they will notice and can retry; a false negative opens
 * a window in a script, which hangs a pipeline and is the failure this exists to
 * prevent. Electron's own switches (`--inspect`, `--remote-debugging-port`, and
 * anything else beginning with a dash that we do not define) do not count, and
 * neither does a bare launch.
 */
export function looksLikeCliInvocation(argv: string[]): boolean {
  if (argv.length === 0) return false;
  if (argv.includes('-h') || argv.includes('--help')) return true;
  if (argv.includes('-v') || argv.includes('--version')) return true;

  /**
   * ANY non-flag argument counts, not just one with a known image extension.
   *
   * The first version of this required `.png`/`.jpg`/`.jpeg`/`.bmp`, which meant
   * `getvect notes.txt` OPENED A WINDOW AND SAT THERE — the exact false negative
   * the paragraph above warns about, written by the same hand that wrote the
   * warning. Whether a named file can be traced is a question the CLI answers
   * with exit 65 and one line on stderr. It is not a reason to decide the user
   * wanted a GUI.
   *
   * A GUI launch passes no non-flag arguments: from Finder, the Dock or
   * `open -a`, argv is the executable alone, and macOS delivers double-clicked
   * files through the `open-file` event rather than argv. Electron's own
   * switches all begin with a dash.
   */
  return argv.some((a) => !a.startsWith('-'));
}

/** RGBA straight-alpha pixels, the shape the engine takes. */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Uncompressed 24/32-bit BI_RGB BMP. libvips has no BMP loader and Chromium's
 * is not reachable from here, so both front doors share this one.
 */
export function decodeBmp(buf: Buffer): RawImage {
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
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = pixelOffset + (bottomUp ? height - 1 - y : y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = row + x * bytesPerPixel;
      const d = (y * width + x) * 4;
      data[d] = buf[s + 2];
      data[d + 1] = buf[s + 1];
      data[d + 2] = buf[s];
      data[d + 3] = bpp === 32 ? buf[s + 3] : 255;
    }
  }
  return { width, height, data };
}

/**
 * The app's canvas ingest, reproduced exactly.
 *
 * The engine must be handed the same pixels `src/renderer/lib/decode.ts`
 * produces, including (0,0,0,0) for a transparent pixel. Skipping this is how a
 * transparent PNG once traced an invented opaque black background while every
 * number scored green.
 */
export function canvasIngest(image: RawImage): RawImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i + 3] = a;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) {
      const premultiplied = Math.round((data[i + c] * a) / 255);
      out[i + c] = Math.round((premultiplied * 255) / a);
    }
  }
  return { width, height, data: out };
}

/** Decode by extension. JPEG is injected: see the module comment. */
export function decodeImage(
  buf: Buffer,
  ext: string,
  decodeJpeg: (b: Buffer) => RawImage,
): RawImage {
  const e = ext.toLowerCase();
  if (e === '.png') return decodePng(buf);
  if (e === '.bmp') return decodeBmp(buf);
  if (e === '.jpg' || e === '.jpeg') return decodeJpeg(buf);
  throw new Error(`unsupported input ${ext || '(no extension)'}`);
}
