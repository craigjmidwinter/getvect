---
title: Installer silent-failure mode under an AV-active box
date: "2026-08-21"
time: "08:15:44"
tags:
    - ergonomics
    - windows
summary: 'Reproduced 5x on windesk (Malwarebytes active): installer writes registry+shortcut+updater cache but NOT the app binary, exit 0. Sha verified, MOTW absent, LIMITED-token ruled out. Unresolved; consider a post-install self-check (binary exists+version) in the installer, and an upstream electron-builder report.'
type: task
status: todo
effort: M
epic: standards-pass-follow-ups
---


