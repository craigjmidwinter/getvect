---
title: The install nobody had timed
date: "2026-08-21"
time: "07:50:10"
tags:
    - ergonomics
    - standards
advances:
    - ergonomics-pass-leg-g
---

```embed
src: media/ergo-findings.html
height: 480
caption: Timed docs-only installs, and the installer that reports success after destroying one
```

The fleet standard grew an ERGONOMICS section, and its premise is that the
5-minute install bar is earned by doing, not claimed by reading. Two agents
did it: fresh docs-only installs on macOS and on the Windows box, timed,
failure paths triggered on purpose, uninstall audited to the last byte.

The times were never the problem — every path lands under a minute against a
five-minute bar. What the pass actually caught:

**A documented command that lies when you run it out of order.** `npm test`
before `npm install` died with a bare TS2688 about type definitions — pure
compiler arithmetic on a missing node_modules, no sentence pointing anywhere.
Now a stdlib-only guard runs before every compile step and says "run
`npm install`", which it can do precisely because it needs nothing installed.
Proven by deleting node_modules and watching it teach.

**Docs that contradicted themselves and the release.** The docs page opened
with "There is no installer yet" one sentence before handing you the dmg; the
README still said "Windows is untested ... not published" two days after
v0.1.1 shipped a verified Windows installer. Both now tell the current truth,
and the release ritual in PUBLISH-CHECKLIST no longer hardcodes a version
that would silently re-tag the one already shipped.

**Uninstall was documented nowhere, for any platform.** The standard's line —
a project that installs things it never mentions removing is a defect — fit
exactly. README and the docs page now carry a Removing GetVect section for
both platforms, including the two things the Windows uninstaller leaves
behind (the settings dir and the 100 MB installer cache), stated as measured
fact rather than omitted.

**And one genuinely alarming installer behaviour, found by pointing the
installer at a directory it could not write:** NSIS's upgrade logic
uninstalls the working copy *first*, fails the new copy silently, writes the
registry entry anyway — pointing at an uninstaller that was never written —
and exits 0. A working install destroyed, reported as success. The same
session hit an unresolved AV-adjacent variant five times: binary never
written, everything else written, exit 0. Both are filed as tasks with the
evidence; the fix direction (verify the target before touching the old
install, never write the key before the copy is confirmed) is in the task.

```warning
Still untestable without a human and a screen: first GUI launch on either
platform, SmartScreen's actual dialog (no transfer path we control attaches
the Mark of the Web), and a true cross-version Windows upgrade — that one
exists the day a second Windows release does.
```
