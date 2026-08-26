/**
 * THE auto-UPDATE FLIP MUST STAY ON macOS.
 *
 * `extraMetadata.updateMode` is baked into the packaged package.json, so it
 * describes a BUILD rather than the source. macOS release builds now pass
 * `-c.extraMetadata.updateMode=auto` because the dmg and the update zip are
 * both signed with a Developer ID and stapled, which is what Squirrel.Mac needs
 * before it will install an update in place.
 *
 * Nothing else may inherit that. The Windows exe has no Authenticode
 * certificate; an `auto` Windows build would download ~100 MB and fail at the
 * install step, silently, on every launch. And `npm run dist` on a laptop
 * produces an unsigned bundle, which would fail the same way.
 *
 * The failure mode is why this is a test rather than the comment that is
 * already in the workflow: setting `updateMode: auto` in electron-builder.yml
 * would be a one-line change that looks like tidying the override away, breaks
 * nothing at build time, passes every existing gate, and only surfaces on
 * someone else's machine after a large download that reports success.
 *
 * The rule: `auto` may appear as a per-job override in the mac packaging step
 * and nowhere else. The default that a plain build inherits stays `notify`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('the default build mode is notify, so an unsigned build cannot self-update', () => {
  const yml = read('electron-builder.yml');
  const declared = /^\s*updateMode:\s*(\S+)/m.exec(yml);
  assert.ok(declared, 'electron-builder.yml no longer declares extraMetadata.updateMode');
  assert.equal(
    declared[1],
    'notify',
    'the repo-level default must stay `notify`: it is what `npm run dist` and every ' +
      'unsigned build inherit, and an unsigned app cannot install its own update',
  );
});

test('only the macOS packaging step opts into auto updates', () => {
  const wf = read('.github/workflows/release.yml');

  // Every line that actually sets the flag, ignoring the prose around it.
  const setters = wf
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /updateMode=/.test(line) && !line.startsWith('#'));

  assert.equal(
    setters.length,
    1,
    `expected exactly one updateMode override, found ${setters.length}: ` +
      setters.map((s) => `line ${s.n}`).join(', '),
  );
  assert.match(setters[0].line, /updateMode=auto/);

  // ...and it has to belong to the --mac invocation. The packaging steps are
  // multi-line continuations, so the check is which `npm run dist` the setter
  // falls under, not which line it sits on.
  const before = wf.slice(0, wf.indexOf(setters[0].line));
  const lastDist = before.lastIndexOf('npm run dist');
  assert.notEqual(lastDist, -1, 'the updateMode override is not inside a packaging step');
  const invocation = before.slice(lastDist);
  assert.ok(
    invocation.includes('--mac'),
    'updateMode=auto is attached to a non-macOS build — Squirrel would refuse the ' +
      'install on an unsigned artefact, after the download, on every launch',
  );
  assert.ok(
    !invocation.includes('--win'),
    'updateMode=auto reached the Windows build; the exe has no Authenticode certificate',
  );
});

test('the release gate verifies the zip the updater installs, not just the dmg', () => {
  const wf = read('.github/workflows/release.yml');
  // Auto updates install from latest-mac.yml's top-level `path`, which is the
  // zip. Turning `auto` on without gating that file would mean the one artefact
  // nobody checks is the one every user's app downloads unattended.
  assert.ok(
    wf.includes('verify-signed-zip.sh'),
    'updateMode=auto is set but nothing verifies the mac zip is signed and stapled',
  );
  const uses = wf.split('verify-signed-zip.sh').length - 1;
  assert.ok(
    uses >= 2,
    `verify-signed-zip.sh runs ${uses} time(s); it must run both before upload and ` +
      'against the asset re-downloaded from the published release',
  );
});
