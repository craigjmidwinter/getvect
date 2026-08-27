#!/usr/bin/env node
/**
 * Compile the engine into one file the packaged main process can require.
 *
 * WHY THIS EXISTS. `electron-builder.yml` excludes `node_modules/**` from the
 * bundle — that exclusion is deliberate and load-bearing, since it is what keeps
 * sharp's LGPL libvips and resvg's MPL code out of a distributed GetVect. The
 * renderer never noticed because vite inlines everything it imports. The main
 * process did: `dist/engine/trace.js` is tsc output and still says
 * `require('imagetracerjs')`, which resolves fine from a clone and not at all
 * from inside an asar.
 *
 * That failure is invisible everywhere except the packaged app. `npm start`
 * works, the tests work, the GUI works — and `GetVect.app ... logo.png` exits
 * with "Cannot find module 'imagetracerjs'". It was found by running the
 * artefact, which is the only place it exists.
 *
 * Same treatment as `bundle-updater.mjs`, for the same reason: one esbuild pass,
 * one output file under `dist/`, which `files: dist/**` already ships. No
 * dependency allowlist to keep in sync, and the third-party bytes in the app
 * stay greppable in one readable file.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'main', 'vendor', 'engine.js');

const result = await build({
  entryPoints: [path.join(root, 'dist', 'engine', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Resolved from the running Electron, never bundled.
  external: ['electron'],
  legalComments: 'eof',
  metafile: true,
  // Not minified: a readable file inside an asar costs nothing, and being able
  // to read what you ship is not nothing.
  minify: false,
  outfile,
  logLevel: 'warning',
});

if (result.warnings.length > 0) {
  console.error(`[bundle-engine] ${result.warnings.length} warning(s) — see above`);
  process.exit(1);
}

await writeFile(
  path.join(root, 'dist', 'main', 'vendor', 'engine.meta.json'),
  JSON.stringify(result.metafile),
);

console.log(`[bundle-engine] wrote ${path.relative(root, outfile)}`);
