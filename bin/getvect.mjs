#!/usr/bin/env node
/**
 * GetVect on the command line.
 *
 * WHAT THIS IS FOR. The app's whole value is a tracing engine that needs no
 * account, no upload and no network — and that value is wasted if the only way
 * to reach it is a mouse. An agent that just generated a raster wants to hand it
 * to a vectorizer and get a path back, without a window opening, without being
 * asked anything, and without wondering whether a queue is involved.
 *
 * SO THE CONTRACT IS AGENT-SHAPED, NOT HUMAN-SHAPED:
 *
 *   - nothing on stdout unless asked (`--stats`), so no caller has to parse
 *     around chatter to find the answer;
 *   - every failure exits non-zero with one line on stderr;
 *   - no prompt, ever — an unanswerable question is a hang, and a hang in a
 *     subprocess is worse than an error;
 *   - no Electron, no window, no renderer, no keychain, no network. This
 *     imports the engine directly, the same way the instruments do.
 *
 * WHY IT DUPLICATES NOTHING. `src/engine/` is already a pure module with its own
 * types and entry points, and five scripts under `instruments/` already drive it
 * outside Electron. This is a front door onto that, not a second implementation:
 * the trace you get here is byte-identical to the one the app shows, because it
 * is the same call with the same settings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'getvect';

const die = (msg, code = 1) => {
  process.stderr.write(`${NAME}: ${msg}\n`);
  process.exit(code);
};

// --- the engine ------------------------------------------------------------
// Loaded from dist/, which is what `npm run build:node` produces. A clear
// sentence beats a MODULE_NOT_FOUND stack for the most likely first-run error.
const ENGINE = join(ROOT, 'dist', 'engine', 'index.js');
if (!existsSync(ENGINE)) {
  die('the engine is not built yet — run `npm run build:node` in the repo first', 69);
}

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const FORMATS = ['svg', 'eps', 'dxf', 'pdf', 'png'];
const PRESETS = ['clipart', 'photo', 'sketch', 'drawing'];
const DETAIL_LEVELS = ['maximum', 'ultra', 'very-high', 'high', 'medium', 'low', 'minimum'];
const AA = ['off', 'smart', 'mid'];
const NOISE = ['off', 'low', 'high'];

const HELP = `${NAME} — turn a raster image into a vector, locally.

USAGE
  ${NAME} <input> [output] [options]

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
      --noise-reduction <n>${NOISE.join(' | ')} (default off)
      --min-area <px>      0 | 5 | 90  (default 5)
      --roundness <0-2>    curve-fitting level (default 1)
      --threshold <0-255>  luminance cut for --preset drawing (default 128)
      --dxf-lines          emit R12 POLYLINE instead of splines
      --stats              print one JSON object of metrics to stdout
  -h, --help               this
  -v, --version            print the version

EXAMPLES
  ${NAME} logo.png                       # -> logo.svg, 8 colours, Clipart
  ${NAME} logo.png logo.dxf              # format from the extension
  ${NAME} shot.jpg -f svg -c 16 -p photo
  ${NAME} logo.png - > logo.svg          # stdout, for a pipe
  ${NAME} logo.png out.svg --stats       # SVG to the file, JSON to stdout

Runs entirely on this machine. No account, no upload, no network.
`;

// --- argument parsing ------------------------------------------------------
/**
 * Hand-rolled on purpose: a dependency-free CLI is one that cannot break
 * because something upstream changed, and the grammar here is small enough to
 * read in one screen. Unknown flags are an ERROR rather than being ignored —
 * silently dropping `--colours` and returning a default-coloured trace is the
 * kind of help nobody wants.
 */
function parse(argv) {
  const opts = { positional: [], settings: {}, format: null, stats: false, dxfLines: false };
  const need = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-') && v !== '-') die(`${flag} needs a value`, 64);
    return v;
  };
  const num = (flag, raw, lo, hi) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) die(`${flag} expects a number, got ${JSON.stringify(raw)}`, 64);
    if (n < lo || n > hi) die(`${flag} must be between ${lo} and ${hi}, got ${n}`, 64);
    return n;
  };
  const oneOf = (flag, raw, allowed) => {
    if (!allowed.includes(raw)) {
      die(`${flag} must be one of ${allowed.join(', ')} — got ${JSON.stringify(raw)}`, 64);
    }
    return raw;
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break;
      case '-v': case '--version':
        process.stdout.write(`${VERSION}\n`);
        process.exit(0);
        break;
      case '--stats': opts.stats = true; break;
      case '--dxf-lines': opts.dxfLines = true; break;
      case '-f': case '--format': opts.format = oneOf(a, need(a, i++), FORMATS); break;
      case '-c': case '--colors': case '--colours':
        opts.settings.colorCount = num(a, need(a, i++), 2, 64); break;
      case '-p': case '--preset': opts.settings.preset = oneOf(a, need(a, i++), PRESETS); break;
      case '--detail': opts.settings.detail = num(a, need(a, i++), 0, 100); break;
      case '--smoothing': opts.settings.smoothing = num(a, need(a, i++), 0, 100); break;
      case '--despeckle': opts.settings.despeckle = num(a, need(a, i++), 0, 100); break;
      case '--detail-level':
        opts.settings.detailLevel = oneOf(a, need(a, i++), DETAIL_LEVELS); break;
      case '--anti-aliasing': case '--antialiasing':
        opts.settings.antiAliasing = oneOf(a, need(a, i++), AA); break;
      case '--noise-reduction':
        opts.settings.noiseReduction = oneOf(a, need(a, i++), NOISE); break;
      case '--min-area': opts.settings.minArea = num(a, need(a, i++), 0, 10000); break;
      case '--roundness': opts.settings.roundness = num(a, need(a, i++), 0, 2); break;
      case '--threshold': opts.settings.bwThreshold = num(a, need(a, i++), 0, 255); break;
      default:
        if (a !== '-' && a.startsWith('-')) die(`unknown option ${a} (try --help)`, 64);
        opts.positional.push(a);
    }
  }
  return opts;
}

// --- main ------------------------------------------------------------------
const opts = parse(process.argv);

if (opts.positional.length === 0) {
  process.stderr.write(HELP);
  process.exit(64);
}

const input = resolve(opts.positional[0]);
if (!existsSync(input)) die(`no such file: ${opts.positional[0]}`, 66);

const inputExt = extname(input).toLowerCase();
if (!['.png', '.jpg', '.jpeg', '.bmp'].includes(inputExt)) {
  die(`unsupported input ${inputExt || '(no extension)'} — expected .png, .jpg, .jpeg or .bmp`, 65);
}

// Format precedence: explicit flag, then the output extension, then svg. The
// output extension winning over the default is what makes `getvect a.png a.dxf`
// do the obvious thing with no flags.
const rawOut = opts.positional[1] ?? null;
const toStdout = rawOut === '-';
let format = opts.format;
if (!format && rawOut && !toStdout) {
  const ext = extname(rawOut).toLowerCase().replace('.', '');
  if (FORMATS.includes(ext)) format = ext;
}
format ??= 'svg';

const output = toStdout
  ? null
  : resolve(rawOut ?? join(dirname(input), `${basename(input, extname(input))}.${format}`));

if (output && resolve(output) === input) {
  die('refusing to overwrite the input file', 73);
}

const engine = await import(pathToFileURL(ENGINE).href);
const { decodeImageFile, canvasIngest } = await import(
  pathToFileURL(join(ROOT, 'instruments', 'lib', 'decode.mjs')).href
);

let image;
try {
  // canvasIngest, not the raw decode: the engine must be handed the same pixels
  // the app's canvas ingest produces, or the CLI would trace a code path no user
  // has. That mismatch once painted an invented black background over every
  // transparent PNG and scored green.
  image = canvasIngest(await decodeImageFile(input));
} catch (err) {
  die(`could not read ${opts.positional[0]}: ${err instanceof Error ? err.message : err}`, 65);
}

let result;
try {
  result = await engine.vectorize(image, { ...engine.DEFAULT_SETTINGS, ...opts.settings });
} catch (err) {
  die(`tracing failed: ${err instanceof Error ? err.message : err}`, 70);
}

let body;
try {
  switch (format) {
    case 'svg': body = result.svg; break;
    case 'eps': body = engine.toEps(result); break;
    case 'pdf': body = engine.toPdf(result); break;
    case 'dxf': body = engine.toDxf(result, opts.dxfLines ? { curves: 'lines' } : undefined); break;
    case 'png': {
      const { Resvg } = await import('@resvg/resvg-js');
      body = new Resvg(result.svg, { fitTo: { mode: 'width', value: result.width } })
        .render()
        .asPng();
      break;
    }
  }
} catch (err) {
  die(`could not write ${format}: ${err instanceof Error ? err.message : err}`, 70);
}

try {
  if (toStdout) process.stdout.write(body);
  else await writeFile(output, body);
} catch (err) {
  die(`could not write output: ${err instanceof Error ? err.message : err}`, 73);
}

// stdout stays empty unless asked. When it is asked for, it is one JSON object
// on one line — a caller should not have to decide where the machine-readable
// part starts.
if (opts.stats) {
  const stats = {
    input: opts.positional[0],
    output: toStdout ? null : output,
    format,
    width: result.width,
    height: result.height,
    colors: result.palette?.length ?? null,
    layers: (result.svg.match(/<g fill=/g) ?? []).length,
    bytes: typeof body === 'string' ? Buffer.byteLength(body) : body.length,
    ms: Math.round(result.durationMs ?? 0),
  };
  process.stdout.write(`${JSON.stringify(stats)}\n`);
}
