#!/usr/bin/env node
/**
 * Compile `electron-updater` into a single file the packaged app can require.
 *
 * WHY THIS EXISTS. `electron-builder.yml` excludes `node_modules/**` from the
 * bundle outright — that exclusion is what keeps sharp's LGPL libvips and
 * resvg's MPL code (both harness-only) out of a distributed GetVect, and it is
 * worth more than the convenience of shipping a dependency tree. But the update
 * check is real runtime code and `electron-updater` pulls in sixteen packages
 * transitively, so "just add it back to `files`" means hand-maintaining a
 * sixteen-entry allowlist whose drift is only discoverable by running a
 * packaged build.
 *
 * So the updater is bundled instead: one esbuild pass, one output file under
 * `dist/`, which the existing `files: dist/**\/*` already ships. Nothing about
 * the packaging config has to know that the update check exists, there is no
 * dependency list to keep in sync, and the exact third-party bytes in the app
 * are one readable file you can grep.
 *
 * Everything except `electron` itself and Node's builtins is inlined; esbuild
 * reports no unresolved dynamic requires. Output is deliberately NOT minified:
 * a 576 KB readable file in an asar is free, and being able to read what you
 * ship is not.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'main', 'vendor', 'electron-updater.js');

const result = await build({
  stdin: {
    contents: "module.exports = require('electron-updater');\n",
    resolveDir: root,
    sourcefile: 'vendor-entry.cjs',
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  // Electron 43 ships Node 22; 20 is the floor the repo builds on.
  target: 'node20',
  format: 'cjs',
  // Resolved from the running Electron, never bundled.
  external: ['electron'],
  // Licence headers of everything inlined, kept at the end of the file.
  legalComments: 'eof',
  // The exact list of files esbuild pulled in. `generate-third-party-notices.mjs`
  // reads it to build the notice from what was ACTUALLY bundled rather than from
  // what package.json declares — the two differ here, and the declared list is
  // the larger one.
  metafile: true,
  outfile,
  logLevel: 'warning',
});

if (result.warnings.length > 0) {
  // A dynamic require esbuild could not follow would show up here, and it would
  // mean a packaged app that throws at update-check time and nowhere else.
  console.error(`[bundle-updater] ${result.warnings.length} warning(s) — see above`);
  process.exit(1);
}

const metaPath = path.join(root, 'dist', 'main', 'vendor', 'electron-updater.meta.json');
await (await import('node:fs/promises')).writeFile(metaPath, JSON.stringify(result.metafile));

console.log(`[bundle-updater] wrote ${path.relative(root, outfile)}`);
