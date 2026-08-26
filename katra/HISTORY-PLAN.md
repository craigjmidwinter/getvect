# History rewrite — plan only, NOT authorised, nothing executed

Prepared 2026-08-26. **No force-push has happened and none will without Craig's
word.** This is his public repo; a rewrite breaks every clone and invalidates
every existing commit link, including the ones stamped in the devlog.

## Repo facts, measured

| | |
|---|---|
| commits on `main` | **209** |
| forks | **0** |
| stars | 1 |
| remote branches | **1** (`main` only) |
| tags | `v0.1.0`, `v0.1.0-rewritten`, `v0.1.1`, `v0.1.2`, `v0.1.3` |

Zero forks and one branch is the best case a rewrite can have: nobody else's
clone diverges, and there are no PRs to invalidate. What a rewrite still costs is
**tags and published GitHub Releases**, because a moved tag orphans the commit its
release points at.

Depth from HEAD — a rewrite reaching deeper than a tag **moves that tag**:

    v0.1.3               0 commits from HEAD   <- HEAD, release in flight
    v0.1.2               4
    v0.1.1              30
    v0.1.0              90
    v0.1.0-rewritten    90

## Tier 1 — squash today's marketing-copy commits

**Craig asked for this and it is the safe one, with one collision he has to
decide about.**

The copy commits are:

    fc187d7  Site copy: stop narrating our own process at the reader
    868c6d6  Front page answers "what is this"; devlog stops implying we copied anyone

**The collision:** both sit *below* `v0.1.3` (`7e1335b`, HEAD). Squashing them
rewrites `7e1335b` too — its parent changes, so it gets a new SHA — and the
`v0.1.3` tag would then point at an orphaned commit. There is no way to squash
these two without moving `v0.1.3`.

Three ways out, and this is the decision:

1. **Do nothing to history; squash going forward.** Costs nothing, leaves two
   tidy-but-separate commits in the log. Recommended if the release publishes.
2. **Squash and re-tag `v0.1.3`.** Clean history, but only sane *before* the
   release publishes — once assets are attached to a release pointing at that
   tag, moving it detaches them.
3. **Abandon `v0.1.3`, squash, cut `v0.1.4` from the squashed history.** Cleanest
   result, costs one release number.

Scope either way: **3 commits**, all on `main`, no forks, nothing else affected.

## Tier 2 — reach the two boastful devlog commits

    6542865   36 from HEAD   Publish the devlog: 21 gated entries, their own nav section
    3a7ab5f  155 from HEAD   Chronicle the Enhance arc: generative discovery, BYO-key…

- Reaching **6542865** rewrites **36 commits** and moves **3 tags**
  (`v0.1.1`, `v0.1.2`, `v0.1.3`) — three published releases detach.
- Reaching **3a7ab5f** rewrites **155 commits** — three quarters of the repo — and
  moves **all five tags**. Every release detaches.

**My read: not worth it.** The framing in those commits is a commit *message* and
a devlog body, both of which we can fix at HEAD by deleting the entries. History
would only matter if someone were actively reading old commit bodies, and the
survey already found no competitor is named by brand anywhere in 209 commits.

## Tier 3 — purge `fixtures/reference/OBSERVED-UI.md` from history

    30d753a  203 from HEAD   Add observed-UI ground truth doc…   (adds it)
    c281834   71 from HEAD   Purge the vendored competitor output…  (deletes it)

Deleted from HEAD, still reachable in history. Removing the blob means rewriting
from **203 commits deep — effectively the entire repository** — and moving every
tag and every release.

**My read: the most expensive option for the least benefit**, and it should be
judged on what the file actually says rather than on the fact that it exists. It
should be read first; if it is a description of observed behaviour with no brand
name and no copied asset, the cost is not justified.

## What the survey cleared

Both HEAD files flagged as worth reading are **clean**:

- `instruments/reference-engine.mjs` — a deliberately naive in-house tracer used
  to prove the measurement chain works while `src/engine` was a stub. "Reference
  engine" here means *our* stub, not a competitor. The name sits awkwardly beside
  the "reference product" euphemism used elsewhere, but the file describes only
  our own code. Zero competitor references.
- `fixtures/reference/ARTWORK.md` — about our own artwork, its licence, and why
  in-house fixtures gate nothing. Nothing about anyone else's product.

## Recommendation

Take **Tier 1 option 1 or 3** and stop. Do the cleanup at HEAD by deleting
entries, which is cheap, reviewable and cannot be misread — and leave 209 commits
of real history intact. A rewrite reaching Tier 2 or 3 detaches published
releases and breaks every stamped commit link in the devlog, to remove wording we
can delete from the live site in a single commit.
