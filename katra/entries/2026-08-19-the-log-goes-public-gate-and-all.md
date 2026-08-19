---
title: The log goes public, gate and all
date: "2026-08-19"
time: "18:28:43"
tags:
    - devlog
    - site
    - release
hash: "6542865"
stat:
    f: 58
    a: 2758
    d: 0
---

![getvect.midwinter.io/devlog — 21 entries live, rendered headlessly straight off production](media/devlog-live.png)

Craig ruled on the standing ask: ship the devlog. The count in the ask said
twelve; the gate said twenty-one by the time the ruling landed — entries kept
arriving and the history rewrite's restamping recovered hashes in the meantime.
The number was a snapshot; the criterion was always "passes the gate", so the
gate decided.

What shipped is the mechanism, not a curation pass. Every published entry
carries an explicit `publish: true`; the build refuses any opted-in entry that
names a forbidden party, references missing media, or stamps a commit that no
longer resolves. Six entries stay back — two name a third-party character whose
artwork was purged, one names its rightsholder, four carry hashes the rewrite
made unrecoverable. Nothing was edited to squeak through: staged copies are
byte-for-byte and digest-verified, because a sanitised twin of a log is a
second source of truth and the death of the first one.

Two sweeps ran after the render, on the theory that the gate checks entry
prose but a built site is more than prose: the full output tree (media
filenames included) and then the *live* data.json, fetched back from
production, both grep-clean of every forbidden term.

The viewer mounts at /devlog/ with its own nav item on both pages — its own
section, not a corner of the docs. Every path in the built app is relative and
the absent hub manifest is handled, so the subpath cost nothing.

```note
The public build keeps katra's "+ New draft" button; clicking it tells you
drafts are created from the CLI. In a public devlog of a developer tool, an
honest alert about how the sausage is made feels less like a bug than a
signature. Left alone on purpose — the alternative was hand-editing renderer
output, which is the same second-pipeline disease the gate exists to prevent.
```
