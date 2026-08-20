---
title: Path-validate the file:read IPC handler
date: "2026-08-20"
time: "16:32:12"
tags:
    - security
summary: src/main/main.ts file:read reads any path the renderer hands it. Only picker-derived paths reach it today and contextIsolation holds the line; an allowlist (picker-session paths only) is cheap defense-in-depth.
type: task
status: todo
effort: S
epic: standards-pass-follow-ups
---


