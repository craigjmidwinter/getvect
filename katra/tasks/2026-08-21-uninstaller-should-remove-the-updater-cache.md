---
title: Uninstaller should remove the updater cache
date: "2026-08-21"
time: "08:15:45"
tags:
    - ergonomics
    - windows
summary: Every install/uninstall cycle strands ~100MB in %LOCALAPPDATA%\getvect-updater. Documented honestly in README/docs now; the real fix is the uninstaller cleaning it (electron-builder nsis deleteAppDataOnUninstall or custom uninstall include).
type: task
status: todo
effort: S
epic: standards-pass-follow-ups
---


