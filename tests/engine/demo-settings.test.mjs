/**
 * THE DEMO IS THE APP'S DEFAULTS, AND MUST STAY DERIVED FROM THEM.
 *
 * The site and the README say the before/after is what you get out of the box
 * with nothing touched, and that sentence gets repeated in public. It was true
 * by coincidence: `DEMO_SETTINGS` was a literal that happened to equal
 * `DEFAULT_SETTINGS`, tied to it by nothing.
 *
 * The failure that would have followed is quiet in every direction. Change the
 * app's default palette to 12 and the script keeps emitting 8, the site keeps
 * saying 8, no test fails, and the picture still looks like a good trace of the
 * right cat — because it is one, at settings no user has. A stranger reading the
 * claim would be reading something false, on the surface they judge the product
 * by.
 *
 * WHY THE EXISTING DRIFT TABLE DOES NOT COVER THIS. It compares published copy
 * against THIS SCRIPT's measurements. Both would move together, or rather
 * neither would: the script would not have noticed the engine changed. The gap
 * is a claim about what the app does, made by a script that never asked the app.
 *
 * So this asserts the coupling itself rather than the values. Values are checked
 * by `npm run assets -- --check`, which now goes red when the engine default
 * moves — verified by moving it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = readFileSync(join(root, 'scripts', 'regenerate-derived-assets.mjs'), 'utf8');

/** The `const DEMO_SETTINGS = { … };` body, comments stripped. */
function demoSettingsBody() {
  const start = script.indexOf('const DEMO_SETTINGS = {');
  assert.notEqual(start, -1, 'DEMO_SETTINGS is gone — re-point this guard');
  const end = script.indexOf('};', start);
  assert.notEqual(end, -1, 'could not find the end of DEMO_SETTINGS');
  return script
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the demo settings are read from the engine, not restated', () => {
  const body = demoSettingsBody();

  // Every setting must come from DEFAULT_SETTINGS or from the declared
  // departures list. A bare number or string is the old bug returning.
  const literals = body.match(/:\s*(\d+|'[^']*'|"[^"]*")/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `DEMO_SETTINGS contains hardcoded value(s) ${literals.join(', ')} — the demo would ` +
      'no longer follow the app, and the "nothing touched" claim would drift silently',
  );
  assert.match(
    body,
    /DEFAULT_SETTINGS\./,
    'DEMO_SETTINGS no longer reads DEFAULT_SETTINGS at all',
  );
});

test('a deliberate departure has to be declared, with a reason', () => {
  // The ambiguity this removes: a reader could not tell which demo settings were
  // the app's defaults and which were chosen. Anything chosen now sits in
  // DEMO_DEPARTURES beside the reason it was chosen.
  assert.match(
    script,
    /const DEMO_DEPARTURES = \{/,
    'the departures list is gone; a chosen setting would be indistinguishable from a default',
  );
  const start = script.indexOf('const DEMO_DEPARTURES = {');
  const body = script.slice(start, script.indexOf('};', start));
  const entries = body.replace(/^\s*\/\/.*$/gm, '').match(/\w+\s*:/g) ?? [];
  for (const entry of entries) {
    assert.match(
      body,
      new RegExp(`${entry.replace(':', '')}\\s*:\\s*\\[[^\\]]+,`),
      `${entry} is a departure with no stated reason — it must be [value, 'why']`,
    );
  }
});

test('the engine still exposes the defaults the script reads', async () => {
  // If DEFAULT_SETTINGS loses a key the script names, the demo would trace with
  // `undefined` for it and resolveSettings would quietly substitute — which is
  // the same silent substitution this whole guard exists to prevent.
  const engine = await import(
    join(root, 'dist', 'engine', 'index.js').replace(/^/, 'file://')
  );
  for (const key of ['colorCount', 'antiAliasing', 'minArea']) {
    assert.notEqual(
      engine.DEFAULT_SETTINGS[key],
      undefined,
      `DEFAULT_SETTINGS.${key} is gone, and regenerate-derived-assets.mjs reads it`,
    );
  }
});
