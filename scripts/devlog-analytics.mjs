/**
 * Put the things the devlog's renderer cannot into a built devlog: the analytics
 * tag, its disclosure, and the social card metadata.
 *
 * WHY THIS IS A SCRIPT AND NOT AN EDIT TO site/devlog/.
 *
 * `site/devlog/` is a checked-in snapshot of `katra build` output — index.html,
 * app.js and styles.css are all rendered, not authored here. A tag hand-added to
 * that snapshot works until the next publish overwrites it, and then it is gone
 * with nothing to notice: the pages still load, the charts just stop growing.
 * That is the same failure as pointing a tag at a host that cannot be reached,
 * arriving later and quieter. So the injection is a committed step that runs on
 * every build, per the derived-asset invariant in AGENTS.md.
 *
 * katra has no head-injection or analytics option of its own (checked against
 * `katra build --help` and the config schema). If it grows one, delete this and
 * use it — a post-processing step over someone else's output is a workaround,
 * and it should not outlive the gap it covers.
 *
 *   node scripts/devlog-analytics.mjs [site-dir]   default: artifacts/devlog/site
 *
 * Idempotent: running it twice is the same as running it once.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The collector. Self-hosted, cookieless — see docs/ANALYTICS or the site footer. */
const SRC = 'https://umami.midwinter.dev/script.js';
const WEBSITE_ID = 'b003dfbc-7aa2-438c-8c23-3c218bfde0ef';

const TAG = `<script defer src="${SRC}" data-website-id="${WEBSITE_ID}"></script>`;

/**
 * The disclosure. The devlog viewer is a 100vh app shell with no footer, and
 * both of its regions are re-rendered from data.json, so anything appended to
 * the body sits below the fold and anything placed inside them is wiped on the
 * first route change. A fixed note over the side column is the one position
 * that is present on every view and survives re-render.
 */
const NOTE = [
  '<style>.gv-analytics-note{position:fixed;left:0;bottom:0;width:var(--side-w,240px);',
  'box-sizing:border-box;padding:8px 14px 10px;font-size:10.5px;line-height:1.5;',
  'color:var(--ink-soft,#8a8a84);pointer-events:none;z-index:5}</style>',
  '<div class="gv-analytics-note">Self-hosted, cookieless analytics. ',
  'No personal data, no third party.</div>',
].join('');

const MARKER = 'gv-analytics-note';

/**
 * THE SOCIAL CARD. katra renders this page with `<title>Katra</title>` and no og
 * tags — app.js sets the real title client-side from data.json, which is too late
 * for a link preview, since no scraper runs it. Shared devlog links therefore
 * previewed as "Katra", grey box, no description — on the page katra's own
 * attribution footer drives readers to.
 *
 * og:title is what every major platform actually renders, so adding these fixes
 * the preview without rewriting the generated <title>.
 *
 * Deliberately no og:image:width/height here. index.html and docs.html declare
 * them and pay for it with a gated claim in regenerate-derived-assets.mjs; this
 * file is injected and outside that gate, so declaring the numbers here would be
 * an ungated copy of a value that can change. The dimensions are an optimisation,
 * not a requirement.
 */
const SITE = 'https://getvect.midwinter.io';
const CARD = [
  '<meta property="og:type" content="website">',
  '<meta property="og:title" content="GetVect devlog">',
  '<meta property="og:description" content="The committed build log: what was measured, what was decided, and the failures behind both.">',
  `<meta property="og:url" content="${SITE}/devlog/">`,
  `<meta property="og:image" content="${SITE}/assets/frankie-before-after.png">`,
  '<meta property="og:image:alt" content="The mascot\'s face at 200% zoom: source pixels on the left, traced curves on the right.">',
  '<meta name="twitter:card" content="summary_large_image">',
  `<meta name="twitter:image" content="${SITE}/assets/frankie-before-after.png">`,
].join('\n');

async function inject(siteDir) {
  const index = join(siteDir, 'index.html');

  let html;
  try {
    html = await fs.readFile(index, 'utf8');
  } catch {
    console.error(`devlog-analytics: no index.html at ${index}`);
    console.error('Build the devlog first: npm run devlog:build');
    process.exit(1);
  }

  // Independent insertions, each guarded, so a partially-injected file (someone
  // added the tag by hand) converges instead of doubling up.
  let out = html;
  let changed = [];

  if (!out.includes('og:title')) {
    if (!out.includes('</head>')) {
      console.error('devlog-analytics: no </head> in the built index.html');
      process.exit(1);
    }
    out = out.replace('</head>', `${CARD}\n</head>`);
    changed.push('social card');
  }

  if (!out.includes(WEBSITE_ID)) {
    if (!out.includes('</head>')) {
      console.error('devlog-analytics: no </head> in the built index.html');
      process.exit(1);
    }
    out = out.replace('</head>', `${TAG}\n</head>`);
    changed.push('tag');
  }

  if (!out.includes(MARKER)) {
    if (!out.includes('</body>')) {
      console.error('devlog-analytics: no </body> in the built index.html');
      process.exit(1);
    }
    out = out.replace('</body>', `${NOTE}\n</body>`);
    changed.push('disclosure');
  }

  if (!changed.length) {
    console.log(`devlog-analytics: already present in ${index}`);
    return;
  }

  await fs.writeFile(index, out);
  console.log(`devlog-analytics: added ${changed.join(' + ')} → ${index}`);
}

const target = process.argv[2] ?? join(ROOT, 'artifacts', 'devlog', 'site');
await inject(target);
