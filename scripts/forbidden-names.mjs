/**
 * The names that must not appear in anything published, stored as digests.
 *
 * WHY THIS FILE IS NOT A LIST OF NAMES. A blocklist has to contain the string in
 * order to match it, so the one file whose job is preventing a disclosure was
 * the only file performing it: the terms sat in plain text at HEAD in a public
 * repository, readable unauthenticated from raw.githubusercontent.com. Anyone
 * curious about who this project had decided not to name only had to read the
 * script that exists to stop it being named.
 *
 * So the terms are stored as SHA-256 of the NFC-normalised, lowercased term,
 * with the term's length, and a reason that describes the risk without
 * reconstructing the name.
 *
 * WHAT THIS DOES AND DOES NOT BUY. It defeats reading and grepping, which is the
 * actual exposure: nobody browsing the repo learns a name, and no search engine
 * indexes one. It does NOT defeat a determined dictionary attack. These are
 * short, guessable strings and the length is stored beside the digest, so
 * somebody who already suspects a specific name can confirm it by hashing their
 * guess. Salting would not change that, because the salt would have to live
 * here too. The goal is that the repository does not ANNOUNCE the names, not
 * that a motivated attacker cannot test a hypothesis.
 *
 * MATCHING IS UNCHANGED, and that mattered more than the storage format. The
 * gate matched with `lower.includes(term)`, a plain substring test over the
 * whole entry, and the header of the old list said the literalness was
 * deliberate: "a regex that tried to be clever about word boundaries would
 * eventually pass something through". Hashing tokens or word n-grams would have
 * been exactly that cleverness. A term embedded in a URL, a possessive, a
 * hashtag or a hyphenated compound is still a disclosure, and tokenising stops
 * seeing it, which is to say it would have failed in the one direction that
 * matters.
 *
 * A sliding window keeps the old semantics exactly. For each distinct term
 * length, every window of that length in the text is hashed and looked up.
 * `includes(term)` is true if and only if some window of `term.length` equals
 * the term, if and only if some window hashes to the term's digest. Same
 * answers, no readable names. It costs about 360 ms over the whole 34-entry
 * corpus, which is nothing for a gate that runs before a publish.
 *
 * NFC normalisation is the one deliberate strengthening. The old check would
 * miss an accented name written in decomposed form; both sides are normalised
 * now, so everything that tripped before still trips and some spellings that
 * slipped through no longer do.
 */
import { createHash } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest('hex');

/** Normalised the same way on both sides, or the digests never line up. */
export const normalize = (s) => s.normalize('NFC').toLowerCase();

/**
 * Each entry: digest of the normalised term, its length, and why it is barred.
 *
 * The reasons are kept because a human reading a gate failure needs to know
 * which kind of risk tripped: `competitor` is a product this project measured
 * itself against and has decided not to name, `rightsholder` is a third party
 * whose artwork was removed from the repository, where naming them in prose is a
 * different kind of exposure from shipping their file. Neither reason names
 * anybody.
 */
export const FORBIDDEN = [
  { h: 'e50217291a435dd51688a4c1b43a37cdefb8c54b4559594f508ce1f0d359fdfa', len: 13, why: 'competitor, named directly' },
  { h: 'f4dae73a0c0dbeaa49fc4a66e42188a883a3e73bf319125a5e4f85ac85b03285', len: 11, why: 'competitor, named directly' },
  { h: '814c0317d1e57995dd0d80c3bef91a9af2a056a2022f7f72b0fe45445581756e', len: 12, why: 'competitor, named with a space' },
  { h: 'a5ea03bae2426a6fe61701edc6576d0e6491e998f9db3cb38ce957c11516ce74', len: 7, why: 'third-party character whose artwork was removed' },
  { h: 'c0a4942143e872cd1ae29fc759e04526de2e909ac1732734d38550a29c2e2516', len: 8, why: 'rightsholder of removed artwork' },
  { h: '1aa93c6bdf90127eac7074ee73470f9bc0b8817b7850361d1a7d36a33a2586c2', len: 10, why: 'rightsholder of removed artwork' },
  { h: 'eaa2bded32cc585d3f37c5319abe8890ad28a697ed66d5823f10536cc9c0fdb9', len: 7, why: 'rightsholder of removed artwork' },
  { h: '61c220d696ce5502ac914eb31e855cc2dd2b6b5ff5dc7a95c5a0fdcc924cb076', len: 7, why: 'rightsholder of removed artwork, accented spelling' },
];

/**
 * Every reason whose term appears anywhere in `text`, deduplicated.
 *
 * Equivalent to the old `FORBIDDEN.filter((t) => lower.includes(t.term))`, and
 * returns reasons rather than terms because the terms are not recoverable here.
 * That is a small loss in the failure message and an acceptable one: the reason
 * plus the entry name is enough for a human to find the sentence.
 *
 * `list` is injectable so a test can prove the mechanism trips without putting a
 * real forbidden term back into the repository, which would undo the point.
 */
export function forbiddenIn(text, list = FORBIDDEN) {
  const lower = normalize(text);
  const byLen = new Map();
  for (const { h, len, why } of list) {
    if (!byLen.has(len)) byLen.set(len, new Map());
    byLen.get(len).set(h, why);
  }

  const hits = [];
  const seen = new Set();
  for (const [len, table] of byLen) {
    for (let i = 0; i + len <= lower.length; i++) {
      const h = digest(lower.slice(i, i + len));
      const why = table.get(h);
      if (why !== undefined && !seen.has(h)) {
        seen.add(h);
        hits.push(why);
      }
    }
  }
  return hits;
}

/** Digest one term the way the table stores it. For tooling and tests. */
export function termDigest(term) {
  const n = normalize(term);
  return { h: digest(n), len: n.length };
}
