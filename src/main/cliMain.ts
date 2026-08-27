/**
 * The packaged app, traced from a command line, with no window ever created.
 *
 * WHY THIS EXISTS IN THE APP AND NOT ONLY IN `bin/`. Homebrew's shim is already
 * `exec electron <app-dir> "$@"` — it has ALWAYS passed arguments through. So
 * `getvect logo.png` was already delivering `logo.png` to this process, which
 * ignored it and opened a window. The shim was never wrong; the app was. Once
 * this path exists, brew's command works with no formula change, and the dmg
 * gets a CLI for free.
 *
 * THE RISK IS ENTIRELY IN THE BOOT PATH, so the ordering below is the contract:
 *
 *   - the decision is made from argv BEFORE `whenReady` resolves, in main.ts;
 *   - nothing here constructs a `BrowserWindow`, and `tests/engine/cli.test.mjs`
 *     asserts statically that it cannot;
 *   - decoding goes through the shared decoders, never the renderer;
 *   - nothing touches `safeStorage`, so a trace cannot raise a keychain dialog;
 *   - it ends with `app.exit(code)`, not by falling through to the normal
 *     lifecycle, because `window-all-closed` on a run with no windows is a
 *     different code path with a different exit code.
 *
 * The failure that must never ship is a window appearing. Everything else here
 * is recoverable; that one hangs a pipeline and, worse, reads to a user as the
 * feature being broken rather than absent.
 */
import { app, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  EXIT, FORMATS, INPUT_EXTENSIONS,
  canvasIngest, decodeImage, helpText, parseArgs,
  type RawImage,
} from '../cli';

const NAME = 'getvect';

/**
 * JPEG through Electron's own decoder.
 *
 * `toBitmap()` is premultiplied BGRA, which for a JPEG is straight alpha too —
 * every pixel is opaque, so premultiplying by 255/255 changes nothing. That is
 * why this is safe here and would NOT be safe for PNG: measured on a fixture
 * with 38,598 semi-transparent pixels, the premultiplied path and the app's
 * ingest disagree. PNG has its own decoder for exactly that reason.
 */
function decodeJpeg(buf: Buffer): RawImage {
  const img = nativeImage.createFromBuffer(buf);
  const { width, height } = img.getSize();
  if (!width || !height) throw new Error('could not decode the JPEG');
  const bgra = img.toBitmap();
  const data = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    data[i] = bgra[i + 2];
    data[i + 1] = bgra[i + 1];
    data[i + 2] = bgra[i];
    data[i + 3] = bgra[i + 3];
  }
  return { width, height, data };
}

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(`${NAME}: ${s}\n`);

export async function runHeadless(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    err(parsed.error ?? 'bad arguments');
    return parsed.code ?? EXIT.usage;
  }
  const opts = parsed.opts!;

  if (opts.help) {
    out(helpText(NAME));
    return EXIT.ok;
  }
  if (opts.version) {
    out(`${app.getVersion()}\n`);
    return EXIT.ok;
  }
  if (opts.positional.length === 0) {
    process.stderr.write(helpText(NAME));
    return EXIT.usage;
  }

  const input = resolve(opts.positional[0]);
  if (!existsSync(input)) {
    err(`no such file: ${opts.positional[0]}`);
    return EXIT.noInput;
  }
  const inputExt = extname(input).toLowerCase();
  if (!(INPUT_EXTENSIONS as readonly string[]).includes(inputExt)) {
    err(`unsupported input ${inputExt || '(no extension)'} — expected ${INPUT_EXTENSIONS.join(', ')}`);
    return EXIT.badInput;
  }

  const rawOut = opts.positional[1] ?? null;
  const toStdout = rawOut === '-';
  let format = opts.format;
  if (!format && rawOut && !toStdout) {
    const ext = extname(rawOut).toLowerCase().replace('.', '');
    if ((FORMATS as readonly string[]).includes(ext)) format = ext;
  }
  format ??= 'svg';

  const output = toStdout
    ? null
    : resolve(rawOut ?? join(dirname(input), `${basename(input, extname(input))}.${format}`));
  if (output && output === input) {
    err('refusing to overwrite the input file');
    return EXIT.cannotWrite;
  }

  let image: RawImage;
  try {
    image = canvasIngest(decodeImage(await readFile(input), inputExt, decodeJpeg));
  } catch (e) {
    err(`could not read ${opts.positional[0]}: ${e instanceof Error ? e.message : e}`);
    return EXIT.badInput;
  }

  /**
   * The BUNDLED engine, not `../engine/index`.
   *
   * tsc output still says `require('imagetracerjs')`, and `node_modules` is
   * excluded from the packaged app on purpose — so the unbundled path resolves
   * from a clone and fails inside an asar with "Cannot find module". Importing
   * the bundle in both places means development and the shipped app run the
   * same bytes, rather than the app running a path nothing exercised.
   *
   * Lazy, so a GUI launch never pays to load the engine at all.
   */
  // `require` with a cast, the same shape updater.ts uses for its own bundle:
  // the generated file has no declarations, but its types are exactly the
  // module it was built from.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const engine = require('./vendor/engine.js') as typeof import('../engine/index');
  let result;
  try {
    result = await engine.vectorize(image, { ...engine.DEFAULT_SETTINGS, ...opts.settings } as never);
  } catch (e) {
    err(`tracing failed: ${e instanceof Error ? e.message : e}`);
    return EXIT.traceFailed;
  }

  let body: string;
  try {
    switch (format) {
      case 'svg': body = result.svg; break;
      case 'eps': body = engine.toEps(result); break;
      case 'pdf': body = engine.toPdf(result); break;
      case 'dxf':
        body = engine.toDxf(result, opts.dxfLines ? ({ curves: 'lines' } as never) : undefined);
        break;
      case 'png': {
        // The one format that needs a rasterizer. nativeImage cannot render SVG,
        // so this is honest about not being available rather than writing
        // something that is not a PNG.
        err('png output is not available from the packaged app — use svg, eps, dxf or pdf');
        return EXIT.usage;
      }
      default:
        err(`unknown format ${format}`);
        return EXIT.usage;
    }
  } catch (e) {
    err(`could not write ${format}: ${e instanceof Error ? e.message : e}`);
    return EXIT.traceFailed;
  }

  try {
    if (toStdout) out(body);
    else await writeFile(output!, body);
  } catch (e) {
    err(`could not write output: ${e instanceof Error ? e.message : e}`);
    return EXIT.cannotWrite;
  }

  if (opts.stats) {
    out(`${JSON.stringify({
      input: opts.positional[0],
      output: toStdout ? null : output,
      format,
      width: result.width,
      height: result.height,
      colors: result.palette?.length ?? null,
      layers: (result.svg.match(/<g fill=/g) ?? []).length,
      bytes: Buffer.byteLength(body),
      ms: Math.round(result.durationMs ?? 0),
    })}\n`);
  }
  return EXIT.ok;
}
