/**
 * Sign, notarize and staple the .dmg — then re-index the update feed.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * electron-builder notarizes and staples the .app, then wraps it in a disk image
 * it does not sign. `dmg.sign` defaults to false and its own option docs warn
 * that turning it on "will lead to unwanted errors in combination with
 * notarization requirements"; there is no stapler reference anywhere in the
 * package. So the artefact a user actually downloads carries no signature and no
 * ticket, while every build log says notarization succeeded. v0.1.2 failed the
 * release gate for exactly this, which is the gate doing its job.
 *
 * WHY THE ORDER IS THE WHOLE PROBLEM.
 *
 * Stapling writes the ticket into the file, so it CHANGES THE DMG'S BYTES. The
 * sha512 electron-builder already recorded in latest-mac.yml was computed before
 * that, and latest-mac.yml is what the shipped app's updater trusts. Publishing a
 * stapled dmg beside a pre-staple digest would leave a feed that quietly
 * disagrees with the file it points at.
 *
 * So the digest is computed LAST, here, after the ticket is attached:
 *
 *     package (--publish never)  ->  sign dmg  ->  notarize  ->  staple
 *       ->  re-hash  ->  rewrite latest-mac.yml  ->  upload
 *
 * The zip is untouched: electron-builder staples the .app before building any
 * target, so the zip already contains a stapled app and its digest is still true.
 * The top-level `path`/`sha512` in the feed point at the zip, which is what
 * electron-updater downloads on macOS; only the dmg's entry in `files` moves.
 *
 *   node scripts/notarize-dmg.mjs <release-dir>
 *
 * Requires: SIGN_IDENTITY, APPLE_API_KEY (a path), APPLE_API_KEY_ID, APPLE_API_ISSUER.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'release';
const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`::error::${k} is not set`); process.exit(1); }
  return v;
};
const IDENTITY = need('SIGN_IDENTITY');
const KEY = need('APPLE_API_KEY');
const KEY_ID = need('APPLE_API_KEY_ID');
const ISSUER = need('APPLE_API_ISSUER');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const entries = await fs.readdir(dir);
const dmgs = entries.filter((f) => f.endsWith('.dmg'));
if (!dmgs.length) { console.error('::error::no .dmg in ' + dir); process.exit(1); }

for (const name of dmgs) {
  const dmg = path.join(dir, name);
  console.log(`\n=== ${name} ===`);

  // 1. Sign the container. Doing this ourselves, after electron-builder is done,
  //    is what its own warning is about avoiding *during* its notarize step.
  console.log('signing the disk image');
  run('codesign', ['--force', '--sign', IDENTITY, '--timestamp', '--options', 'runtime', dmg],
      { stdio: ['ignore', 'inherit', 'inherit'] });

  // 2. Notarize. --wait blocks until Apple returns a verdict.
  console.log('submitting to notarytool (this waits on Apple)');
  let submission;
  try {
    const out = run('xcrun', ['notarytool', 'submit', dmg, '--key', KEY, '--key-id', KEY_ID,
      '--issuer', ISSUER, '--wait', '--output-format', 'json']);
    submission = JSON.parse(out);
  } catch (e) {
    console.error('::error::notarytool submit failed');
    console.error((e.stdout || '') + (e.stderr || ''));
    process.exit(1);
  }
  console.log(`  id ${submission.id}  status ${submission.status}`);

  // A submission can be ACCEPTED as a transaction and still come back Invalid,
  // so the status is read from the JSON rather than from the exit code — and the
  // log is fetched either way, because the issues array is where hardened-runtime
  // and entitlement problems actually surface.
  let log = null;
  try {
    log = JSON.parse(run('xcrun', ['notarytool', 'log', submission.id, '--key', KEY,
      '--key-id', KEY_ID, '--issuer', ISSUER]));
  } catch { /* the log is not always ready immediately; the status still governs */ }

  if (log) {
    const issues = log.issues || [];
    console.log(`  log status: ${log.status}   issues: ${issues.length}`);
    for (const i of issues.slice(0, 25)) {
      console.log(`   [${i.severity}] ${i.path || ''}: ${i.message}`);
    }
  }

  if (submission.status !== 'Accepted') {
    console.error(`::error::notarization returned ${submission.status} for ${name}`);
    if (log?.issues?.length) {
      console.error('::error::first issue: ' + log.issues[0].message);
    }
    process.exit(1);
  }

  // 3. Staple. This rewrites the file.
  console.log('stapling the ticket');
  run('xcrun', ['stapler', 'staple', dmg], { stdio: ['ignore', 'inherit', 'inherit'] });
  run('xcrun', ['stapler', 'validate', dmg], { stdio: ['ignore', 'inherit', 'inherit'] });

  // 4. Re-index. Everything above changed the bytes; the feed must agree.
  const buf = await fs.readFile(dmg);
  const sha512 = createHash('sha512').update(buf).digest('base64');
  const size = buf.length;
  console.log(`  post-staple: ${size} bytes  sha512 ${sha512.slice(0, 24)}…`);

  const ymlPath = path.join(dir, 'latest-mac.yml');
  let yml;
  try { yml = await fs.readFile(ymlPath, 'utf8'); }
  catch { console.error('::error::no latest-mac.yml to re-index'); process.exit(1); }

  const before = yml;
  // Rewrite only the block whose url is this dmg. A line-scoped rewrite rather
  // than a YAML round-trip, so nothing else in the feed can move by accident.
  const lines = yml.split('\n');
  let inBlock = false, patchedHash = false, patchedSize = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s+url:\s*/.test(lines[i])) inBlock = lines[i].includes(name);
    if (!inBlock) continue;
    if (/^\s*sha512:\s*/.test(lines[i]) && !patchedHash) {
      lines[i] = lines[i].replace(/sha512:\s*.*/, `sha512: ${sha512}`); patchedHash = true;
    } else if (/^\s*size:\s*/.test(lines[i]) && !patchedSize) {
      lines[i] = lines[i].replace(/size:\s*.*/, `size: ${size}`); patchedSize = true;
    }
  }
  if (!patchedHash || !patchedSize) {
    console.error(`::error::could not find the ${name} entry in latest-mac.yml to re-index`);
    process.exit(1);
  }
  yml = lines.join('\n');
  if (yml === before) { console.error('::error::latest-mac.yml unchanged after re-index'); process.exit(1); }
  await fs.writeFile(ymlPath, yml);
  console.log('  latest-mac.yml re-indexed against the stapled file');

  // A stale blockmap is the same defect one file over: it describes bytes that
  // no longer exist. Nothing references it in the feed, so it is removed rather
  // than shipped wrong.
  const bm = dmg + '.blockmap';
  try { await fs.unlink(bm); console.log('  removed the pre-staple blockmap'); } catch {}
}

console.log('\ndmg signed, notarized, stapled, and the feed re-indexed after the fact');
