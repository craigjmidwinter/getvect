---
title: Nobody had ever installed the exe
date: "2026-08-19"
time: "15:17:56"
tags:
    - release
    - windows
    - verification
hash: 7d26940
stat:
    f: 3
    a: 255
    d: 0
---

```embed
src: media/install-footprint.html
height: 480
caption: What a GetVect install writes to a Windows machine, and the one thing uninstall leaves behind
```

The smoke workflow proved the exe *builds*. Nobody had ever run it. The site
already tells Windows visitors the installer "is per-user and never asks for
administrator rights" — wording read off nsis's documented defaults, not off a
machine. Today the fabric's Windows box installed GetVect for the first time,
and the claims got checked against a real registry.

Before touching the machine, the artifact got one free check: the exe's sha512
matches `latest.yml` byte for byte — the file we tested is the file
electron-updater would fetch.

## The install that proved the wrong thing

The first silent install (`/S`, over ssh) passed every check in six seconds:
binary at `%LOCALAPPDATA%\Programs\GetVect`, FileVersion 0.1.0, `app-update.yml`
pointing at craigjmidwinter/getvect, HKCU-only registration, nothing in HKLM or
Program Files, per-user Start Menu shortcut. And it proved nothing about the
no-admin claim — Windows sshd hands an admin user an **elevated** token, so the
installer had admin available the whole time. An installer that quietly uses
elevation it happens to have would look identical.

Getting a genuinely unelevated process over ssh took three attempts:
`runas /trustlevel:0x20000` needs an interactive desktop and silently does
nothing from an ssh session; a scheduled task with `/RL LIMITED` works but
`schtasks /tr` mangles quoted paths, and this user's home directory has a space
in it — so the whole kit moved to `C:\Users\Public\gvtest`. The task's token was
probed before trusting it: `whoami /groups` under the task shows Medium
Mandatory Level with the Administrators group present but disabled. Elevation is
not possible from that token. The installer ran under it and produced the
identical per-user footprint.

```note
Both site claims are now observed rather than documented-default: **per-user**
(everything under the user profile and HKCU, nothing machine-wide even when the
installer HAS admin) and **no admin required** (a Medium-IL token cannot elevate,
and the install succeeded under one). The SmartScreen sentence stays as-written
but unverified: scp strips the Mark of the Web, so SmartScreen has nothing to
judge over this path — that one needs a human downloading through a browser.
```

## What uninstall leaves behind

The uninstaller (also never run before today) removes the install tree, the
HKCU key and the shortcut — and leaves `%LOCALAPPDATA%\getvect-updater\
installer.exe`, a full 100 MB cached copy of the installer the install itself
put there. Every install/uninstall cycle strands 100 MB. Known now, reported,
not yet decided on: it is electron-builder's cache, and whether to chase it is a
release-behavior question.

Two smaller truths from the lap: the 100 MB installer expands to 349 MB on
disk, and Windows pads the version resource — ProductVersion reads `0.1.0.0`,
so assertions belong on FileVersion.

The sequence is now `scripts/verify-windows-install.ps1` — token probe,
LIMITED-task install, footprint checks, uninstall verification, residue
cleanup — with the ssh recipe in the header, so the next release candidate gets
this for the cost of one command.

```warning
Launching the app remains untested: ssh cannot render a window, and the
scheduled task runs in the logged-on user's session — a surprise GUI on
someone's active desktop is not a test. First launch, SmartScreen, and the
updater's first real check all still need eyes on a screen.
```
