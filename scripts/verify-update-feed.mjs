/**
 * Prove that the SHIPPED updater can resolve, download and accept the real
 * published release — using electron-updater's own provider, not a re-implementation.
 *
 *   node scripts/verify-update-feed.mjs [owner/repo]
 *
 * WHY A RE-IMPLEMENTATION WOULD BE WORTHLESS HERE.
 *
 * The question is not "does a zip exist at a URL". It is "does the code that
 * runs on a user's machine agree that this release is installable". Writing our
 * own YAML parse and sha512 compare answers the first question and quietly
 * assumes the second — and the assumption is the whole risk, because every
 * defect this pipeline has produced was a place where our description of an
 * artefact and the artefact disagreed. So this imports `GitHubProvider` from
 * electron-updater and asks IT what it would fetch.
 *
 * WHAT THIS CAN AND CANNOT PROVE.
 *
 * It proves the resolution and integrity half end to end against the real
 * release: the provider finds the newest version, names the file it would
 * download, that file downloads from the public URL, and its bytes hash to the
 * digest the feed advertises — which is exactly the check electron-updater
 * performs before it will hand anything to Squirrel.
 *
 * It CANNOT prove the install half. Squirrel.Mac validates the new bundle's
 * signature against the *running* app's designated requirement and swaps the
 * bundle on quit; that needs a signed app actually running, which is a released
 * build on a real machine. What is checked instead is the precondition that
 * makes the swap possible — the app inside the downloaded zip is signed by the
 * expected Team ID and satisfies its own designated requirement. If that holds
 * and the digest holds, the remaining unknown is Squirrel itself, not our
 * artefacts.
 *
 * Read the exit line carefully: it says which half was proven.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');

const SLUG = process.argv[2] || 'craigjmidwinter/getvect';
const [owner, repo] = SLUG.split('/');
const EXPECT_TEAM = '6UV93L24YL';

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
};

/**
 * `GitHubProvider(options, updater, runtimeOptions)`. Only the members below are
 * touched on the resolution path; anything else throwing is a signal that
 * electron-updater changed and this harness is no longer exercising what the
 * app exercises — which is a result worth having, not a nuisance.
 *
 * `currentVersion` is deliberately ancient so the provider always considers the
 * published release newer. This asks "can it resolve and validate the release",
 * not "is this machine out of date".
 */
const executor = {
  request: async (options) => {
    const url = `https://${options.hostname}${options.path}`;
    // The provider asks for different content types on different hops — the
    // releases atom feed as XML, then `/releases/latest` with
    // `Accept: application/json`, which is the only thing that makes github.com
    // answer with JSON rather than a web page. Honouring the headers it passes
    // is the difference between exercising its logic and exercising ours.
    const res = await fetch(url, { headers: options.headers ?? {}, redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  },
};

console.log(`resolving updates for ${SLUG} the way the shipped app does\n`);

const provider = new GitHubProvider(
  { provider: 'github', owner, repo },
  { currentVersion: '0.0.1', channel: null, allowPrerelease: false, fullChangelog: false },
  { executor, isUseMultipleRangeRequest: false, platform: process.platform },
);

let info;
try {
  info = await provider.getLatestVersion();
} catch (e) {
  fail(`electron-updater could not resolve a release at all: ${e.message}`);
  process.exit(1);
}
console.log(`  provider says newest version: ${info.version}`);

// What it would actually download on macOS.
const files = provider.resolveFiles(info);
if (!files.length) {
  fail('the provider resolved no downloadable file — an update would 404 on every launch');
  process.exit(1);
}
const target = files[0];
const url = target.url.href;
const expected = target.info?.sha512;
const declaredSize = target.info?.size;
console.log(`  it would download: ${url.split('/').pop()}`);
console.log(`  from:              ${url}`);
console.log(`  expecting sha512:  ${(expected || '(none)').slice(0, 24)}…`);

if (!expected) {
  fail('the feed advertises no sha512 for that file — integrity would be unverifiable');
  process.exit(1);
}
if (!/\.zip$/.test(url)) {
  fail(`macOS updates install from a zip; the provider chose ${url.split('/').pop()}`);
}

// Fetch it as a stranger would, cache-busted, and hash what actually arrives.
const dir = await mkdtemp(join(tmpdir(), 'getvect-update-'));
const name = decodeURIComponent(url.split('/').pop());
const file = join(dir, name);
console.log('\ndownloading it, cache-busted');
const res = await fetch(`${url}?cb=${process.pid}${Date.now?.() ?? ''}`, {
  headers: { 'cache-control': 'no-cache' },
});
if (!res.ok) {
  fail(`the file the updater would fetch returned ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(file, buf);
const actual = createHash('sha512').update(buf).digest('base64');
console.log(`  bytes:   ${buf.length}${declaredSize ? ` (feed says ${declaredSize})` : ''}`);
console.log(`  sha512:  ${actual.slice(0, 24)}…`);

if (declaredSize != null && Number(declaredSize) !== buf.length) {
  fail(`size mismatch: feed says ${declaredSize}, the file is ${buf.length}`);
}
if (actual !== expected) {
  fail('DIGEST MISMATCH — electron-updater would reject this update and never install it');
  console.error(`::error::feed ${expected}`);
  console.error(`::error::file ${actual}`);
  process.exit(1);
}
console.log('  DIGEST MATCH — the updater would accept these bytes\n');

// The precondition for the half this cannot run: Squirrel validates the new
// bundle against the running app's designated requirement.
if (process.platform !== 'darwin') {
  console.log('not on macOS — skipping the signature precondition (integrity half proven)');
  process.exit(process.exitCode ?? 0);
}

console.log('checking the bundle Squirrel would be handed');
const out = join(dir, 'x');
execFileSync('ditto', ['-x', '-k', file, out]);
const entries = await readdir(out);
const appName = entries.find((e) => e.endsWith('.app'));
if (!appName) {
  fail('no .app inside the downloaded zip — the install step would have nothing to swap in');
  process.exit(1);
}
const app = join(out, appName);

const check = (label, cmd, args) => {
  try {
    const r = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`  PASS  ${label}`);
    return r;
  } catch (e) {
    fail(`${label} FAILED — Squirrel would refuse this update after the download`);
    console.error(((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(0, 3).join('\n'));
    return null;
  }
};

check('codesign --verify --deep --strict', 'codesign', [
  '--verify', '--deep', '--strict', app,
]);
check('satisfies its designated requirement', 'codesign', ['--verify', '-R=anchor apple generic', app]);
check('spctl -a -t exec', 'spctl', ['-a', '-t', 'exec', app]);
check('stapler validate', 'xcrun', ['stapler', 'validate', app]);

// `codesign -dvvv` prints its report on STDERR, not stdout. Reading stdout gets
// an empty string, which parses to no team, which fails this check on a bundle
// that is perfectly signed — a false alarm rather than a false pass, but a gate
// that cries wolf gets ignored, so it is worth getting right.
let team = null;
try {
  const d = execFileSync('codesign', ['-dvvv', app], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  team = /TeamIdentifier=(\S+)/.exec(d)?.[1] ?? null;
} catch {
  /* handled below: an unreadable signature is reported by the checks above */
}
if (!team) {
  const d = execFileSync(
    'bash',
    ['-c', `codesign -dvvv "$1" 2>&1`, '_', app],
    { encoding: 'utf8' },
  );
  team = /TeamIdentifier=(\S+)/.exec(d)?.[1] ?? null;
}
if (team !== EXPECT_TEAM) {
  fail(`the update is signed by Team ${team ?? '(none)'}, not ${EXPECT_TEAM} — a bundle signed by a different team is exactly what Squirrel refuses`);
} else {
  console.log(`  PASS  TeamIdentifier=${team}`);
}

console.log(
  process.exitCode
    ? '\nFAILED'
    : '\nPROVEN: resolution and integrity, end to end against the published release,\n' +
        'and the downloaded bundle is signed and stapled by the expected team.\n' +
        'NOT PROVEN: the in-place swap itself, which needs a signed build running.',
);
