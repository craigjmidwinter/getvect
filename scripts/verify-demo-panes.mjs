#!/usr/bin/env node
/**
 * The demo's TRACED SVG pane must be a function of the SVG alone.
 *
 * The slider stacks the source PNG under the traced SVG and clips to a moving
 * seam. When only the vector was clipped, the raster stayed underneath across
 * the whole stage, so the right-hand pane was `vector over raster` — and on the
 * sticker's outer silhouette, the one edge that meets transparency, the source's
 * pixel staircase showed through from below and the demo advertised a defect the
 * SVG does not contain.
 *
 * Eyeballing the staircase is how that was found; it is not how it should be
 * checked. The property that actually matters is stronger and is exact: with the
 * panes clipped correctly, HIDING THE RASTER ENTIRELY must not change the right
 * pane by a single pixel. This screenshots the pane twice — raster present, then
 * `display:none` — and compares the bytes.
 *
 *   node scripts/verify-demo-panes.mjs                    # the working tree
 *   node scripts/verify-demo-panes.mjs --url https://…    # whatever is deployed
 *   node scripts/verify-demo-panes.mjs --image fixtures/third-party/x.jpg
 *                                                        # ...with artwork we did not draw
 *
 * Headless Chromium, launched and owned by this script. It must never drive a
 * browser a human is sitting in front of.
 */
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const urlAt = argv.indexOf('--url');
const externalUrl = urlAt !== -1 ? argv[urlAt + 1] : null;
const keep = argv.includes('--save');
const imageAt = argv.indexOf('--image');
const foreignImage = imageAt !== -1 ? argv[imageAt + 1] : null;
/**
 * Undo the fix in-page, to prove the check can still fail on this artwork.
 * A pass is only evidence if a fail was reachable: opaque artwork gets a
 * backdrop rect in the trace, so the vector may cover the raster everywhere and
 * the check would pass with or without the clip. That is worth knowing rather
 * than reporting a green that could not have been red.
 */
const breakIt = argv.includes('--break');

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

/** Serve site/ so the page loads over http, the way it is deployed. */
async function serveSite() {
  const dir = join(root, 'site');
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(dir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    createReadStream(file)
      .on('open', () => res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }))
      .on('error', () => res.writeHead(404).end('not found'))
      .pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/index.html`, close: () => server.close() };
}

/**
 * Park the demo on the ear notch at 16x — the site Craig screenshotted, and the
 * worst case for this defect because it is where the silhouette meets
 * transparency. Returns the right-hand pane's bounding box.
 */
const PARK = ({ fx, fy, z }) => {
  const stage = document.getElementById('stage');
  const zoomBtn = document.querySelector(`#zoom button[data-z="${z}"]`);
  if (zoomBtn) zoomBtn.click();
  const raster = stage.querySelector('.demo-raster img');
  const NW = raster.naturalWidth || 1195, NH = raster.naturalHeight || 896;
  const sx = fx * NW, sy = fy * NH;
  const R = stage.getBoundingClientRect();
  const k = Math.min(R.width / NW, R.height / NH);
  const ox = (R.width - NW * k) / 2, oy = (R.height - NH * k) / 2;
  const tx = R.width / 2 - z * (ox + sx * k), ty = R.height / 2 - z * (oy + sy * k);
  stage.style.setProperty('--tx', tx);
  stage.style.setProperty('--ty', ty);
  for (const img of stage.querySelectorAll('.demo-layer img')) {
    img.style.transition = 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  }
  // the traced pane is everything right of the seam, inset to avoid the divider
  const pos = Number(getComputedStyle(stage).getPropertyValue('--pos')) || 50;
  const seam = R.left + R.width * pos / 100;
  return { x: Math.round(seam + 4), y: Math.round(R.top + 2),
           width: Math.round(R.right - seam - 6), height: Math.round(R.height - 4) };
};

/**
 * Sites are FRACTIONS of the image, not pixels, so the same check runs against
 * artwork of any size. The mascot's are the ear notch and ear crown — where the
 * silhouette meets transparency, which is where the leak showed. Foreign artwork
 * gets a spread instead: the property must hold everywhere, so any position that
 * differs is a failure, and there is no reason to hand-pick a flattering one.
 */
const MASCOT_SITES = [
  { name: 'ear notch @ 16x', fx: 560 / 1195, fy: 160 / 896, z: 16 },
  { name: 'ear crown @ 16x', fx: 600 / 1195, fy: 130 / 896, z: 16 },
  { name: 'whole cat @ 1x', fx: 0.5, fy: 0.5, z: 1 },
];

const FOREIGN_SITES = [
  { name: 'upper left @ 16x', fx: 0.3, fy: 0.3, z: 16 },
  { name: 'centre @ 16x', fx: 0.5, fy: 0.5, z: 16 },
  { name: 'lower right @ 16x', fx: 0.7, fy: 0.66, z: 16 },
  { name: 'edge @ 16x', fx: 0.5, fy: 0.08, z: 16 },
  { name: 'whole image @ 4x', fx: 0.5, fy: 0.5, z: 4 },
  { name: 'whole image @ 1x', fx: 0.5, fy: 0.5, z: 1 },
];

const SITES = foreignImage ? FOREIGN_SITES : MASCOT_SITES;

/** Trace a corpus image at the demo's own settings and return both as data URIs. */
async function traceForDemo(file) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { vectorize } = require(join(root, 'dist/engine/index.js'));
  const { canvasIngest, decodeImageFile } = await import(join(root, 'instruments/lib/decode.mjs'));
  const sharp = require('sharp');

  const image = await decodeImageFile(file);
  // the demo's own settings, so this is the trace a user would get
  const { svg } = await vectorize(canvasIngest(image), { colorCount: 8, antiAliasing: 'smart', minArea: 5 });
  const png = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png().toBuffer();

  return {
    label: `${file.split('/').pop()} (${image.width}x${image.height}, ${(svg.length / 1024).toFixed(0)} KB SVG)`,
    pngDataUri: `data:image/png;base64,${png.toString('base64')}`,
    svgDataUri: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
  };
}

const served = externalUrl ? null : await serveSite();
const target = externalUrl ?? served.url;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(target, { waitUntil: 'networkidle' });

/**
 * Swap the demo's content for artwork nobody here drew.
 *
 * The clip-path fix knows nothing about what it is clipping, so it is
 * image-agnostic by construction — but "by construction" is an argument, and the
 * point of the corpus is that our own drawing cannot certify a change. Both
 * images go in as data URIs against the DEPLOYED page, so it is the shipped CSS
 * being tested and not a local copy of it.
 */
if (foreignImage) {
  const { pngDataUri, svgDataUri, label } = await traceForDemo(foreignImage);
  await page.evaluate(({ png, svg }) => {
    const stage = document.getElementById('stage');
    const r = stage.querySelector('.demo-raster img');
    const v = stage.querySelector('.demo-vector img');
    for (const [img, src] of [[r, png], [v, svg]]) {
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.src = src;
    }
  }, { png: pngDataUri, svg: svgDataUri });
  await page.waitForFunction(() => {
    const r = document.querySelector('.demo-raster img');
    const v = document.querySelector('.demo-vector img');
    return r.complete && v.complete && r.naturalWidth > 0 && v.naturalWidth > 0;
  }, null, { timeout: 30_000 });
  console.log(`\ncontent swapped for ${label} — artwork we did not draw`);
}

if (breakIt) {
  await page.addStyleTag({ content: '.demo-raster { clip-path: none !important; }' });
  console.log('\n--break: raster clip removed, reproducing the pre-fix compositing');
}

await page.locator('#stage').scrollIntoViewIfNeeded();

console.log(`\nverifying ${target}\n`);
console.log('  the TRACED pane must not change when the raster layer is removed\n');

let failures = 0;
for (const site of SITES) {
  const box = await page.evaluate(PARK, site);
  await page.waitForTimeout(500);

  const withRaster = await page.screenshot({ clip: box });
  await page.addStyleTag({ content: '.demo-raster { display: none !important; }' });
  await page.waitForTimeout(200);
  const without = await page.screenshot({ clip: box });
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('style')].reverse()
      .find((e) => e.textContent.includes('display: none'));
    if (t) t.remove();
  });
  await page.waitForTimeout(200);

  const same = Buffer.compare(withRaster, without) === 0;
  if (!same) failures++;
  console.log(`  ${same ? 'PASS' : 'FAIL'}  ${site.name.padEnd(18)} ` +
    (same ? 'pane is the SVG alone'
          : `pane changes when the raster is hidden — the source PNG is showing through`));

  if (keep || !same) {
    const tag = site.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await fs.mkdir(join(root, 'artifacts/demo-panes'), { recursive: true });
    await fs.writeFile(join(root, `artifacts/demo-panes/${tag}-shipped.png`), withRaster);
    await fs.writeFile(join(root, `artifacts/demo-panes/${tag}-svg-only.png`), without);
    console.log(`        wrote artifacts/demo-panes/${tag}-{shipped,svg-only}.png`);
  }
}

await browser.close();
served?.close();
console.log(failures ? `\n${failures} site(s) FAILED\n` : '\nall sites pass\n');
process.exit(failures ? 1 : 0);
