---
title: Prove the macOS signing pipeline end to end on a real release
date: "2026-08-25"
time: "21:56:52"
summary: 'Done at v0.1.3. The dmg is signed, notarized and stapled and the feed re-indexed against it; the gate passes green in CI on a real release, and the re-download check now runs against the published asset with a cache-buster and a sha512 cross-check. The site copy changed in the same commit as its proof.'
type: task
status: done
---



## State at 2026-08-26 22:29 — read this first

**v0.1.2 was cut with Craig's explicit word. The release FAILED at the artefact
gate and is STILL A DRAFT. Nothing was published. That is the correct outcome,
not an accident.**

### What is proven now, in CI, that was not before

- credential preflight passes with the real secrets (it had only ever been
  proven in the failing direction)
- **certificate import works on a fresh runner** — the Apple intermediate step
  and the identity-count check both do their job
- `notarytool` auth preflight passes in seconds
- **the .app is genuinely signed, notarized and stapled**:
  `spctl -a -t exec` → `accepted, source=Notarized Developer ID`,
  `stapler validate` → `The validate action worked!`,
  chain to Apple Root CA, Team `6UV93L24YL`, metadata all consistent

### What failed, and why it matters

**The `.dmg` container is `not signed at all`** — `spctl -a -t install` rejects
it and it carries no ticket. electron-builder signed/notarized/stapled the
**app**, then wrapped it in an unsigned dmg. `dmg.sign` defaults to false in
electron-builder v24+ and there is no `dmg:` block in `electron-builder.yml`.

This is the artefact-not-the-build rule paying for itself: *"notarization
succeeded"* was true and the file a stranger downloads was still unsigned.

### The decision the next session must make FIRST — it was deliberately not made

Two fixes, different costs. **Do not just relax the gate to go green** — the gate
is what asserts the claim.

1. **`dmg: { sign: true }`** — signs the container during creation, so the
   sha512 electron-builder writes into `latest-mac.yml` stays correct. Small and
   safe. **But it leaves the dmg with no stapled ticket**, so
   `spctl -a -t install` may still reject, and the site copy still could not
   claim what a user can verify on the download.
2. **Sign + notarize + staple the dmg** — matches Apple's guidance for disk-image
   distribution. **Requires reordering package → notarize → staple → publish**,
   because any post-build modification of the dmg invalidates the digest already
   written into `latest-mac.yml`, which is what the shipped updater trusts.
   That feed file is load-bearing; breaking it silently breaks every future
   update check.

### Not done, and blocked on the above

**The re-download check has still never run.** It is the one property that cannot
be proved without a published release, and the release never published. An
independent verifier is written at
`<scratchpad>/verify-published.sh` — it resolves the public
`browser_download_url`, fetches with a cache-buster and no-cache headers, prints
CDN headers so a cached hit is visible, and cross-checks the bytes against the
sha512 in `latest-mac.yml` before running the three checks. **It has not been
run against anything.** Re-create it if the scratchpad is gone; the cache-buster
matters because a CDN served a ten-minute-stale page tonight and the check passed
against the stale copy in the flattering direction.

### Do not touch

**The site and README still say the macOS build is unsigned. That is TRUE and it
stays until the re-download check passes**, and the copy changes in the SAME
commit that records that proof — saying what a user can check themselves
(Team `6UV93L24YL`, `spctl` accepts), not asserting signedness. See SIGNING.md,
"WHEN THE SITE MAY SAY SIGNED".

Tag `v0.1.2` exists and points at `efdddfd`. The draft release carries all six
artefacts. Re-running needs either a new tag or a deliberate re-run of run
`32926140417` after the fix lands.

## Closed 2026-08-27 — both blocked properties were proven at v0.1.3

Resolved by `e360997`, five releases before this file was reconciled; it sat at
`doing` the whole time, which is why the checkpoint that read it reported a
stale in-flight item and missed what was actually at risk.

- **The dmg decision was taken** — sign *and* notarize *and* staple the
  container, option 2, not the cheap `dmg.sign` fix and not a relaxed gate.
- **The re-download check has now run**, which was the one property that could
  not be proved without a published release: the dmg re-fetched from the public
  asset with a cache-buster, sha512 cross-checked against `latest-mac.yml`
  before any verdict, then codesign / spctl / stapler on both the dmg and the
  app inside it. It is no longer a scratchpad script — `release.yml:653`
  downloads the published artefacts, so the check cannot be skipped.
- **The DO NOT TOUCH on the site copy is discharged**, and was discharged the
  correct way: the claim and its evidence landed in the same commit, and
  Windows stays unsigned everywhere it appears.
