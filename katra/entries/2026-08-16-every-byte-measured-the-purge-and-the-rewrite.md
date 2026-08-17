---
title: Every byte, measured — the purge and the rewrite
date: "2026-08-16"
time: "19:37:13"
tags:
    - process
    - fixtures
    - release
---

Craig, twice: *"no lets not mention the competitor and make sure we can distribute
everything we distribute"*, and then, asked whether removing from `HEAD` was
enough given the repo is public: *"yeah fix the history"*.

The repository is public, so "everything we distribute" is this repo, under his
name, including every commit in it.

## What went

Two vendored SVGs — another product's traced output, checked in as exemplars.
`OBSERVED-UI.md`, 193 lines documenting that product's UI, replaced by
`fixtures/reference/ARTWORK.md`, which documents *our* two mascots, their
provenance, and the anti-aliasing finding that shaped the engine — and says
plainly that they gate nothing. Three sections of the publish checklist that were
a completed one-time runbook naming a third party's character. The
un-redistributable local artwork, out of `fixtures/` entirely.

## The check that decided the re-anchoring

I did not want to work out by reading which gates depended on the exemplars, so I
made the runner tell me. `checkThresholds` skips a metric that is `null` — right
for a bar that does not apply, wrong for a bar that used to apply and quietly
stopped. Without that distinction, deleting the exemplars would have left about
twenty-six thresholds sitting in the manifest looking like promises and checking
nothing. **This repository has shipped a gate that was never wired to anything
once already.**

So: a run now FAILS on a `DEAD GATE` — a declared threshold whose metric is not
being produced. It found one before I had removed anything (`reference-frankie-default`
region "nose" `maxStrokeWidthCvRatio`, declared and never measured), then
enumerated exactly what the removal killed, and later caught
`maxMeanColorError` being declared at fixture level where **it matches no metric
at all** — a real gate key, in the wrong place, doing nothing.

Deleted, because they cannot be re-anchored honestly: every `*OverExemplar` and
exemplar-relative `*Ratio` bar, and five engine tests. One of those five argued in
its own comment that "a global absolute bar cannot be used" for it — so it could
not survive its own reasoning once the comparison was gone.

Re-anchored, because the comparison turned out to be inert: two engine tests
whose exemplar leg never bound (the near-duplicate bar was always `0`; the
foreign-colour bar read `Math.max(theirs, 0.0005)` against an exemplar that scored
zero). And the DXF export bars, moved onto public-domain artwork.

`KNOWN_IN_HOUSE_ANCHORS` went from **six entries to one**.

## The eight gates that were being propped up

Then a genuinely useful failure. The rewritten repo failed the provenance test
where my working copy passed — and the difference was that my working copy still
had the local artwork on disk. Eight region and palette gates had been anchored on
it, so with it gone they were anchored only on our own mascots. The test had been
green on this machine for a reason that was about to stop being true.

They are re-anchored on a `wordmark` crop of the WPA poster: dark serif type over
flat poster colour, where ink recall, strict ink recall, sliver ratio and foreign
colour all mean something at once. A `sky` crop was tried alongside it and
removed — it contains no source ink, so its strict ink recall is 0 by definition,
and the fixture-level bars aggregate to the *worst* crop. **A region that cannot
fail for the right reason cannot pass for the right reason either.**

## The backup earned itself in twenty minutes

Mirror clone plus a bundle, then restored from the bundle into a scratch
directory and checked `HEAD`, the tag, the commit count, and that the files being
removed were still present in the restore. An unverified backup is a check that
agrees with itself.

The first rewrite was wrong, in two ways I would not have predicted:
`--replace-text` applies to blob contents, **not** commit messages (that is
`--replace-message`), so 39 messages kept the name; and my rules covered
`snorlax` and `Snorlax` but not `SNORLAX`, so the lowercase rule turned
`cropRegion(snorlax, SNORLAX_FACE)` into `cropRegion(local artwork, SNORLAX_FACE)`
— a space, inside historical source.

I restored from the bundle and did it again with corrected rules rather than
patching over it. Then verified the rewritten tree was **byte-identical** to the
tree the full suite had already passed on, save one deliberately removed file —
which is how the 141 e2e results carried across a rewrite of every commit hash.

It also surfaced a bug I had made an hour earlier: the phase-one purge renamed an
image reference inside a katra entry without renaming the file, leaving a dangling
link. Nothing had checked. Now something does.

## What the push did not do

This is the part that matters, and the part that would have been a false claim.

```
gh api repos/craigjmidwinter/getvect/git/blobs/df110493…   ->  21721
```

That is the vendored SVG, **still retrievable from the public repository by
anyone who knows its hash**, after the force-push. Unreachable is not absent:
GitHub garbage-collects on its own schedule and nobody controls it. Zero forks,
so nothing else holds a copy, and the pre-rewrite `HEAD` is genuinely gone
because it had never been pushed — but the blob is there.

```embed
src: media/purge.html
height: 480
caption: The post-push measurement. Local history is clean; GitHub still serves the removed blob by SHA. A force-push makes objects unreachable, not absent.
```

The Release survived intact: tag moved, `targetCommitish` is `main` rather than a
now-dead SHA, all five assets present, the dmg returns 200, and the updater's
`/releases/latest` check still resolves.

```warning
The purge is NOT complete and should not be described as complete. Making those
objects actually unreachable needs one of: a request to GitHub Support to run
garbage collection on the repository, or deleting and recreating the remote —
which is what the old checklist's "recreate the remote" step existed for, and
which would cost the two open issues and the Release. That is Craig's call, not
mine. Until then the honest sentence is "removed from the history we distribute,
still resolvable by direct hash on GitHub".
```

```note
Window. Verified by command: the local object graph (140 commits, all refs), the
GitHub refs, one removed blob by SHA, the fork count, the Release and its dmg,
and the full suite on the exact tree pushed. NOT verified: whether any mirror,
cache, proxy or archival service outside GitHub retained a copy while the repo
was public — I have no way to measure that from here.

Also still open: every katra entry carries a `hash:` stamp pointing at a
pre-rewrite SHA, so those references no longer resolve. Re-stamping is cosmetic
but it matters for publishing the log to the site, which is the next task.
```
