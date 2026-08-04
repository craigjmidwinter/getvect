#!/usr/bin/env node
/**
 * postinstall guard for the Electron binary. Two failure modes it repairs:
 *
 * 1. **Missing binary.** Electron's own postinstall downloads a ~200MB zip and
 *    extracts it; that extraction can silently no-op (sandboxed installs,
 *    interrupted downloads), leaving `node_modules/electron/dist` with only
 *    LICENSE files. Symptom: `spawn .../Electron ENOENT` from every e2e test.
 *
 * 2. **Unsigned app on modern macOS.** Recent macOS refuses to exec the
 *    freshly-extracted, unsigned Electron.app and DELETES it — so the binary
 *    exists until the first launch attempt, then vanishes, and the next run
 *    reports ENOENT again. The fix is to strip quarantine/provenance xattrs and
 *    apply an ad-hoc signature.
 *
 * Safe to run repeatedly; a no-op once the app is present and signed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });

let binary;
try {
  binary = require(join(root, 'node_modules/electron'));
} catch {
  console.log('[verify-electron] electron not installed yet — skipping.');
  process.exit(0);
}

if (typeof binary !== 'string') {
  console.log('[verify-electron] unexpected electron module shape — skipping.');
  process.exit(0);
}

if (!existsSync(binary)) {
  console.log('[verify-electron] Electron binary missing — re-running electron/install.js …');
  try {
    run(process.execPath, [join(root, 'node_modules/electron/install.js')], { stdio: 'inherit' });
  } catch (err) {
    console.error(`[verify-electron] install.js failed: ${err.message}`);
  }
}

if (!existsSync(binary)) {
  console.error(
    `[verify-electron] Electron is STILL missing at ${binary}.\n` +
      '  Fix manually with: node node_modules/electron/install.js\n' +
      '  (needs network the first time; the zip is cached in ~/Library/Caches/electron)',
  );
  process.exit(0); // never fail the install — just make the cause obvious
}

if (process.platform === 'darwin') {
  // .../Electron.app/Contents/MacOS/Electron -> .../Electron.app
  const appBundle = resolve(binary, '../../..');
  let valid = false;
  try {
    run('codesign', ['--verify', '--no-strict', appBundle]);
    valid = true;
  } catch {
    valid = false;
  }
  if (!valid) {
    console.log('[verify-electron] ad-hoc signing Electron.app (macOS would otherwise delete it) …');
    try {
      run('xattr', ['-cr', appBundle]);
    } catch {
      /* xattr failures are not fatal */
    }
    try {
      run('codesign', ['--force', '--deep', '--sign', '-', appBundle]);
      console.log('[verify-electron] signed.');
    } catch (err) {
      console.error(
        `[verify-electron] codesign failed: ${err.message}\n` +
          '  Run manually: codesign --force --deep --sign - node_modules/electron/dist/Electron.app',
      );
    }
  }
}
