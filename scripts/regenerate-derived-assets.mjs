#!/usr/bin/env node
/**
 * `npm run assets` — regenerate every derived asset from its one source.
 *
 * WHY THIS EXISTS. Half the pictures in this repo are *engine output*: the
 * traced mascot on the README, the before/after composite, the landing page's
 * before/after demo. They were produced once, by hand, and then the engine kept
 * moving. The live demo at getvect.midwinter.io spent a week serving a trace
 * made before the alpha-ingest fix — an invented black backdrop, on a sticker
 * whose whole selling point is that the background stays transparent — because
 * "regenerate the marketing assets" was a thing someone had to *remember*.
 *
 * So it is a script, and CI checks it. Everything below is derived; nothing
 * below is hand-edited. Change the mascot or change the engine, run this, and
 * every downstream copy moves with it.
 *
 *   npm run assets            regenerate all of it, in place
 *   npm run assets -- --check CI mode: nothing is written, exit 1 if stale
 *
 * Needs the compiled engine (`npm run build:node`) — the npm script does it.
 *
 * WHAT --check CAN AND CANNOT PROVE. `vectorize()` is deterministic by
 * contract, so the traced SVG is compared byte-for-byte against the committed
 * one. PNG encoders and `iconutil` are not byte-reproducible across machines
 * and versions, so for those we compare a *sources* stamp instead
 * (`scripts/derived-assets.stamp.json`): the hash of the mascot, of the engine
 * source, and of this script. If the inputs match the stamp, the outputs were
 * generated from those inputs.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import { decodeImageFile, canvasIngest } from '../instruments/lib/decode.mjs';

// ===========================================================================
// CONFIG — the single source of truth. Everything else in this file is
// mechanism.
// ===========================================================================

/**
 * THE MASCOT. One constant, because every derived asset in the repo is a
 * function of this file: the traced SVG, the before/after composite, the app
 * icon, the favicon, the site's raster half of the demo.
 *
 * Swapping the mascot is: drop the new artwork in, change these two lines, run
 * `npm run assets`. `SLUG` is the filename stem the outputs are named after
 * (`<slug>-vector.svg`, `<slug>-mascot.png`, …), so a rename travels with the
 * swap.
 */
const MASCOT_SOURCE = 'fixtures/reference/frankie-sticker.png';
const SLUG = 'frankie';

/**
 * THE DEMO TRACE. The settings docs/assets/<slug>-vector.svg is generated at,
 * and the ones README.md and site/index.html describe in prose ("Traced at 8
 * colours with Smart anti-aliasing"). If you change these, the copy has to
 * change with them — the drift table this script prints will say so.
 *
 * These are also the settings the mascot exemplar A/B is recorded at, minus
 * Enhance: the demo asset is what the app gives you with the palette set to 8,
 * nothing else touched.
 */
const DEMO_SETTINGS = { colorCount: 8, antiAliasing: 'smart', minArea: 5 };

/**
 * THE BEFORE/AFTER COMPOSITE. Two panels on a dark card: the source raster,
 * magnified with nearest-neighbour so its pixels are visible as pixels, next to
 * the traced SVG rasterized at the same magnification so its curves are not.
 *
 * `crop` is in source pixels and `zoom` is the magnification, so the panel is
 * exactly `crop * zoom`. Framing is the mascot's face — both eyes, the nose and
 * the mouth, which is where a tracer's mistakes are legible.
 *
 * `crop.width` is not free: the geometry assertion below requires the two panels
 * plus the padding and gap to fill `width` exactly, which at zoom 2 pins it to
 * 315. Re-frame by moving `crop.x` / `crop.y`, and change `crop.width` only
 * together with `zoom`/`pad`/`gap`.
 */
const BEFORE_AFTER = {
  width: 1280,
  height: 560,
  pad: 7,
  gap: 6,
  /** Height of the label band above the panels. */
  header: 44,
  background: '#0e1116',
  crop: { x: 210, y: 250, width: 315, height: 254 },
  zoom: 2,
  title: { size: 15, weight: 700, fill: '#ffffff', baseline: 26, tracking: 0.4 },
  subtitle: { size: 11, weight: 400, fill: '#9aa0a6', baseline: 42, tracking: 0 },
  font: 'Helvetica Neue, Helvetica, Arial, sans-serif',
};

/**
 * THE APP ICON. Trim the mascot to its own ink, drop it on a dark rounded
 * square, nudge it down a hair so the tail's visual weight does not make it
 * look high in the Dock.
 */
const ICON = {
  size: 1024,
  background: '#12141a',
  /** Corner radius at 1024 — macOS's own squircle is close to this. */
  cornerRadius: 180,
  /** Mascot's longest side as a fraction of the icon. */
  mascotScale: 0.78,
  /** Downward nudge, in 1024-space. */
  mascotOffsetY: 10,
  /** Sizes iconutil wants in the .iconset (each also emitted at @2x). */
  icnsSizes: [16, 32, 64, 128, 256, 512],
};

/** 32px, and the only asset outside docs/ + site/ + build/ this script owns. */
const FAVICON_SIZE = 32;
/** The site serves a 96px one so a retina tab is not a blur. */
const SITE_FAVICON_SIZE = 96;

/**
 * Site copies are re-encoded to a palette PNG: the pages are static and
 * unbundled, so a megabyte of screenshots is a megabyte on the wire.
 */
const SITE_PNG = { palette: true, quality: 90, compressionLevel: 9, effort: 10 };

/**
 * KB, the way the existing copy counts it: bytes/1000, truncated
 * (352 776 B -> "352 KB"). Stated once here so the README, the site and the
 * labels burned into the composite cannot disagree about arithmetic.
 */
const kb = (bytes) => Math.floor(bytes / 1000);

/**
 * THE MANIFEST — every file this script owns. Anything listed here is
 * generated: edit the source or edit this script, never the output.
 *
 * `deterministic` marks the artifacts `--check` can diff byte-for-byte. The
 * rest are covered by the sources stamp.
 */
const MANIFEST = [
  { path: `docs/assets/${SLUG}-vector.svg`, from: 'engine', deterministic: true,
    note: `vectorize(${JSON.stringify(DEMO_SETTINGS)})` },
  { path: `docs/assets/${SLUG}-mascot.png`, from: 'mascot',
    note: 'trimmed to ink, fit 320x320' },
  { path: `docs/assets/${SLUG}-before-after.png`, from: 'mascot + engine',
    note: `${BEFORE_AFTER.width}x${BEFORE_AFTER.height} composite, ${BEFORE_AFTER.zoom}x` },
  { path: 'build/icon-1024.png', from: 'mascot', note: 'rounded-rect app icon' },
  { path: 'build/icon.png', from: 'build/icon-1024.png', note: '512px' },
  { path: 'build/icon.icns', from: 'build/icon-1024.png', note: 'iconutil' },
  { path: 'docs/assets/icon-512.png', from: 'build/icon-1024.png', note: '512px' },
  { path: 'src/renderer/favicon.png', from: 'build/icon-1024.png', note: `${FAVICON_SIZE}px` },
  { path: 'site/assets/*', from: 'the above', note: 'every asset site/*.html references' },
  { path: 'scripts/derived-assets.stamp.json', from: 'sources', note: 'the --check stamp' },
];

/** Numbers the prose claims, and which measurement each one is claiming. */
const CLAIMS = [
  ['README.md', 'source KB (image alt)', /(\d+) KB PNG at/, 'sourceKB'],
  ['README.md', 'zoom % (image alt)', /PNG at (\d+)% zoom/, 'zoomPct'],
  ['README.md', 'SVG KB (image alt)', /next to the (\d+) KB SVG/, 'svgKB'],
  ['README.md', 'source KB (prose)', /a (\d+) KB raster becomes/, 'sourceKB'],
  ['README.md', 'SVG KB (prose)', /becomes a \*\*(\d+) KB SVG/, 'svgKB'],
  ['README.md', 'colour layers', /KB SVG in (\d+) colour layers/, 'layers'],
  ['README.md', 'shapes', /colour layers and (\d+) shapes\*\*/, 'shapes'],
  ['site/index.html', 'SVG KB (readout)', /<b>(\d+) KB<\/b><span>SVG, from/, 'svgKB'],
  ['site/index.html', 'source KB (readout)', /<span>SVG, from (\d+) KB<\/span>/, 'sourceKB'],
  ['site/index.html', 'shapes (readout)', /<b>(\d+)<\/b><span>shapes,/, 'shapes'],
  ['site/index.html', 'colour layers (readout)', /<span>shapes, (\d+) layers<\/span>/, 'layers'],
  ['site/index.html', 'colours (readout)', /<b>(\d+)<\/b><span>colours, Smart AA/, 'colorCount'],
  ['site/index.html', 'SVG KB (demo alt)', /as a (\d+) KB SVG/, 'svgKB'],
  ['site/index.html', 'source KB (prose)', /(?:its|his|her) (\d+) KB raster becomes/, 'sourceKB'],
  ['site/index.html', 'SVG KB (prose)', /becomes a (\d+) KB SVG/, 'svgKB'],
  ['site/index.html', 'colour layers (prose)', /KB SVG in (\d+) colour layers/, 'layers'],
  ['site/index.html', 'shapes (prose)', /colour layers and (\d+) shapes/, 'shapes'],
];

/**
 * Numbers that are NOT ours and must never be "corrected": the reference product's own
 * output on the same source. They are the comparator the whole project is
 * graded against, and they only change when the real product is re-measured.
 */
const FOREIGN_CLAIMS = ['21.7 KB', '40 paths'];

const STAMP_PATH = 'scripts/derived-assets.stamp.json';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SELF = fileURLToPath(import.meta.url);

// ===========================================================================
// Mechanism
// ===========================================================================

const abs = (p) => join(ROOT, p);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Bounding box of everything the artwork actually draws. */
async function inkBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minx = info.width, maxx = -1, miny = info.height, maxy = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] <= 8) continue;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) throw new Error(`${file} is fully transparent`);
  return { left: minx, top: miny, width: maxx - minx + 1, height: maxy - miny + 1 };
}

const renderSvg = (svg, width) =>
  new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica' },
  })
    .render()
    .asPng();

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The trace the demo is: decoded exactly the way the app's canvas ingest does. */
async function traceMascot() {
  const enginePath = join(ROOT, 'dist', 'engine', 'index.js');
  if (!existsSync(enginePath)) {
    throw new Error('dist/engine is missing — run `npm run build:node` first.');
  }
  const { vectorize } = await import(enginePath);
  /**
   * canvasIngest, not the raw decode. The engine must be handed the same
   * pixels `src/renderer/lib/decode.ts` produces — including (0,0,0,0) for a
   * transparent pixel — or the asset is a picture of a code path no user has.
   * That is exactly how the committed trace ended up with a black backdrop.
   */
  const image = canvasIngest(await decodeImageFile(abs(MASCOT_SOURCE)));
  const result = await vectorize(image, DEMO_SETTINGS);
  const layers = (result.svg.match(/<g fill=/g) ?? []).length;
  const shapes = [...result.svg.matchAll(/ d="([^"]+)"/g)]
    .reduce((n, m) => n + (m[1].match(/[Mm]/g) ?? []).length, 0);
  return { ...result, layers, shapes };
}

/** The dark rounded square the mascot sits on, with the mascot on it. */
async function buildIcon(mascotFile) {
  const { size, background, cornerRadius, mascotScale, mascotOffsetY } = ICON;
  const plate = renderSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${cornerRadius}" ry="${cornerRadius}" fill="${background}"/></svg>`,
    size,
  );
  const box = await inkBox(mascotFile);
  const fit = Math.floor(size * mascotScale);
  const mascot = await sharp(mascotFile)
    .extract(box)
    .resize(fit, fit, { fit: 'inside' })
    .png()
    .toBuffer();
  const meta = await sharp(mascot).metadata();
  return sharp(plate)
    .composite([
      {
        input: mascot,
        left: Math.round((size - meta.width) / 2),
        top: Math.round((size - meta.height) / 2) + mascotOffsetY,
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** The side-by-side card: pixels on the left, curves on the right. */
async function buildBeforeAfter(svg, measured) {
  const B = BEFORE_AFTER;
  const panelW = B.crop.width * B.zoom;
  const panelH = B.crop.height * B.zoom;
  const rightX = B.pad + panelW + B.gap;
  if (B.pad * 2 + panelW * 2 + B.gap !== B.width) {
    throw new Error(`before/after geometry does not fill ${B.width}px — check crop/zoom/pad/gap`);
  }

  // Left: the source, magnified with nearest-neighbour. The point of the panel
  // is that the pixels are visible as pixels, so no smoothing anywhere.
  const raster = await sharp(abs(MASCOT_SOURCE))
    .extract({ left: B.crop.x, top: B.crop.y, width: B.crop.width, height: B.crop.height })
    .resize(panelW, panelH, { kernel: 'nearest' })
    .flatten({ background: B.background })
    .png()
    .toBuffer();

  // Right: the SVG rasterized AT the magnification, not magnified after — that
  // is the whole claim the picture is making.
  const vector = await sharp(renderSvg(svg, measured.width * B.zoom))
    .extract({
      left: B.crop.x * B.zoom,
      top: B.crop.y * B.zoom,
      width: panelW,
      height: panelH,
    })
    .flatten({ background: B.background })
    .png()
    .toBuffer();

  const label = (x, title, subtitle) =>
    `<text x="${x}" y="${B.title.baseline}" font-family="${B.font}" font-size="${B.title.size}"` +
    ` font-weight="${B.title.weight}" letter-spacing="${B.title.tracking}" fill="${B.title.fill}">${escapeXml(title)}</text>` +
    `<text x="${x}" y="${B.subtitle.baseline}" font-family="${B.font}" font-size="${B.subtitle.size}"` +
    ` fill="${B.subtitle.fill}">${escapeXml(subtitle)}</text>`;
  const zoomPct = `${measured.zoomPct}% zoom`;
  const header = renderSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${B.width}" height="${B.height}">` +
      `<rect width="${B.width}" height="${B.height}" fill="${B.background}"/>` +
      label(B.pad + 1, `BEFORE — ${measured.sourceKB} KB PNG`, `raster, ${zoomPct}`) +
      label(rightX + 1, `AFTER — ${measured.svgKB} KB SVG`,
        `vector, ${zoomPct} · ${measured.layers} colour layers, ${measured.shapes} shapes`) +
      '</svg>',
    B.width,
  );

  return sharp(header)
    .composite([
      { input: raster, left: B.pad, top: B.header },
      { input: vector, left: rightX, top: B.header },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Every `assets/…` file site/*.html actually asks for. */
async function siteAssetNames() {
  const names = new Set();
  for (const page of ['site/index.html', 'site/docs.html']) {
    const html = await fs.readFile(abs(page), 'utf8');
    for (const m of html.matchAll(/assets\/([A-Za-z0-9._-]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * The sources every derived asset is a function of. If these match the stamp,
 * the committed outputs were made from these inputs — which is the strongest
 * claim available for an artifact a PNG encoder touched.
 */
async function sourcesHash() {
  const engineDir = join(ROOT, 'src', 'engine');
  const engineFiles = (await fs.readdir(engineDir)).filter((f) => f.endsWith('.ts')).sort();
  const engine = createHash('sha256');
  for (const f of engineFiles) engine.update(f).update(await fs.readFile(join(engineDir, f)));
  return {
    mascot: sha(await fs.readFile(abs(MASCOT_SOURCE))),
    engine: engine.digest('hex'),
    script: sha(await fs.readFile(SELF)),
  };
}

async function sizeOf(path) {
  try {
    return (await fs.stat(abs(path))).size;
  } catch {
    return null;
  }
}

function driftTable(measured) {
  const rows = [];
  for (const [file, label, re, key] of CLAIMS) {
    const text = readFileSync(abs(file), 'utf8');
    const m = re.exec(text);
    const claimed = m ? m[1] : null;
    const actual = String(measured[key]);
    rows.push({
      file,
      label,
      claimed: claimed ?? '(not found)',
      measured: actual,
      drift: claimed === null ? 'MISSING' : claimed === actual ? 'ok' : 'DRIFT',
    });
  }
  return rows;
}

function printTable(rows, columns) {
  const widths = columns.map(([, get, head]) =>
    Math.max(head.length, ...rows.map((r) => String(get(r)).length)),
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log('  ' + line(columns.map(([, , head]) => head)));
  console.log('  ' + line(widths.map((w) => '─'.repeat(w))));
  for (const r of rows) console.log('  ' + line(columns.map(([, get]) => get(r))));
}

// ===========================================================================

async function main() {
  const check = process.argv.includes('--check');
  const trace = await traceMascot();
  const sourceBytes = (await fs.stat(abs(MASCOT_SOURCE))).size;
  const svgBytes = Buffer.byteLength(trace.svg);
  const measured = {
    sourceBytes,
    svgBytes,
    sourceKB: kb(sourceBytes),
    svgKB: kb(svgBytes),
    layers: trace.layers,
    shapes: trace.shapes,
    paths: trace.pathCount,
    colorCount: DEMO_SETTINGS.colorCount,
    zoomPct: BEFORE_AFTER.zoom * 100,
    width: trace.width,
    height: trace.height,
  };
  const sources = await sourcesHash();

  if (check) return runCheck(trace, measured, sources);

  console.log(`Regenerating derived assets from ${MASCOT_SOURCE}\n`);
  console.log('Manifest:\n');
  printTable(MANIFEST, [
    ['path', (r) => r.path, 'file'],
    ['from', (r) => r.from, 'derived from'],
    ['note', (r) => r.note, 'how'],
  ]);
  console.log('');

  const written = [];
  const write = async (path, data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const was = await sizeOf(path);
    await fs.mkdir(dirname(abs(path)), { recursive: true });
    await fs.writeFile(abs(path), buf);
    written.push({ path, was, now: buf.length });
  };

  // 1. The trace.
  await write(`docs/assets/${SLUG}-vector.svg`, trace.svg);

  // 2. The mascot, trimmed to its ink and fit to a 320 box.
  const mascotBox = await inkBox(abs(MASCOT_SOURCE));
  await write(
    `docs/assets/${SLUG}-mascot.png`,
    await sharp(abs(MASCOT_SOURCE))
      .extract(mascotBox)
      .resize(320, 320, { fit: 'inside' })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );

  // 3. The before/after composite.
  await write(`docs/assets/${SLUG}-before-after.png`, await buildBeforeAfter(trace.svg, measured));

  // 4. The icon family.
  const icon1024 = await buildIcon(abs(MASCOT_SOURCE));
  await write('build/icon-1024.png', icon1024);
  const icon512 = await sharp(icon1024).resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
  await write('build/icon.png', icon512);
  await write('docs/assets/icon-512.png', icon512);
  await write(
    'src/renderer/favicon.png',
    await sharp(icon1024).resize(FAVICON_SIZE, FAVICON_SIZE).png({ compressionLevel: 9 }).toBuffer(),
  );
  await writeIcns(icon1024, write);

  // 5. The site's copies — driven by what the pages actually reference, so a
  //    new <img> in site/ either gets a source here or fails loudly.
  for (const name of await siteAssetNames()) {
    await write(`site/assets/${name}`, await siteCopy(name, icon1024));
  }

  // 6. The stamp --check compares against.
  await write(
    STAMP_PATH,
    JSON.stringify(
      {
        _: 'Generated by scripts/regenerate-derived-assets.mjs. Do not edit — run `npm run assets`.',
        mascot: MASCOT_SOURCE,
        settings: DEMO_SETTINGS,
        sources,
        measured,
      },
      null,
      2,
    ) + '\n',
  );

  console.log('Wrote:\n');
  printTable(written, [
    ['path', (r) => r.path, 'file'],
    ['was', (r) => (r.was == null ? 'new' : r.was), 'was'],
    ['now', (r) => r.now, 'now'],
    ['d', (r) => (r.was == null ? '+' : r.now - r.was > 0 ? `+${r.now - r.was}` : String(r.now - r.was)), 'Δ bytes'],
  ]);

  console.log('\nMeasured:\n');
  console.log(
    `  ${measured.sourceKB} KB source -> ${measured.svgKB} KB SVG ` +
      `(${measured.svgBytes} B), ${measured.layers} colour layers, ` +
      `${measured.shapes} shapes across ${measured.paths} <path> elements`,
  );

  console.log('\nClaimed vs measured — prose is NOT auto-edited, fix any DRIFT by hand:\n');
  const rows = driftTable(measured);
  printTable(rows, [
    ['file', (r) => r.file, 'file'],
    ['label', (r) => r.label, 'claim'],
    ['claimed', (r) => r.claimed, 'claimed'],
    ['measured', (r) => r.measured, 'measured'],
    ['drift', (r) => r.drift, ''],
  ]);
  const drifted = rows.filter((r) => r.drift !== 'ok');
  console.log(
    drifted.length
      ? `\n  ${drifted.length} claim(s) need a human. Leave ${FOREIGN_CLAIMS.join(' / ')} alone — ` +
          'those are the reference product\'s numbers, not ours.'
      : '\n  Every claim matches.',
  );
}

/** iconutil wants a directory of exactly-named PNGs. Give it one. */
async function writeIcns(icon1024, write) {
  const dir = mkdtempSync(join(tmpdir(), 'getvect-iconset-'));
  const set = join(dir, 'GetVect.iconset');
  await fs.mkdir(set);
  for (const s of ICON.icnsSizes) {
    for (const [px, name] of [[s, `icon_${s}x${s}.png`], [s * 2, `icon_${s}x${s}@2x.png`]]) {
      await fs.writeFile(join(set, name), await sharp(icon1024).resize(px, px).png().toBuffer());
    }
  }
  const out = join(dir, 'icon.icns');
  try {
    execFileSync('iconutil', ['-c', 'icns', set, '-o', out]);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    if (process.platform !== 'darwin') {
      console.warn('  ! build/icon.icns skipped: iconutil is macOS-only.');
      return;
    }
    throw err;
  }
  await write('build/icon.icns', await fs.readFile(out));
  await fs.rm(dir, { recursive: true, force: true });
}

/** One site asset, from whichever upstream owns it. */
async function siteCopy(name, icon1024) {
  if (name === 'favicon.png') {
    return sharp(icon1024).resize(SITE_FAVICON_SIZE, SITE_FAVICON_SIZE).png(SITE_PNG).toBuffer();
  }
  // The raster half of the demo is the source image itself.
  const source = name === `${SLUG}-raster.png` ? abs(MASCOT_SOURCE) : abs(`docs/assets/${name}`);
  if (!existsSync(source)) {
    throw new Error(
      `site/*.html references assets/${name}, and nothing in this script produces it. ` +
        'Add it to docs/assets/ (or teach siteCopy where it comes from).',
    );
  }
  // SVG travels verbatim: it is already the smallest form of itself, and a
  // re-encode would break the byte-identity --check relies on.
  if (name.endsWith('.svg')) return fs.readFile(source);
  return sharp(source).png(SITE_PNG).toBuffer();
}

/** CI mode. Nothing is written; the exit code is the whole output. */
async function runCheck(trace, measured, sources) {
  const problems = [];

  for (const path of [`docs/assets/${SLUG}-vector.svg`, `site/assets/${SLUG}-vector.svg`]) {
    let committed;
    try {
      committed = await fs.readFile(abs(path), 'utf8');
    } catch {
      problems.push(`${path} is missing`);
      continue;
    }
    if (committed !== trace.svg) {
      problems.push(
        `${path} differs from what the engine produces now ` +
          `(committed ${Buffer.byteLength(committed)} B, engine ${measured.svgBytes} B)`,
      );
    }
  }

  let stamp = null;
  try {
    stamp = JSON.parse(await fs.readFile(abs(STAMP_PATH), 'utf8'));
  } catch {
    problems.push(`${STAMP_PATH} is missing or unreadable`);
  }
  if (stamp) {
    for (const key of ['mascot', 'engine', 'script']) {
      if (stamp.sources?.[key] !== sources[key]) {
        problems.push(
          `${key} has changed since the assets were generated ` +
            `(stamp ${String(stamp.sources?.[key]).slice(0, 12)}…, now ${sources[key].slice(0, 12)}…)`,
        );
      }
    }
    if (stamp.mascot !== MASCOT_SOURCE) {
      problems.push(`stamp was made from ${stamp.mascot}, config now says ${MASCOT_SOURCE}`);
    }
  }

  const rows = driftTable(measured);
  const drifted = rows.filter((r) => r.drift !== 'ok');

  if (problems.length) {
    console.error('\nDerived assets are stale — run `npm run assets`.\n');
    for (const p of problems) console.error(`  · ${p}`);
    console.error(
      '\nThese files are generated from ' +
        `${MASCOT_SOURCE} and src/engine/ by scripts/regenerate-derived-assets.mjs.\n` +
        'Regenerate them and commit the result; do not hand-edit them.\n',
    );
    if (drifted.length) {
      console.error('Prose claims that also need attention:\n');
      printTable(drifted, [
        ['file', (r) => r.file, 'file'],
        ['label', (r) => r.label, 'claim'],
        ['claimed', (r) => r.claimed, 'claimed'],
        ['measured', (r) => r.measured, 'measured'],
      ]);
      console.error('');
    }
    process.exitCode = 1;
    return;
  }

  console.log('Derived assets are up to date with the mascot, the engine and this script.');
  if (drifted.length) {
    // Prose drift is a warning, not a failure: a number in a sentence is a
    // human's call, and a red CI on it would just get muted.
    console.log('\nBut the copy disagrees with the measurements:\n');
    printTable(drifted, [
      ['file', (r) => r.file, 'file'],
      ['label', (r) => r.label, 'claim'],
      ['claimed', (r) => r.claimed, 'claimed'],
      ['measured', (r) => r.measured, 'measured'],
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
