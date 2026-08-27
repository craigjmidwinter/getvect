#!/usr/bin/env node
/**
 * Every published HTML surface either carries the analytics tag or is listed
 * here as a deliberate exemption with a reason.
 *
 * WHY THIS EXISTS. The tag was routed to three pages, and when a fourth surface
 * appeared — `/app/`, the browser build — nothing re-enumerated. The result was
 * a launch day on which the number that surface exists to produce, how many
 * people TRIED it rather than read about it, was unmeasured, and nobody found
 * out from the code: the deploy was green and the page worked.
 *
 * A per-page decision that nothing re-checks is a decision that silently stops
 * being true when a page is added. So this enumerates what is actually in
 * `site/` and fails on anything it has never been told about — the point is not
 * to force a tag onto every page, it is to make a fifth surface impossible to
 * add SILENTLY.
 *
 *   node scripts/check-analytics-coverage.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const TAG = 'umami.midwinter.dev/script.js';

/**
 * Surfaces that deliberately carry NO tag, and why. An entry here is a claim
 * someone has to justify, which is the opposite of an oversight.
 */
/**
 * Whole families that are not visited surfaces. Kept separate from the
 * file-by-file list because the reason is structural rather than per-page.
 */
const EXEMPT_PATTERNS = [
  {
    match: /^devlog\/media\/.*\.html$/,
    why:
      'Chart fragments embedded via <iframe> inside devlog entries, not pages anyone ' +
      'navigates to. Tagging them would double-count every entry view and attribute ' +
      'it to a filename no reader has seen. The entry that embeds them is tagged.',
  },
];

const EXEMPT = new Map([
  [
    'app/index.html',
    'The browser build cannot be instrumented without breaking the guarantee it ' +
      'is built on. Its CSP is `script-src \'self\' blob:` and `connect-src \'none\'`, ' +
      'so an external analytics script is refused by the browser and so is any ' +
      'beacon — self-hosting the script would still need connect-src opened, which ' +
      'is the exact sentence the page invites readers to falsify. The entry click ' +
      'is counted from site/index.html instead (data-umami-event="open-web-app"), ' +
      'which measures visits referred from the site but NOT direct or README ' +
      'arrivals. That undercount is a known, accepted limit — see docs/ANALYTICS.md.',
  ],
]);

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

if (!existsSync(SITE)) {
  console.error('::error::no site/ directory');
  process.exit(1);
}

const files = (await htmlFiles(SITE)).map((f) => relative(SITE, f)).sort();
if (files.length === 0) {
  console.error('::error::no HTML found under site/ — this check would pass vacuously');
  process.exit(1);
}

const problems = [];
const tagged = [];
const exempt = [];

for (const rel of files) {
  const html = readFileSync(join(SITE, rel), 'utf8');
  const hasTag = html.includes(TAG);
  const reason = EXEMPT.get(rel) ?? EXEMPT_PATTERNS.find((p) => p.match.test(rel))?.why;

  if (hasTag && reason) {
    problems.push(`${rel} is listed as exempt but DOES carry the tag — remove the exemption`);
  } else if (hasTag) {
    tagged.push(rel);
  } else if (reason) {
    exempt.push(rel);
  } else {
    problems.push(
      `${rel} carries no analytics tag and is not a declared exemption. Either add the ` +
        'tag, or add it to EXEMPT in this script with the reason — a surface that is ' +
        'silently unmeasured is how /app/ launched uncounted.',
    );
  }
}

console.log(`  tagged (${tagged.length}): ${tagged.join(', ')}`);
console.log(`  exempt (${exempt.length}): ${exempt.join(', ') || 'none'}`);

if (problems.length) {
  console.error('\nAnalytics coverage is undeclared:\n');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log('  every published surface is either measured or exempt on purpose');
