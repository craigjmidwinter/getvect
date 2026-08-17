#!/usr/bin/env node
/**
 * The gate in front of `katra build`.
 *
 * Publishing a devlog publishes what is IN the entries, and the entries are
 * written for us, not for the public. Removing an asset from the repository does
 * NOT remove the sentence in an entry that names it — the file and the prose are
 * separate problems, and only one of them was solved by the purge.
 *
 * So the rule is OPT IN, not opt out. An entry is published only if it says
 * `publish: true`, and even then only if it passes every check below. The
 * default for anything written without thinking about it is "stays private".
 *
 * What this deliberately does NOT do:
 *
 *   - It does not render anything. `katra build` is the renderer; reimplementing
 *     it would mean the published page and the local one could drift.
 *   - It does not EDIT an entry to make it publishable. A sanitised copy is a
 *     second source of truth, and the moment one exists nobody knows which one
 *     is the log. Entries are copied byte-for-byte or not at all, and the copy
 *     is verified by digest against the source.
 *
 * Usage:
 *   node scripts/devlog-gate.mjs --audit    report what would publish, and why not
 *   node scripts/devlog-gate.mjs --stage <dir>   copy publishable entries + their
 *                                                media, verbatim
 *   node scripts/devlog-gate.mjs --build   stage, then run katra build (no deploy)
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KATRA = join(ROOT, 'katra');
const ENTRIES = join(KATRA, 'entries');

/**
 * Names that must not appear in anything published.
 *
 * Two different reasons, kept apart because they are not the same risk:
 * `competitor` is a product this project measured itself against and has decided
 * not to name; `rightsholder` is a third party whose artwork was removed from
 * the repository, where naming them in prose is a different kind of exposure
 * from shipping their file.
 *
 * The list is deliberately literal. A regex that tried to be clever about word
 * boundaries would eventually pass something through, and the cost of a false
 * positive here is "a human looks at an entry", which is cheap.
 */
const FORBIDDEN = [
  { term: 'vectorizer.io', why: 'competitor, by name' },
  { term: 'vectormagic', why: 'competitor, by name' },
  { term: 'vector magic', why: 'competitor, by name' },
  { term: 'snorlax', why: 'third-party character whose artwork was removed' },
  { term: 'nintendo', why: 'rightsholder of removed artwork' },
  { term: 'game freak', why: 'rightsholder of removed artwork' },
  { term: 'pokemon', why: 'rightsholder of removed artwork' },
  { term: 'pokémon', why: 'rightsholder of removed artwork' },
];

const frontmatter = (text) => (text.startsWith('---') ? text.split('---')[1] ?? '' : '');

function mediaRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(/!\[[^\]]*\]\((media\/[^)]+)\)/g)) refs.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:src|before|after):\s*(media\/\S+)/gm)) refs.add(m[1]);
  for (const m of text.matchAll(/^\s*-\s*src:\s*(media\/\S+)/gm)) refs.add(m[1]);
  return [...refs];
}

function stampedHashes(fm) {
  return [
    ...[...fm.matchAll(/^\s*-\s*"?([0-9a-f]{7,40})"?\s*$/gm)].map((m) => m[1]),
    ...[...fm.matchAll(/^hash:\s*"?([0-9a-f]{7,40})"?\s*$/gm)].map((m) => m[1]),
  ];
}

const resolves = (h) => {
  try {
    execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${h}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export async function inspect() {
  const names = (await fs.readdir(ENTRIES)).filter((n) => n.endsWith('.md')).sort();
  const out = [];
  for (const name of names) {
    const text = await fs.readFile(join(ENTRIES, name), 'utf8');
    const fm = frontmatter(text);
    const optedIn = /^publish:\s*true\s*$/m.test(fm);
    const blockers = [];

    const lower = text.toLowerCase();
    for (const { term, why } of FORBIDDEN) {
      if (lower.includes(term)) blockers.push(`names "${term}" (${why})`);
    }

    for (const ref of mediaRefs(text)) {
      try {
        await fs.access(join(KATRA, ref));
      } catch {
        blockers.push(`missing asset ${ref}`);
      }
    }

    const dead = stampedHashes(fm).filter((h) => !resolves(h));
    if (dead.length) {
      blockers.push(
        `${dead.length} stamped hash(es) do not resolve — a commit link that 404s is ` +
          `worse than no link, because the point of stamping is that it is checkable`,
      );
    }

    out.push({ name, id: name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''), optedIn, blockers });
  }
  return out;
}

async function stage(dir) {
  const rows = await inspect();
  const bad = rows.filter((r) => r.optedIn && r.blockers.length);
  if (bad.length) {
    console.error('REFUSING TO BUILD — these entries opt in but do not pass:\n');
    for (const r of bad) {
      console.error(`  ${r.id}`);
      for (const b of r.blockers) console.error(`      ${b}`);
    }
    console.error(
      '\nFix the entry, or take `publish: true` off it. Do NOT stage an edited copy:\n' +
        'the log is the source of truth and a sanitised twin is a second one.',
    );
    process.exit(1);
  }

  const chosen = rows.filter((r) => r.optedIn && !r.blockers.length);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(join(dir, 'entries'), { recursive: true });
  await fs.mkdir(join(dir, 'media'), { recursive: true });
  await fs.copyFile(join(KATRA, 'config.yml'), join(dir, 'config.yml'));

  const digest = async (p) => createHash('sha256').update(await fs.readFile(p)).digest('hex');
  let media = 0;
  for (const r of chosen) {
    const src = join(ENTRIES, r.name);
    const dst = join(dir, 'entries', r.name);
    await fs.copyFile(src, dst);
    // byte-for-byte, asserted rather than assumed
    if ((await digest(src)) !== (await digest(dst))) {
      throw new Error(`staged copy of ${r.name} differs from the source`);
    }
    for (const ref of mediaRefs(await fs.readFile(src, 'utf8'))) {
      await fs.copyFile(join(KATRA, ref), join(dir, ref));
      media++;
    }
  }
  console.log(`staged ${chosen.length} entr${chosen.length === 1 ? 'y' : 'ies'} and ${media} media file(s) into ${dir}`);
  console.log('every entry copied byte-for-byte and verified by digest; none edited');
  if (!chosen.length) {
    console.error('\nNothing opted in — the built site would be empty. Add `publish: true` to an entry.');
    process.exit(1);
  }
}

async function audit() {
  const rows = await inspect();
  const ready = rows.filter((r) => !r.blockers.length);
  const held = rows.filter((r) => r.blockers.length);
  console.log(`${rows.length} entries · ${ready.length} would pass the content rules · ${held.length} held back\n`);
  console.log('WOULD PUBLISH (once `publish: true` is added):');
  for (const r of ready) console.log(`  ${r.optedIn ? '[opted in] ' : '           '}${r.id}`);
  console.log('\nHELD BACK:');
  for (const r of held) {
    console.log(`  ${r.id}`);
    for (const b of r.blockers) console.log(`      ${b}`);
  }
}

/**
 * Stage, then hand the staged tree to `katra build`. The renderer is katra's;
 * this only ever decides WHICH entries it sees.
 */
async function build() {
  const work = join(ROOT, 'artifacts', 'devlog');
  await stage(join(work, 'katra'));
  execFileSync('katra', ['build', '--out', join(work, 'site')], { cwd: work, stdio: 'inherit' });
  console.log(`\nbuilt → ${join(work, 'site')}  (not deployed)`);
}

function usage() {
  console.log(`devlog-gate — decide which katra entries may be published.

  --audit            (default) list what would publish and what is held back, with reasons
  --build            stage the opted-in entries and run \`katra build\`; does NOT deploy
  --stage <dir>      copy the opted-in entries + their media into <dir>, verbatim
  --help             this

An entry publishes only if it opts in with \`publish: true\` in its frontmatter AND
passes every check: no forbidden name, no missing media, every stamped hash resolves.
Entries are copied byte-for-byte and verified by digest — never edited to make them
publishable, because a sanitised copy is a second source of truth.

  npm run devlog:audit
  npm run devlog:build`);
}

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') usage();
else if (arg === '--stage') await stage(process.argv[3] ?? join(ROOT, 'artifacts', 'devlog-src'));
else if (arg === '--build') await build();
else if (arg === '--audit' || arg === undefined) await audit();
else {
  console.error(`unknown option: ${arg}\n`);
  usage();
  process.exit(2);
}
