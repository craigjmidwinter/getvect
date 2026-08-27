/**
 * THE GUARD MUST STILL GUARD, AND MUST NOT DISCLOSE.
 *
 * The forbidden-name list was moved from plain text to digests because the file
 * whose job is preventing a disclosure was the only file performing it. Two
 * things can go wrong with that change, and both are silent:
 *
 *   1. the matcher stops matching, and every entry publishes clean forever;
 *   2. somebody adds a plaintext name back, and the disclosure returns.
 *
 * A guard that silently stops guarding is worse than no guard, so both are
 * asserted here rather than assumed.
 *
 * NOTE ON WHAT THIS FILE DOES NOT CONTAIN. It never writes a real forbidden term,
 * because a test that proved the gate works by embedding one would undo the
 * change it is testing. Mechanism is proved with an injected sentinel; that the
 * PRODUCTION table is armed is proved against the repository's own corpus and
 * against this repository's own source, neither of which requires knowing a name.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FORBIDDEN, forbiddenIn, termDigest } from '../../scripts/forbidden-names.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A stand-in for a forbidden term. Harmless, and nothing here is a real one. */
const SENTINEL = 'zarquon';
const SENTINEL_LIST = [{ ...termDigest(SENTINEL), why: 'test sentinel' }];

test('a forbidden term trips the guard', () => {
  assert.deepEqual(forbiddenIn(`we benchmarked against ${SENTINEL} last week`, SENTINEL_LIST), [
    'test sentinel',
  ]);
});

test('clean text does not trip it', () => {
  assert.deepEqual(forbiddenIn('a perfectly ordinary sentence about tracing', SENTINEL_LIST), []);
});

test('substring semantics are preserved, which is why hashing tokens was wrong', () => {
  // Every one of these is a real disclosure and every one of them would have
  // survived a word-token or n-gram approach. This is the regression the
  // sliding window exists to prevent.
  for (const text of [
    `see https://${SENTINEL}.com/pricing for theirs`, // inside a URL
    `${SENTINEL}'s output was smoother`, // possessive
    `a ${SENTINEL}-style flatten`, // hyphenated compound
    `#${SENTINEL}`, // hashtag
    `we tried ${SENTINEL}ing the image`, // embedded in a longer word
    `THE ${SENTINEL.toUpperCase()} RESULT`, // case
  ]) {
    assert.deepEqual(forbiddenIn(text, SENTINEL_LIST), ['test sentinel'], `missed: ${text}`);
  }
});

test('accented spellings match in either unicode form', () => {
  const accented = 'café';
  const list = [{ ...termDigest(accented), why: 'accent sentinel' }];
  // Same grapheme, composed (U+00E9) and decomposed (e + U+0301). The old
  // includes() check saw these as different strings; both are normalised now.
  assert.deepEqual(forbiddenIn(`a ${accented.normalize('NFC')} here`, list), ['accent sentinel']);
  assert.deepEqual(forbiddenIn(`a ${accented.normalize('NFD')} here`, list), ['accent sentinel']);
});

test('one reason per term however many times it appears', () => {
  const text = `${SENTINEL} and ${SENTINEL} and ${SENTINEL} again`;
  assert.deepEqual(forbiddenIn(text, SENTINEL_LIST), ['test sentinel']);
});

test('the production table is well formed and non-empty', () => {
  assert.ok(FORBIDDEN.length >= 5, `only ${FORBIDDEN.length} terms — did the table get emptied?`);
  for (const entry of FORBIDDEN) {
    assert.match(entry.h, /^[0-9a-f]{64}$/, 'every term must be a sha256 hex digest');
    assert.ok(Number.isInteger(entry.len) && entry.len >= 3, 'a term length looks wrong');
    assert.ok(entry.why && entry.why.length > 8, 'every term needs a reason a human can act on');
  }
});

test('THE PRODUCTION TABLE IS ARMED: it still trips on this repository', () => {
  // The corpus contains entries that are held back precisely because they name
  // somebody; that is why they have never been published. If the real table
  // stopped matching, this goes quiet and every one of them would publish.
  const dir = join(root, 'katra', 'entries');
  const corpus = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');

  assert.ok(
    forbiddenIn(corpus).length > 0,
    'the production table matched nothing in the whole devlog corpus. Either the ' +
      'table is broken, or the corpus was genuinely cleaned — if it was cleaned, ' +
      'replace this with a fixture rather than deleting the assertion, because ' +
      'this is the only check that the real digests still match real text.',
  );
});

test('the guard does not disclose the thing it guards', () => {
  // The defect that prompted all of this: the blocklist named the names, in a
  // public repo. This re-checks the guard against itself, so a plaintext term
  // added back to either file fails the suite instead of shipping.
  for (const rel of ['scripts/forbidden-names.mjs', 'scripts/devlog-gate.mjs']) {
    const src = readFileSync(join(root, rel), 'utf8');
    assert.deepEqual(
      forbiddenIn(src),
      [],
      `${rel} contains a forbidden term in plain text — that is the exact defect ` +
        'this change removed. Store it as a digest instead.',
    );
  }
});
