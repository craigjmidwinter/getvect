---
title: Installer can destroy an existing install and still exit 0
date: "2026-08-21"
time: "08:15:44"
tags:
    - ergonomics
    - windows
summary: 'Measured on windesk: /S /D=<unwritable dir> uninstalls the working per-user copy FIRST, fails the new copy silently, exits 0, leaves a phantom HKCU entry with a dead UninstallString. Fix direction: verify target writability before touching the old install (electron-builder NSIS include), or reject /D; never write the registry key before the copy is confirmed.'
type: task
status: todo
effort: M
epic: standards-pass-follow-ups
---


