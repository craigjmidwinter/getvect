/**
 * THE PACKAGED APP AS A CLI — AND THE WINDOW THAT MUST NEVER APPEAR.
 *
 * Homebrew's shim already execs Electron against the app directory and passes
 * every remaining argument through, so `getvect logo.png` has always been
 * reaching the main process. It used to ignore the path and open a window. Now
 * it traces and exits, which is why brew's command needed no formula change.
 *
 * The failure that must not ship is a window appearing, and RUNNING THE THING
 * CANNOT CATCH IT. On a developer's machine a window that flashes and closes
 * looks like success; in CI there is no display to see it on; and by the time a
 * user reports it, the command has already looked broken to the audience it was
 * built for. So every place that could construct one is asserted in the source,
 * where a check can actually go red.
 *
 * The second thing pinned here is that there is ONE implementation. Two front
 * doors that each parse their own arguments will drift, and the drift is
 * invisible in the worst way: both work, and they disagree about the same file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
/** Comments stripped: a paragraph naming BrowserWindow is not a call to it. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the headless path cannot construct a window or reach a keychain', () => {
  const cliMain = code('src/main/cliMain.ts');
  assert.ok(
    !cliMain.includes('BrowserWindow'),
    'cliMain references BrowserWindow — the CLI path must not be able to make one',
  );
  assert.ok(
    !cliMain.includes('safeStorage'),
    'cliMain touches safeStorage; a trace must not be able to raise a keychain dialog',
  );
});

test('every createWindow call sits behind the CLI check', () => {
  const main = code('src/main/main.ts');
  assert.match(
    main,
    /const IS_CLI = looksLikeCliInvocation\(/,
    'the argv decision is gone; without it the app cannot tell a script from a person',
  );

  // Two call sites, and the second is the one easy to forget: on macOS a
  // "reopen" gesture would otherwise raise a window in the middle of a scripted
  // run, long after the decision was made.
  const activateAt = main.indexOf("app.on('activate'");
  assert.notEqual(activateAt, -1, 'the activate handler moved — re-point this guard');
  // Bound by the handler's own closing `});`, not by a character count. A fixed
  // 260 ran past the end of the handler and into the ready branch below, which
  // mentions IS_CLI — so deleting the guard from `activate` left this green.
  const activateEnd = main.indexOf('});', activateAt);
  assert.notEqual(activateEnd, -1, 'could not find the end of the activate handler');
  assert.ok(
    main.slice(activateAt, activateEnd).includes('IS_CLI'),
    'the activate handler can still create a window during a CLI run',
  );

  const ready = main.slice(main.indexOf('app.whenReady()'));
  const cliAt = ready.indexOf('IS_CLI');
  const windowAt = ready.indexOf('createWindow()');
  assert.notEqual(cliAt, -1, 'the ready handler has no CLI branch');
  assert.notEqual(windowAt, -1, 'createWindow moved out of the ready handler — re-point this guard');
  assert.ok(
    cliAt < windowAt,
    'the CLI branch must come before createWindow() in the ready handler, or a window is ' +
      'already on screen by the time anything decides not to open one',
  );
});

test('the CLI path exits with its own code rather than falling through', () => {
  // app.quit() runs the normal lifecycle, where `window-all-closed` on a run
  // that never opened a window is a different path that discards the exit code
  // the caller is waiting on.
  const main = code('src/main/main.ts');
  const ready = main.slice(main.indexOf('app.whenReady()'));
  const branch = ready.slice(ready.indexOf('IS_CLI'), ready.indexOf('createWindow()'));
  assert.match(branch, /app\.exit\(/, 'the CLI branch must app.exit with the run  code');
  assert.match(branch, /return;/, 'the CLI branch must return, never continue into the GUI boot');
});

test('both front doors share one implementation', () => {
  for (const file of ['bin/getvect.mjs', 'src/main/cliMain.ts']) {
    const src = read(file);
    assert.match(
      src,
      /parseArgs/,
      `${file} does not use the shared parseArgs — it has grown its own argument grammar`,
    );
    assert.match(
      src,
      /canvasIngest/,
      `${file} does not use the shared canvasIngest — its pixels will differ from the app's`,
    );
  }
});

test('PNG is decoded by the shared decoder, never by nativeImage', () => {
  // nativeImage.toBitmap() is premultiplied BGRA. Undoing that does not recover
  // straight alpha — Chromium already rounded — so a PNG with soft edges would
  // trace differently from the standalone CLI. Measured on
  // fixtures/third-party/sticker-figure-900.png, 38,598 semi-transparent pixels:
  // the two hash differently. A hard-edged sticker has none, so the easy case
  // agrees and hides it.
  const cliMain = code('src/main/cliMain.ts');
  const jpegAt = cliMain.indexOf('function decodeJpeg');
  assert.notEqual(jpegAt, -1, 'decodeJpeg moved — re-point this guard');

  // Brace-match the function. A first attempt looked for the next `\n}`, which
  // lands on a nested block, so the "outside" slice still contained the function
  // body and the guard failed on correct code.
  let end = cliMain.indexOf('{', jpegAt);
  for (let i = end, depth = 0; i < cliMain.length; i++) {
    if (cliMain[i] === '{') depth++;
    else if (cliMain[i] === '}' && --depth === 0) { end = i + 1; break; }
  }

  const outside = cliMain.slice(0, jpegAt) + cliMain.slice(end);
  const strayed = [...outside.matchAll(/nativeImage/g)].length;
  assert.equal(
    strayed,
    1, // the import line, and only that
    'nativeImage is used outside decodeJpeg — only JPEG is safe to decode that way, ' +
      'because every JPEG pixel is opaque so premultiplying by 255/255 changes nothing',
  );
});

test('any named file means CLI intent, even one we cannot trace', async () => {
  // THE BUG THIS EXISTS FOR: the first version of looksLikeCliInvocation
  // required a known image extension, so `getvect notes.txt` fell through to the
  // GUI, opened a window and sat there forever. In a script that is a hang, not
  // an error — the precise false negative the function's own comment warns
  // about, written by the same hand.
  //
  // Whether a file can be traced is answered with exit 65 and one line on
  // stderr. It is never a reason to decide the user wanted a window.
  const { looksLikeCliInvocation } = await import(
    pathToFileURL(join(root, 'dist', 'cli', 'index.js')).href
  );
  for (const argv of [['notes.txt'], ['README'], ['a.md', 'b.svg'], ['in.png']]) {
    assert.equal(
      looksLikeCliInvocation(argv),
      true,
      `${JSON.stringify(argv)} names a file; treating it as a GUI launch hangs the caller`,
    );
  }
  // A GUI launch passes no non-flag arguments, and Electron's own switches all
  // begin with a dash. Both must stay false or a normal launch loses its window.
  for (const argv of [[], ['--remote-debugging-port=9222'], ['--inspect']]) {
    assert.equal(
      looksLikeCliInvocation(argv),
      false,
      `${JSON.stringify(argv)} is a GUI launch; treating it as CLI means no window ever opens`,
    );
  }
});
