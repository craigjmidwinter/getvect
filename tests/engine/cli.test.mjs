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

test('an existing output file is never overwritten without --force', { skip: !built }, async () => {
  /**
   * DATA LOSS, not a UX preference. This tool is invoked by things that cannot
   * look at the filesystem first — an agent that just produced a raster and
   * guessed at an output name. Replacing a file it did not know was there is
   * undetectable afterwards: exit 0, and output that looks perfect.
   *
   * Raised by a reader within a day of the CLI shipping, which is the audience
   * it was built for finding the bug it was most exposed to.
   */
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const out = join(dir, 'taken.svg');
  await writeFile(out, 'PRECIOUS');

  const refused = await cli(FIXTURE, out);
  assert.notEqual(refused.code, 0, 'overwriting an existing file exited 0');
  assert.equal(refused.stdout, '', 'wrote to stdout while refusing');
  assert.match(refused.stderr, /already exists/, 'refused without saying why');
  assert.equal(await readFile(out, 'utf8'), 'PRECIOUS', 'the file was destroyed anyway');

  const forced = await cli(FIXTURE, out, '--force');
  assert.equal(forced.code, 0, '--force did not let the write through');
  assert.notEqual(await readFile(out, 'utf8'), 'PRECIOUS', '--force did not overwrite');
});

test('the DERIVED output path is checked too', { skip: !built }, async () => {
  // The sharper half: `getvect logo.png` writes logo.svg with no output
  // argument at all, so the file destroyed is one the caller never named and
  // had no reason to think was at risk.
  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const input = join(dir, 'art.png');
  await writeFile(input, await readFile(FIXTURE));
  const derived = join(dir, 'art.svg');
  await writeFile(derived, 'HAND WRITTEN');

  const { code, stderr } = await cli(input);
  assert.notEqual(code, 0, 'the derived default overwrote without being asked');
  assert.match(stderr, /already exists/);
  assert.equal(await readFile(derived, 'utf8'), 'HAND WRITTEN');
});

test('--force and the refusal are both documented in --help', { skip: !built }, async () => {
  // A caller has no other way to find out what happens to an existing file.
  const { stdout } = await cli('--help');
  assert.match(stdout, /--force/, '--help does not mention --force');
  assert.match(stdout, /NOT OVERWRITTEN|already exists/i, '--help does not state the behaviour');
});

test('--stats and `-` cannot share stdout', { skip: !built }, async () => {
  /**
   * They both write there, and the document has no terminator the JSON could
   * follow safely: the object was appended straight onto `</svg>`, so
   * `getvect in.png - --stats > out.svg` wrote a corrupt SVG and exited 0.
   *
   * Found by checking docs/CLI.md's claims against the binary rather than from a
   * report — which is the only way it surfaces. Both halves are present, the
   * exit code says success, and the damage is at the end of a file nobody reads
   * to the bottom of.
   */
  const both = await cli(FIXTURE, '-', '--stats');
  assert.notEqual(both.code, 0, 'the combination was allowed');
  assert.equal(both.stdout, '', 'wrote a corruptible stream to stdout anyway');
  assert.match(both.stderr, /stats cannot be combined/i);

  // Each alone is untouched.
  const piped = await cli(FIXTURE, '-');
  assert.equal(piped.code, 0);
  assert.ok(piped.stdout.trimEnd().endsWith('</svg>'), 'the piped document is not clean');

  const dir = await mkdtemp(join(tmpdir(), 'getvect-cli-'));
  const stats = await cli(FIXTURE, join(dir, 'o.svg'), '--stats');
  assert.equal(stats.code, 0);
  assert.doesNotThrow(() => JSON.parse(stats.stdout.trim()), 'stats alone is not clean JSON');
});
