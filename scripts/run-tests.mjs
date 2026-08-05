#!/usr/bin/env node
/**
 * `npm test` — the acceptance suite, both halves of it.
 *
 * This exists because the script used to be
 *
 *     node --test tests/engine/*.test.mjs && playwright test
 *
 * and `&&` is a short circuit: with two engine contracts red, the documented
 * entry point never reached Playwright at all. `npm test` reported 56 engine
 * tests and stopped, while the 108-test e2e number every scoreboard quoted was
 * only obtainable by bypassing the documented command. A harness whose headline
 * command hides most of its own coverage is worse than no headline command.
 *
 * So: both suites always run, each prints its own summary, and the exit code is
 * non-zero if EITHER failed. Order is unchanged — engine contracts first,
 * because if the picture regressed the UI specs' green is not worth reading.
 *
 * Pass through any extra arguments to Playwright: `npm test -- -g "\[B3\]"`.
 */
import { spawn } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`${command}: ${err.message}`);
      resolve(1);
    });
  });
}

const engineTests = [];
for await (const entry of glob('tests/engine/*.test.mjs', { cwd: root })) engineTests.push(entry);
engineTests.sort();

console.log(`\n=== engine contracts (${engineTests.length} files) ===\n`);
const engineCode = await run(process.execPath, ['--test', ...engineTests]);

console.log('\n=== acceptance suite (Playwright) ===\n');
const pwCode = await run(process.execPath, [
  join(root, 'node_modules/@playwright/test/cli.js'),
  'test',
  ...process.argv.slice(2),
]);

const line = (name, code) => `${code === 0 ? 'PASS' : 'FAIL'}  ${name}`;
console.log('\n=== npm test ===');
console.log(line('engine contracts (node --test tests/engine)', engineCode));
console.log(line('acceptance suite (playwright test)', pwCode));
if (engineCode !== 0 || pwCode !== 0) {
  console.log(
    'Per-test detail: engine failures are printed above; e2e failures are in ' +
      'artifacts/e2e-results.json — query it, do not read it whole ' +
      "(jq -r '.suites[].specs[]? | select(.ok==false) | .title').",
  );
}

process.exit(engineCode !== 0 || pwCode !== 0 ? 1 : 0);
