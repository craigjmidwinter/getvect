#!/usr/bin/env node
/**
 * `npm run test:engine` — the engine contracts, on any OS and any Node we build on.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINER. The script used to be
 *
 *     node --test tests/engine/*.test.mjs
 *
 * and that line has two shells' worth of assumptions in it. npm runs scripts
 * through `sh` on macOS and through `cmd.exe` on Windows, and cmd.exe does not
 * expand globs — it hands `tests/engine/*.test.mjs` to node verbatim. What node
 * then does with it depends on the version: Node 20 cannot read a glob and says
 * `Could not find 'D:\...\*.test.mjs'`, which is how the first Windows CI run
 * died after `npm ci` and typecheck had both gone green.
 *
 * The obvious repair, passing the directory, fails the other way round: Node 20
 * walks a directory looking for test files, and Node 22+ treats the argument as
 * a module to load and throws MODULE_NOT_FOUND. So the directory form is broken
 * on the machine this is developed on and the glob form is broken on the machine
 * it is released from — there is no string that works in both places.
 *
 * Doing the expansion here removes the question. `readdir` behaves the same on
 * every platform and every Node since long before 20, the file list node
 * receives is explicit, and a new `*.test.mjs` in tests/engine is picked up
 * without anyone remembering to add it. `node:fs/promises`' own `glob` would
 * read better and is Node 22+, which is exactly the trap being escaped.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = 'tests/engine';

/** Every engine contract file, as repo-relative paths, in a stable order. */
export async function findEngineTests(root = ROOT) {
  const entries = await readdir(join(root, DIR), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => `${DIR}/${entry.name}`)
    .sort();
}

// Only when run directly — run-tests.mjs imports the discovery above and drives
// `node --test` itself, so that `npm test` and `npm run test:engine` can never
// disagree about which files are the contracts.
//
// `pathToFileURL`, not a template string: on Windows argv[1] is `D:\a\...` and
// `file://D:\a\...` is not a file URL. Getting this wrong is the same class of
// bug as the glob above, two lines from the comment explaining it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tests = await findEngineTests();
  if (tests.length === 0) {
    console.error(`no *.test.mjs under ${DIR}`);
    process.exit(1);
  }
  const child = spawn(process.execPath, ['--test', ...tests, ...process.argv.slice(2)], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  child.on('close', (code) => process.exit(code ?? 1));
  child.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
