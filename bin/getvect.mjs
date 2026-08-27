#!/usr/bin/env node
/**
 * GetVect on the command line, from a clone.
 *
 * The grammar, defaults, exit codes and writing all live in `src/cli/`, shared
 * with the packaged app's headless path (`src/main/cliMain.ts`) so the two front
 * doors cannot drift. This file supplies the two things that differ outside
 * Electron: a JPEG decoder (sharp, which the packaged app cannot have) and a PNG
 * rasterizer for `-f png` (resvg, likewise).
 *
 * The contract, because a subprocess cannot answer questions:
 *   - stdout stays empty unless `--stats`, which prints one JSON object;
 *   - every failure exits non-zero with one line on stderr;
 *   - no prompt, no window, no renderer, no keychain, no network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'getvect';

const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const ENGINE = join(ROOT, 'dist', 'engine', 'index.js');
if (!existsSync(CLI) || !existsSync(ENGINE)) {
  // A clear sentence beats a MODULE_NOT_FOUND stack for the likeliest first-run
  // error on a fresh clone.
  process.stderr.write(`${NAME}: not built yet — run \`npm run build:node\` in the repo first\n`);
  process.exit(69);
}

const cli = await import(pathToFileURL(CLI).href);
const { EXIT, FORMATS, INPUT_EXTENSIONS, canvasIngest, decodeImage, helpText, parseArgs, refuseToClobber } = cli;

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(`${NAME}: ${s}\n`);
const done = (code) => process.exit(code);

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  err(parsed.error);
  done(parsed.code);
}
const opts = parsed.opts;

if (opts.help) {
  out(helpText(NAME));
  done(EXIT.ok);
}
if (opts.version) {
  out(`${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}\n`);
  done(EXIT.ok);
}
if (opts.positional.length === 0) {
  process.stderr.write(helpText(NAME));
  done(EXIT.usage);
}

const input = resolve(opts.positional[0]);
if (!existsSync(input)) {
  err(`no such file: ${opts.positional[0]}`);
  done(EXIT.noInput);
}
const inputExt = extname(input).toLowerCase();
if (!INPUT_EXTENSIONS.includes(inputExt)) {
  err(`unsupported input ${inputExt || '(no extension)'} — expected ${INPUT_EXTENSIONS.join(', ')}`);
  done(EXIT.badInput);
}

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
if (output && output === input) {
  err('refusing to overwrite the input file');
  done(EXIT.cannotWrite);
}

// Before the trace, not before the write: a caller about to be refused should
// find out in milliseconds rather than after a multi-second trace it cannot use.
const clobber = refuseToClobber(output, opts.force, existsSync);
if (clobber) {
  err(clobber);
  done(EXIT.cannotWrite);
}

/** sharp, only for JPEG — PNG and BMP use the shared decoders. */
async function decodeJpegWithSharp(buf) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  };
}

let image;
try {
  const buf = await readFile(input);
  // sharp is async, and decodeImage takes a sync decoder, so JPEG is decoded
  // first and handed in as a constant. PNG and BMP never reach it.
  const jpeg = inputExt === '.jpg' || inputExt === '.jpeg' ? await decodeJpegWithSharp(buf) : null;
  image = canvasIngest(decodeImage(buf, inputExt, () => jpeg));
} catch (e) {
  err(`could not read ${opts.positional[0]}: ${e instanceof Error ? e.message : e}`);
  done(EXIT.badInput);
}

const engine = await import(pathToFileURL(ENGINE).href);
let result;
try {
  result = await engine.vectorize(image, { ...engine.DEFAULT_SETTINGS, ...opts.settings });
} catch (e) {
  err(`tracing failed: ${e instanceof Error ? e.message : e}`);
  done(EXIT.traceFailed);
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
} catch (e) {
  err(`could not write ${format}: ${e instanceof Error ? e.message : e}`);
  done(EXIT.traceFailed);
}

try {
  if (toStdout) process.stdout.write(body);
  else await writeFile(output, body);
} catch (e) {
  err(`could not write output: ${e instanceof Error ? e.message : e}`);
  done(EXIT.cannotWrite);
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
    bytes: typeof body === 'string' ? Buffer.byteLength(body) : body.length,
    ms: Math.round(result.durationMs ?? 0),
  })}\n`);
}
