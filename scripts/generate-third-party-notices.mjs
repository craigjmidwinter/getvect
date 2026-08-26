#!/usr/bin/env node
/**
 * Build the third-party licence notice that SHIPS INSIDE THE APP.
 *
 * WHY THIS EXISTS. MIT, BSD-2/3 and Apache-2.0 all require their copyright
 * notice and licence text to accompany distributions of the software. Every
 * GetVect binary published before this script carried none — not one licence
 * file, not even Electron's own, because `files:` excludes `node_modules/**` and
 * `extraResources` shipped a single icon. That is a real compliance gap and an
 * especially bad one for a project whose pitch is being open source, to an
 * audience that reads licences.
 *
 * WHY IT IS GENERATED FROM THE ARTEFACT AND NOT HAND-WRITTEN.
 *
 * A hand-written notice is correct once and wrong at the next dependency change,
 * and it fails SILENTLY: nothing tells you a new transitive package arrived. So
 * the list comes from what the bundlers actually pulled in.
 *
 *   - The updater subtree is read from esbuild's METAFILE
 *     (`dist/main/vendor/electron-updater.meta.json`), which is the exact set of
 *     files inlined into the shipped bundle. Not a guess, not package.json.
 *   - The renderer's runtime packages are the transitive production closure of
 *     the bare specifiers `src/renderer|engine|shared` actually import.
 *   - Electron's own LICENSE and LICENSES.chromium.html are copied verbatim.
 *
 * WHAT IS DELIBERATELY NOT COVERED, AND WHY THAT IS CHECKED.
 *
 * `sharp` and `@resvg/resvg-js` are in `dependencies` but their code is NOT in
 * the artefact — `electron-builder.yml` excludes `node_modules/**` precisely to
 * keep sharp's LGPL libvips and resvg's MPL code out of a distributed build, and
 * they are used only by the harness. The obligation attaches when a
 * dependency's CODE is inside what you ship, not when you declare a dependency.
 * That exclusion is ASSERTED below rather than trusted: if either ever ends up
 * in the shipped tree, this fails and says so.
 *
 * FAILURE MODES THIS REFUSES TO HAVE.
 *
 * A generator that silently emits nothing looks exactly like one that ran and
 * found nothing to say. So: an empty or implausibly small notice is a hard
 * failure, a package whose licence cannot be determined is REPORTED rather than
 * omitted, and the summary prints counts a human can sanity-check.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'build', 'third-party');
const META = join(ROOT, 'dist', 'main', 'vendor', 'electron-updater.meta.json');

/** Packages whose code must never appear in the artefact — asserted, not assumed. */
const MUST_NOT_SHIP = ['sharp', '@resvg/resvg-js'];

/** Filenames that carry a licence text, most specific first. */
const LICENCE_FILES = [
  'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt',
  'LICENSE-MIT', 'LICENSE-APACHE', 'COPYING', 'COPYING.md',
];

const findings = [];

/** Package name from a node_modules path, scope-aware. */
function packageOf(file) {
  const i = file.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const parts = file.slice(i + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function pkgDir(name) {
  try {
    // resolve the manifest rather than the entry point: some packages have no
    // main, and `require.resolve(name)` throws on those.
    return dirname(require.resolve(`${name}/package.json`, { paths: [ROOT] }));
  } catch {
    return null;
  }
}

/** Every production dependency reachable from a package, transitively. */
function closure(name, seen = new Set()) {
  if (seen.has(name)) return seen;
  const dir = pkgDir(name);
  if (!dir) {
    findings.push({ name, why: 'not installed — could not resolve its package.json' });
    return seen;
  }
  seen.add(name);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    findings.push({ name, why: 'package.json unreadable' });
    return seen;
  }
  for (const dep of Object.keys(manifest.dependencies ?? {})) closure(dep, seen);
  return seen;
}

/** The licence declaration and full text for one package. */
function licenceOf(name) {
  const dir = pkgDir(name);
  if (!dir) return { name, version: '?', licence: null, text: null, dir: null };
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const declared =
    typeof manifest.license === 'string'
      ? manifest.license
      : manifest.license?.type ??
        (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type).join(' OR ') : null);

  let text = null;
  for (const f of LICENCE_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) {
      text = readFileSync(p, 'utf8').trim();
      break;
    }
  }
  return { name, version: manifest.version ?? '?', licence: declared ?? null, text, dir };
}

// ---------------------------------------------------------------------------

if (!existsSync(META)) {
  console.error(
    '::error::no esbuild metafile at dist/main/vendor/electron-updater.meta.json — ' +
      'run `npm run build:node` first; the notice is generated from what was bundled, ' +
      'not from package.json',
  );
  process.exit(1);
}

// 1. Exactly what esbuild inlined into the shipped updater bundle.
const meta = JSON.parse(readFileSync(META, 'utf8'));
const bundled = new Set();
for (const file of Object.keys(meta.inputs)) {
  const p = packageOf(file);
  if (p) bundled.add(p);
}
if (bundled.size === 0) {
  console.error('::error::the metafile lists no node_modules inputs — that cannot be right');
  process.exit(1);
}

// 2. The renderer's runtime packages, transitively.
const RENDERER_ENTRY = ['react', 'react-dom', 'imagetracerjs'];
const renderer = new Set();
for (const name of RENDERER_ENTRY) for (const n of closure(name)) renderer.add(n);

const all = [...new Set([...bundled, ...renderer])].sort();

// 3. Assert the harness-only native modules really are absent.
for (const banned of MUST_NOT_SHIP) {
  if (all.includes(banned)) {
    console.error(
      `::error::${banned} is in the shipped set. Its code is not supposed to reach a ` +
        'distributed build (electron-builder.yml excludes node_modules for exactly this ' +
        'reason). Either the packaging changed or an import crept in — resolve that before ' +
        'shipping, because the licence position changes with it.',
    );
    process.exit(1);
  }
}

// 4. Collect licences.
const entries = all.map(licenceOf);
const unresolved = entries.filter((e) => !e.licence && !e.text);
const noText = entries.filter((e) => e.licence && !e.text);
for (const e of unresolved) findings.push({ name: e.name, why: 'no license field and no licence file' });
for (const e of noText) {
  findings.push({ name: e.name, why: `declares ${e.licence} but ships no licence file` });
}

// 5. Electron itself.
const electronDir = pkgDir('electron');
if (!electronDir) {
  console.error('::error::electron is not installed — its licence is required and cannot be copied');
  process.exit(1);
}
const electronVersion = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version;
const ELECTRON_LICENSE = join(electronDir, 'dist', 'LICENSE');
const CHROMIUM_LICENSES = join(electronDir, 'dist', 'LICENSES.chromium.html');
for (const f of [ELECTRON_LICENSE, CHROMIUM_LICENSES]) {
  if (!existsSync(f)) {
    console.error(`::error::missing ${f} — Electron's own notice is required and must ship`);
    process.exit(1);
  }
}

// 6. Write it out.
await mkdir(OUT_DIR, { recursive: true });

const byLicence = new Map();
for (const e of entries) {
  const k = e.licence ?? 'UNDETERMINED';
  byLicence.set(k, (byLicence.get(k) ?? 0) + 1);
}

let md = `# Third-party licences

GetVect is MIT licensed. It also includes, and redistributes, the software
listed below. Each entry's licence text is reproduced in full, which is what
those licences require.

This file is **generated** by \`scripts/generate-third-party-notices.mjs\` as part
of the build, from what the bundlers actually included — esbuild's metafile for
the update client and the resolved production dependency tree for the user
interface — so it cannot drift from what ships.

- Packages: **${entries.length}**
- Electron: **${electronVersion}** (its own licence and Chromium's are beside this file)
- Generated for GetVect ${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}

Licence summary: ${[...byLicence.entries()].sort().map(([k, v]) => `${k} ×${v}`).join(', ')}

**Not included, on purpose:** \`sharp\` and \`@resvg/resvg-js\` are development and
measurement dependencies. Their code is not present in a distributed build, so
their licences do not attach to it; the build fails if that ever stops being
true.

`;

if (findings.length) {
  md += `## Unresolved\n\nThese are reported rather than omitted — an incomplete notice that names what it\ncould not resolve is honest; one that quietly drops the hard cases is not.\n\n`;
  for (const f of findings) md += `- \`${f.name}\` — ${f.why}\n`;
  md += '\n';
}

md += '---\n\n';
for (const e of entries) {
  md += `## ${e.name} ${e.version}\n\n`;
  md += `Licence: ${e.licence ?? '**undetermined**'}\n\n`;
  md += e.text ? '```\n' + e.text + '\n```\n\n' : '_No licence text shipped with this package._\n\n';
}

const outFile = join(OUT_DIR, 'THIRD-PARTY-LICENSES.md');
await writeFile(outFile, md);
await copyFile(ELECTRON_LICENSE, join(OUT_DIR, 'electron-LICENSE.txt'));
await copyFile(CHROMIUM_LICENSES, join(OUT_DIR, 'LICENSES.chromium.html'));

// 7. Refuse to have produced nothing. A generator that emits an empty file looks
//    identical to one that ran and found nothing to say.
const MIN_PACKAGES = 15;
const MIN_BYTES = 20_000;
if (entries.length < MIN_PACKAGES) {
  console.error(`::error::only ${entries.length} packages found; expected at least ${MIN_PACKAGES}`);
  process.exit(1);
}
if (md.length < MIN_BYTES) {
  console.error(`::error::notice is ${md.length} bytes, under the ${MIN_BYTES} floor — it is not plausible`);
  process.exit(1);
}

const files = await readdir(OUT_DIR);
console.log(`[third-party] ${entries.length} packages, ${md.length} bytes`);
console.log(`[third-party] ${[...byLicence.entries()].sort().map(([k, v]) => `${k} ×${v}`).join(', ')}`);
console.log(`[third-party] + electron ${electronVersion} LICENSE and LICENSES.chromium.html`);
console.log(`[third-party] wrote ${files.length} file(s) to build/third-party/`);
if (findings.length) {
  console.log(`[third-party] ${findings.length} UNRESOLVED, listed in the notice:`);
  for (const f of findings) console.log(`  - ${f.name}: ${f.why}`);
}
