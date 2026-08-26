/**
 * THE CLI IS A FRONT DOOR, NOT A SECOND IMPLEMENTATION.
 *
 * Its whole promise is that an agent can invoke it non-interactively and get the
 * same result the app would show. Two ways that promise breaks quietly:
 *
 *   - the CLI drifts from the engine — a different default, a setting that does
 *     not reach `vectorize`, an ingest that skips `canvasIngest` — and produces
 *     output that is plausible and not what the app produces. Nobody notices,
 *     because both look like vectors;
 *   - it stops being non-interactive: something prints progress to stdout, or
 *     opens a window, or reaches for a keychain, and every caller that parsed
 *     its output breaks at once.
 *
 * So the first test compares bytes against a direct engine call, and the rest
 * pin the parts a subprocess cannot negotiate: empty stdout, non-zero exit,
 * errors on stderr.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(root, 'bin', 'getvect.mjs');
const FIXTURE = join(root, 'fixtures', 'reference', 'frankie-sticker.png');

/** Run the CLI, never throwing: the exit code and streams ARE the result. */
async function cli(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { maxBuffer: 64e6 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const built = existsSync(join(root, 'dist', 'engine', 'index.js'));

test('the CLI exists and is wired as the package bin', () => {
  assert.ok(existsSync(CLI), 'bin/getvect.mjs is missing');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(
    pkg.bin?.getvect,
    'bin/getvect.mjs',
    'the bin entry is what makes `npm link` and `npx` work; without it the CLI is a file',
  );
});

test('it never boots Electron, the renderer, the network or a keychain', () => {
  // Static, because the expensive version of this check is noticing a window.
  const src = readFileSync(CLI, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['electron', 'BrowserWindow', 'safeStorage', 'fetch(', 'https:']) {
    assert.ok(
      !src.includes(forbidden),
      `bin/getvect.mjs references ${forbidden} — the CLI must stay a pure engine front door`,
    );
  }
});

test('the trace is byte-identical to a direct engine call', { skip: !built }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const out = join(dir, 'out.svg');
  const { code, stdout } = await cli(FIXTURE, out);
  assert.equal(code, 0);
  assert.equal(stdout, '', 'stdout must stay empty without --stats');

  const engine = await import(pathToFileURL(join(root, 'dist', 'engine', 'index.js')).href);
  const decode = await import(pathToFileURL(join(root, 'instruments', 'lib', 'decode.mjs')).href);
  const image = decode.canvasIngest(await decode.decodeImageFile(FIXTURE));
  const direct = await engine.vectorize(image, engine.DEFAULT_SETTINGS);

  assert.equal(
    await readFile(out, 'utf8'),
    direct.svg,
    'the CLI and the engine disagree — the CLI has drifted into being its own tracer',
  );
});

test('--stats prints one JSON object and nothing else', { skip: !built }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const { code, stdout } = await cli(FIXTURE, join(dir, 'o.svg'), '--stats');
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stats must be one line, so a caller can read it without a parser');
  const stats = JSON.parse(lines[0]);
  for (const key of ['format', 'width', 'height', 'colors', 'layers', 'bytes']) {
    assert.ok(key in stats, `stats is missing ${key}`);
  }
  assert.equal(stats.width, 1195);
});

test('the output format follows the extension', { skip: !built }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  for (const [ext, magic] of [['svg', '<svg'], ['eps', '%!PS'], ['pdf', '%PDF'], ['dxf', '0']]) {
    const out = join(dir, `o.${ext}`);
    const { code } = await cli(FIXTURE, out);
    assert.equal(code, 0, `${ext} export failed`);
    assert.ok((await readFile(out, 'utf8')).startsWith(magic), `${out} is not ${ext}`);
  }
});

test('settings reach the engine', { skip: !built }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const layers = async (...args) => {
    const out = join(dir, `o${args.join('')}.svg`);
    await cli(FIXTURE, out, ...args);
    return ((await readFile(out, 'utf8')).match(/<g fill=/g) ?? []).length;
  };
  // A flag that parses but never reaches `vectorize` is the quiet failure here:
  // the run succeeds, the file looks right, and the setting did nothing.
  assert.notEqual(await layers('-c', '4'), await layers('-c', '16'), '--colors changed nothing');
});

test('every failure is non-zero, on stderr, with stdout untouched', { skip: !built }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const bad = join(dir, 'bad.txt');
  await writeFile(bad, 'not an image');

  const cases = [
    ['a missing file', [join(dir, 'nope.png')]],
    ['an unsupported input', [bad]],
    ['an unknown option', [FIXTURE, '--colours-please']],
    ['a bad enum value', [FIXTURE, '-p', 'cubist']],
    ['a value out of range', [FIXTURE, '-c', '999']],
    ['no arguments at all', []],
  ];
  for (const [label, args] of cases) {
    const { code, stdout, stderr } = await cli(...args);
    assert.notEqual(code, 0, `${label} exited 0 — a caller would treat that as success`);
    assert.equal(stdout, '', `${label} wrote to stdout`);
    assert.ok(stderr.length > 0, `${label} failed silently`);
  }
});

test('it refuses to overwrite its own input', { skip: !built }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const copy = join(dir, 'in.png');
  await writeFile(copy, await readFile(FIXTURE));
  const { code, stderr } = await cli(copy, copy);
  assert.notEqual(code, 0, 'overwriting the input destroys the source for a retry');
  assert.match(stderr, /refusing/i);
});
