---
publish: true
title: The signature was the easy half
date: "2026-08-26"
time: "14:22:11"
tags:
    - release
    - signing
    - site
    - gates
hash: e360997
stat:
    f: 8
    a: 156
    d: 121
---

GetVect has shipped unsigned since v0.1.0, and every page said so plainly. As of
v0.1.3 the macOS dmg is signed with a Developer ID, notarized by Apple and
stapled. The interesting part of that is not the certificate. It is everything
the certificate quietly falsified.

## The ordering problem

electron-builder signs and staples the `.app`, then wraps it in a disk image it
does not sign. `dmg.sign` defaults to false, and its own docs warn that turning
it on "will lead to unwanted errors in combination with notarization
requirements". There is no stapler reference in the package at all. So the
artefact a user downloads carries no signature and no ticket, while the build log
says notarization succeeded. v0.1.2 failed the gate for exactly that, which is
the gate doing its job rather than a bug.

Signing the dmg ourselves afterwards fixes it and introduces a second problem
that is easier to miss. **Stapling writes the ticket into the file, so it changes
the bytes.** The sha512 electron-builder had already recorded in
`latest-mac.yml` was computed before that — and `latest-mac.yml` is what the
shipped app's updater trusts. A stapled dmg published beside a pre-staple digest
is a feed that disagrees with the file it points at, and nothing would have
noticed until the first user's update failed. So the digest is computed last:

    package (--publish never) -> sign dmg -> notarize -> staple
      -> re-hash -> rewrite latest-mac.yml -> upload

The stale blockmap beside it is the same defect one file over — it describes
bytes that no longer exist — so it is deleted rather than shipped wrong.

## Verify the artefact, not the build

Three properties were set before any of this was written: verify the artefact
rather than the build, make absent secrets **fail** rather than skip, and run the
last check against the **re-downloaded published asset**.

The third one is the one that keeps earning its place. A sibling artefact that
exercises the same code path is exactly convincing enough to stop you checking
the real one, which is the failure this repo has hit repeatedly — an injector
verified against a build directory while the deploy served a hand-copied
snapshot; a favicon verified at 512px while the tab drew it at 16. Tonight the
CDN served the release asset as `x-cache: HIT`. That was fine, but only because
the check compares bytes against the feed rather than trusting that a fresh URL
returns fresh bytes.

Apple accepted the hardened runtime on the first submission with zero issues.
The sharp and resvg native binaries needed no entitlement beyond the plist we
already ship, which was the one genuine unknown going in.

## The copy was in more places than the copy

Then the claim had to change, and it turned out "the build is unsigned" was not
one sentence. It was the hero meta line, the download callout, a troubleshooting
entry titled after the error message Gatekeeper prints, the updater rationale in
three separate files, and the release-notes template the workflow writes into
every future release — the last of which would have kept telling users to run
`xattr -dr com.apple.quarantine` on a notarized app forever.

The Homebrew section was the one worth thinking about rather than editing. Its
whole argument was quarantine: a formula builds from source, so nothing arrives
as a downloaded bundle, so there is nothing to strip. That argument is now
obsolete, but the section is not — it is just no longer a workaround. A signed
dmg is something Apple has checked; a formula is something you compiled yourself
and never had to trust anyone about. Different guarantee, not a weaker one.

Windows stays unsigned in every one of those places, because it is.

## Rewording disarmed three checks

`regenerate-derived-assets.mjs` matches published copy against measured numbers
by regex, so a sentence claiming 17 KB is checked against an actual trace. Prose
drift is deliberately a warning — a number in a sentence is a human's call.

But a pattern that matches *nothing* printed `(not found)` and exited zero.
Rewriting the demo paragraph in an earlier copy pass had quietly retired three
detectors, and the table went on printing them as though they were being
watched. That is the DEAD GATE rule with the serial numbers filed off: a
declared threshold whose metric is not produced must fail the runner.

MISSING is now a hard failure and distinct from DRIFT. Reword the copy freely;
re-point the pattern, or delete the entry deliberately. Proven red against a
reworded sentence and green again after.

The signature took a certificate. Everything downstream of it took reading the
same claim in eight files and asking, each time, whether the sentence was still
true — which is the part no credential does for you.
