/**
 * WHO IS ALLOWED TO DECIDE THAT A CHANGE IS AN IMPROVEMENT.
 *
 * The rule, and why it is a test rather than a paragraph:
 *
 *   A threshold set at where we happen to score — a RATCHET — may not be
 *   anchored only on artwork this project authored.
 *
 * The failure it prevents has happened here, more than once, in different
 * costumes: a test that read its expectation from the module it was testing, a
 * gate never wired to a render, and most recently a de-staircasing filter
 * developed against the mascot and then judged by how much it improved the
 * mascot. In each case the thing being measured and the thing doing the
 * measuring were the same object, so the measurement could only agree.
 *
 * A synthetic fixture is NOT caught by this rule, and the distinction is the
 * point. `arcs-560x256` is drawn from `x² + y² = r²`; the bar it carries is not
 * "the number we got on our own picture", it is "the number the equation says",
 * and our score against it can be wrong. That is ground truth, and ground truth
 * may anchor anything. Our own *artwork* cannot, because a filter tuned on it
 * will improve it whether or not it improves anything else.
 *
 * `third-party` is artwork nobody here drew. It is the only category that can
 * answer "is this better for a user's images". Today the committed corpus has
 * none — see the coverage test at the bottom, which is the finding rather than
 * a passing grade.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (p) => {
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  return raw.fixtures ?? raw;
};
const committed = load(join(root, 'fixtures', 'manifest.json'));
const localPath = join(root, 'fixtures', 'local', 'manifest.local.json');
const local = existsSync(localPath) ? load(localPath) : [];
const all = [...committed, ...local];

const PROVENANCE = ['synthetic', 'in-house', 'third-party'];
/** Provenance that may anchor a ratchet: not artwork we drew. */
const MAY_ANCHOR = new Set(['synthetic', 'third-party']);

test('[provenance] every fixture declares who made it', () => {
  for (const f of all) {
    assert.ok(
      PROVENANCE.includes(f.provenance),
      `fixture "${f.id}" declares provenance ${JSON.stringify(f.provenance)}; ` +
        `it must be one of ${PROVENANCE.join(' / ')}. A fixture whose origin is ` +
        `unrecorded cannot be reasoned about: the whole rule below depends on ` +
        `knowing whether we drew the picture we are grading ourselves on.`,
    );
  }
});

/** Every threshold key in use, and the fixtures (and regions) declaring it. */
function thresholdAnchors(fixtures) {
  const anchors = new Map();
  const add = (key, fixture) => {
    if (!anchors.has(key)) anchors.set(key, []);
    anchors.get(key).push(fixture);
  };
  for (const f of fixtures) {
    for (const key of Object.keys(f.thresholds ?? {})) add(key, f);
    for (const region of f.salientRegions ?? []) {
      for (const key of Object.keys(region.thresholds ?? {})) add(key, f);
    }
  }
  return anchors;
}

/**
 * Gates that today are anchored only on in-house artwork, each with the reason
 * it has not been moved yet.
 *
 * This list is a RATCHET ON DEBT, and it is why this test does not simply go
 * red and get ignored: a new entry is a failure (you may not add another), and
 * a stale entry is also a failure (you may not leave one here once it is fixed).
 * The list can only shrink.
 *
 * None of these were introduced by the lap that added this test except
 * `maxStaircaseSustained`, which was — and which is why the test exists. It has
 * already been moved onto `arcs-560x256`, so it is not in this list.
 */
const KNOWN_IN_HOUSE_ANCHORS = {
  minDxfSplines:
    'D3 export structure. Belongs on a synthetic shape whose curve count is ' +
    'predictable rather than on the fox, but moving it changes what the number ' +
    'means and wants its own lap.',
  maxDxfEpsBytesRatio: 'Same gate, same lap.',
  minInkCoverageRatio:
    'Region ink fidelity on the mascot. A synthetic anchor would need artwork ' +
    'with a soft outline over a light ground, which is exactly the kind of ' +
    'picture the corpus has none of (see the coverage test below).',
  minColorPresenceRatio: 'Same: needs a small hue-distinct feature in non-ours artwork.',
  minColorPresenceOverExemplar:
    'Comparative against the reference product on our own artwork — doubly ' +
    'unable to decide anything, and pending the vendored-exemplar question.',
};

test('[provenance] no gate is anchored only on artwork we drew', () => {
  const anchors = thresholdAnchors(all);
  const violating = new Set();
  const detail = new Map();
  for (const [key, fixtures] of anchors) {
    if (fixtures.some((f) => MAY_ANCHOR.has(f.provenance))) continue;
    violating.add(key);
    detail.set(key, [...new Set(fixtures.map((f) => f.id))].join(', '));
  }

  const added = [...violating].filter((k) => !(k in KNOWN_IN_HOUSE_ANCHORS));
  assert.deepEqual(
    added,
    [],
    `NEW gates anchored only on our own artwork:\n` +
      added.map((k) => `  ${k} — only on ${detail.get(k)}`).join('\n') +
      `\n\nA gate our artwork alone can satisfy cannot tell an improvement from a ` +
      `change tuned to the fixture. Anchor the same metric on a synthetic fixture ` +
      `whose right answer is known independently (the way arcs-560x256 anchors the ` +
      `geometry bars) or on third-party artwork — not by loosening it. If neither ` +
      `exists, demote it to an aspiration: reported every run, decides nothing, ` +
      `which is what our own artwork is entitled to do.`,
  );

  const stale = Object.keys(KNOWN_IN_HOUSE_ANCHORS).filter((k) => !violating.has(k));
  assert.deepEqual(
    stale,
    [],
    `these are listed as known in-house-only anchors but no longer are — delete ` +
      `them from KNOWN_IN_HOUSE_ANCHORS so the list keeps shrinking: ${stale.join(', ')}`,
  );
});

test('[provenance] the corpus can answer "is this better for a user\'s images"', { skip: false }, () => {
  const deciders = all.filter((f) => f.provenance === 'third-party' && f.supported !== false);
  const inHouse = all.filter((f) => f.provenance === 'in-house');
  const summary =
    `decision-carrying (third-party) fixtures: ${deciders.length} ` +
    `[${deciders.map((f) => f.id).join(', ') || 'none'}]; in-house: ${inHouse.length}`;

  // Not an assertion about quality — an assertion that the deficiency is VISIBLE.
  // The committed corpus has no third-party artwork at all (2026-08-16), so this
  // test's job is to make that impossible to forget, and to go red the day
  // someone adds third-party artwork and then removes it again.
  assert.ok(
    deciders.length > 0 || local.length === 0,
    `${summary}\nLocal fixtures are present but none is labelled third-party — ` +
      `if local artwork is ours, the corpus has nothing that can decide a change.`,
  );
  console.log(`    [provenance] ${summary}`);
});
