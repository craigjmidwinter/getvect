---
title: Upgrade sharp past the libvips CVEs; move it to devDependencies
date: "2026-08-20"
time: "16:32:11"
tags:
    - security
    - deps
summary: 'npm audit: sharp <0.35.0 high (GHSA-f88m-g3jw-g9cj). Only scripts/ and instruments/ import it and electron-builder excludes node_modules, so nothing ships — but the audit should read clean, and dependencies should mean shipped.'
type: task
status: todo
effort: S
epic: standards-pass-follow-ups
---


