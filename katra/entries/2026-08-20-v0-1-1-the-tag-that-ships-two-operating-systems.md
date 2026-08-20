---
title: 'v0.1.1: the tag that ships two operating systems'
date: "2026-08-20"
time: "18:00:00"
tags:
    - release
    - windows
hash: 2e5545a
stat:
    f: 3
    a: 14
    d: 7
---

![The download section, live, after v0.1.1 — every word on it is now true](media/site-download-011.png)

Craig clicked CUT on the board and v0.1.1 went out — the first tag through the
four-job pipeline, and the first GetVect a Windows user can install.

The ritual was exactly the three commands the checklist promises, plus the
CHANGELOG getting its release date. The pipeline did the rest unattended:
draft opened one release, macOS and Windows built in parallel on their own
runners, and publish counted all the artefacts before un-drafting — dmg, zip,
exe, both blockmaps, and both feed files, `latest-mac.yml` and `latest.yml`,
so an installed copy on either OS can hear about the next version.

Yesterday's standards sweep flagged one honesty defect: the site claimed a
Windows download the published release did not carry. The fix was never going
to be copy-editing — the button and the prose were both *pipeline-true* and
*release-false*, and the release was the thing missing. Simulating
`download.js` against the live API now resolves `GetVect-0.1.1-arm64.dmg` for
macOS and `GetVect-0.1.1-x64.exe` for Windows, the exe answers 200, and the
rendered page reads "Download GetVect 0.1.1 for macOS · 117 MB · unsigned"
with "Also for Windows" beside it. Every claim on that screen is now backed
by an artefact — including the per-user, no-admin installer behaviour, which
was verified on a real Windows machine before any user saw it.

```note
Installed 0.1.0 Macs will see the update banner on next launch — the feed now
carries 0.1.1 — and, per the unsigned-build stance, will be told rather than
auto-updated. The Windows exe in this release is byte-for-byte the pipeline's
output, not the smoke artefact; its install behaviour was verified from the
smoke build of the same commit lineage.
```
