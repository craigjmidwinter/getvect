#!/usr/bin/env node
/**
 * Fetch a third-party fixture image, licence first.
 *
 * The corpus had no artwork this project did not draw, which is why a mask-stage
 * change that nobody could prove either way had to be removed
 * (`docs/HARNESS.md`, "Who is allowed to decide that a change is an
 * improvement"). This is the tool that fixes that, and its whole design is the
 * constraint: **the licence is read before the bytes are.**
 *
 *   1. ask Wikimedia Commons for the file's metadata,
 *   2. refuse anything whose licence is not on `ALLOWED` — no override flag, so
 *      an asset whose terms we cannot state cannot be committed by accident,
 *   3. only then download, at a requested width, and
 *   4. append licence, author, source URL and the exact file URL to
 *      `fixtures/third-party/LICENSES.md`, next to the asset.
 *
 * Rasters only. Never another tracer's output: we take IMAGES and trace them
 * ourselves, which is also why nothing here is an SVG.
 *
 *   node scripts/source-fixture.mjs "File:Example.jpg" out-name.jpg 900
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const API = 'https://commons.wikimedia.org/w/api.php';
const OUT_DIR = 'fixtures/third-party';
const LICENSES = join(OUT_DIR, 'LICENSES.md');

/**
 * Licences a fresh clone may legally ship. Deliberately short.
 *
 * "Free to use" is not on it, and neither is anything whose terms have to be
 * chased through a third party's own site — the local fixtures already failed
 * exactly that test, and they are why CI has no artwork that can decide
 * anything.
 */
const ALLOWED = [
  /^public domain$/i,
  /^cc0$/i,
  /^cc[- ]?by[- ]?\d/i,
  /^cc[- ]?by$/i,
  /^pd[- ]/i,
];

const strip = (html) =>
  String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

async function metadata(title, width) {
  const url =
    `${API}?action=query&format=json&titles=${encodeURIComponent(title)}` +
    `&prop=imageinfo&iiprop=url|size|mime|extmetadata` +
    (width ? `&iiurlwidth=${width}` : '');
  const res = await fetch(url, { headers: { 'user-agent': 'getvect-fixture-sourcing/0.1' } });
  if (!res.ok) throw new Error(`Commons API ${res.status}`);
  const data = await res.json();
  const page = Object.values(data.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) throw new Error(`no such file: ${title}`);
  const info = page.imageinfo?.[0];
  if (!info) throw new Error(`no imageinfo for ${title}`);
  const em = info.extmetadata ?? {};
  return {
    title: page.title,
    width: info.width,
    height: info.height,
    mime: info.mime,
    fileUrl: info.url,
    // Commons computes this itself; constructing thumbnail paths by hand fails
    // on any title that needs percent-encoding.
    thumbUrl: info.thumburl ?? null,
    descriptionUrl: info.descriptionurl,
    license: strip(em.LicenseShortName?.value) || '(none stated)',
    licenseUrl: strip(em.LicenseUrl?.value),
    usageTerms: strip(em.UsageTerms?.value),
    artist: strip(em.Artist?.value) || '(not stated)',
    credit: strip(em.Credit?.value),
    date: strip(em.DateTimeOriginal?.value),
  };
}

const [, , title, outName, widthArg] = process.argv;
if (!title || !outName) {
  console.error('usage: source-fixture.mjs "File:Title.jpg" out-name.jpg [width]');
  process.exit(2);
}

const width = widthArg ? Number(widthArg) : null;
const meta = await metadata(title, width);
console.log(`  title    ${meta.title}`);
console.log(`  licence  ${meta.license}${meta.licenseUrl ? `  (${meta.licenseUrl})` : ''}`);
console.log(`  author   ${meta.artist}`);
console.log(`  source   ${meta.descriptionUrl}`);
console.log(`  original ${meta.width}x${meta.height} ${meta.mime}`);

if (!ALLOWED.some((re) => re.test(meta.license))) {
  console.error(
    `\nREFUSED: licence "${meta.license}" is not on the allowlist.\n` +
      `An asset whose terms we cannot state does not get committed. There is no ` +
      `override flag here on purpose.`,
  );
  process.exit(1);
}

let downloadUrl = meta.fileUrl.split('?')[0];
if (width && width < meta.width) {
  if (!meta.thumbUrl) throw new Error('Commons returned no thumbnail for this width');
  downloadUrl = meta.thumbUrl.split('?')[0];
}

const res = await fetch(downloadUrl, { headers: { 'user-agent': 'getvect-fixture-sourcing/0.1' } });
if (!res.ok) throw new Error(`download ${res.status} for ${downloadUrl}`);
const bytes = Buffer.from(await res.arrayBuffer());
await fs.mkdir(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, outName);
await fs.writeFile(outPath, bytes);
console.log(`  wrote    ${outPath}  ${bytes.length} bytes`);

const entry =
  `\n### \`${outName}\`\n\n` +
  `- **Licence**: ${meta.license}${meta.licenseUrl ? ` — ${meta.licenseUrl}` : ''}\n` +
  (meta.usageTerms ? `- **Usage terms**: ${meta.usageTerms}\n` : '') +
  `- **Author**: ${meta.artist}\n` +
  (meta.credit ? `- **Credit**: ${meta.credit}\n` : '') +
  (meta.date ? `- **Date**: ${meta.date}\n` : '') +
  `- **Source page**: ${meta.descriptionUrl}\n` +
  `- **File fetched**: ${downloadUrl}\n` +
  `- **Original**: ${meta.width}×${meta.height} ${meta.mime}` +
  (width && width < meta.width ? `, fetched rescaled to ${width}px wide\n` : `\n`);

let existing = '';
try {
  existing = await fs.readFile(LICENSES, 'utf8');
} catch {
  existing =
    `# Third-party fixture artwork — licences\n\n` +
    `Artwork in \`fixtures/third-party/\` was made by someone outside this project.\n` +
    `That is the point of it: our own drawings cannot tell an improvement from a\n` +
    `change tuned to them, so only these can decide that a change to the engine\n` +
    `helps a user's images (\`docs/HARNESS.md\`, "Who is allowed to decide that a\n` +
    `change is an improvement").\n\n` +
    `Everything here is redistributable, and every entry below was written by\n` +
    `\`scripts/source-fixture.mjs\` from the source's own metadata **before** the\n` +
    `file was downloaded — the tool refuses any licence not on its allowlist and\n` +
    `has no override.\n\n` +
    `These are IMAGES. No traced SVG from any other product is here, or ever\n` +
    `should be.\n`;
}
await fs.writeFile(LICENSES, existing + entry);
console.log(`  recorded ${LICENSES}`);
