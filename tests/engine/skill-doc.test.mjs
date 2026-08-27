/**
 * SKILL.md AND docs/CLI.md DESCRIBE THE BINARY THAT EXISTS.
 *
 * An agent reads the skill file and acts on it literally. A wrong flag name, a
 * stale default or an exit code that moved does not produce a confused human who
 * asks a question — it produces a failed run the caller cannot diagnose, because
 * the document it trusted was the thing that was wrong.
 *
 * Docs rot in exactly one direction: the code changes and nobody re-reads the
 * prose. So the prose is checked against the code here rather than by anyone
 * remembering. Every flag either exists or the doc is wrong; every exit code
 * named matches the table the CLI actually uses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const SKILL = read('SKILL.md');
const CLI_DOC = read('docs/CLI.md');
const cliSrc = read('src/cli/index.ts');

/** Flags the parser actually accepts, from its own switch. */
function realFlags() {
  const flags = new Set();
  for (const m of cliSrc.matchAll(/case '(-[^']+)':/g)) flags.add(m[1]);
  return flags;
}

test('every flag the docs mention exists in the parser', () => {
  const real = realFlags();
  assert.ok(real.size > 10, `only found ${real.size} flags — the extractor is broken`);

  for (const [label, text] of [['SKILL.md', SKILL], ['docs/CLI.md', CLI_DOC]]) {
    // Long flags only: short ones collide with prose like "-c 16" in a sentence.
    const mentioned = new Set([...text.matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1]));
    // Flags the prose names as EXAMPLES OF BEING REJECTED. `--colours-please`
    // appears in docs/CLI.md to illustrate that an unknown flag is an error, so
    // requiring it to exist would be this guard reading its own example as a
    // claim — the same shape as a detector matching the paragraph that explains
    // it. Anything added here must be genuinely illustrative, never a real flag
    // somebody removed.
    const illustrative = new Set(['--colours-please']);
    for (const flag of mentioned) {
      if (illustrative.has(flag)) continue;
      assert.ok(
        real.has(flag),
        `${label} documents ${flag}, which the CLI does not accept`,
      );
    }
  }
});

test('the exit codes the docs name match the ones the CLI uses', () => {
  const table = /export const EXIT = \{([\s\S]*?)\} as const;/.exec(cliSrc);
  assert.ok(table, 'the EXIT table moved — re-point this guard');
  const codes = new Map();
  for (const m of table[1].matchAll(/(\w+):\s*(\d+)/g)) codes.set(m[1], Number(m[2]));
  assert.ok(codes.size >= 6, 'the EXIT table looks empty');

  // Both documents present a table of numbers. Every number they claim must be
  // one the CLI can actually return.
  const valid = new Set(codes.values());
  for (const [label, text] of [['SKILL.md', SKILL], ['docs/CLI.md', CLI_DOC]]) {
    const rows = [...text.matchAll(/^\|\s*`?(\d{2,3})`?\s*\|/gm)].map((m) => Number(m[1]));
    assert.ok(rows.length >= 5, `${label} lists only ${rows.length} exit codes`);
    for (const code of rows) {
      assert.ok(valid.has(code), `${label} documents exit ${code}, which the CLI never returns`);
    }
  }
  // And the one a caller most needs: refusing an existing output.
  // `codes` is a Map: property access returns undefined, which is how the
  // first version of this asserted `undefined !== 73` against correct code.
  assert.equal(codes.get('cannotWrite'), 73);
  assert.match(SKILL, /73/, 'SKILL.md does not mention the overwrite exit code');
});

test('SKILL.md leads with when NOT to use it, and warns about the derived filename', () => {
  // An agent needs the negative case as much as the positive one: the common
  // failure is reaching for a vectoriser on a photograph.
  assert.match(SKILL, /Do not use it for/i, 'SKILL.md never says when not to use this');
  assert.match(SKILL, /photograph/i, 'the photograph case is the one worth naming');

  // The overwrite behaviour is the single most likely way an automated caller
  // loses data, because the default output name is derived rather than given.
  assert.match(SKILL, /will not overwrite/i);
  assert.match(SKILL, /derived/i, 'SKILL.md does not explain that the default name is derived');
  assert.match(
    SKILL,
    /never pass `--force` speculatively|do not retry the same command/i,
    'SKILL.md does not tell the caller what to do on 73',
  );
});

test('SKILL.md has the frontmatter a skill loader needs', () => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(SKILL);
  assert.ok(fm, 'no YAML frontmatter');
  for (const key of ['name:', 'description:']) {
    assert.ok(fm[1].includes(key), `frontmatter is missing ${key}`);
  }
  // The description is the discovery surface: it decides whether the skill is
  // reached for at all, so it has to say when, not just what.
  assert.ok(
    /Use when/i.test(fm[1]),
    'the description does not say WHEN to use this, which is what it is read for',
  );
});

test('the documented defaults match the engine', async () => {
  const engine = await import(join(root, 'dist', 'engine', 'index.js').replace(/^/, 'file://'));
  const d = engine.DEFAULT_SETTINGS;
  // A stale default is worse than a missing one: it reads as authoritative.
  const claims = [
    [/`-c`, `--colors` \| 2–64 \| `(\d+)`/, String(d.colorCount)],
    [/`--detail` \| 0–100 \| `(\d+)`/, String(d.detail)],
    [/`--smoothing` \| 0–100 \| `(\d+)`/, String(d.smoothing)],
    [/`--despeckle` \| 0–100 \| `(\d+)`/, String(d.despeckle)],
    [/`--min-area` \| 0–10000 \| `(\d+)`/, String(d.minArea)],
    [/`--threshold` \| 0–255 \| `(\d+)`/, String(d.bwThreshold)],
  ];
  for (const [re, expected] of claims) {
    const m = re.exec(CLI_DOC);
    assert.ok(m, `docs/CLI.md no longer states a default matching ${re}`);
    assert.equal(m[1], expected, `docs/CLI.md claims ${m[1]}, the engine default is ${expected}`);
  }
});
