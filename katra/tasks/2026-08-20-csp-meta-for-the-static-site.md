---
title: CSP meta for the static site
date: "2026-08-20"
time: "16:32:13"
tags:
    - security
    - site
summary: No CSP on site/ pages. Static GitHub Pages with one API fetch (download.js -> api.github.com) and Google Fonts on /devlog/ — a meta CSP is cheap hardening but needs those two allowances tested before shipping.
type: task
status: todo
effort: S
epic: standards-pass-follow-ups
---



## A third allowance, added 2026-08-25 — do not close this without it

All three destination pages now load self-hosted Umami:

```
https://umami.midwinter.dev/script.js
```

A CSP that ships without `umami.midwinter.dev` in **both** `script-src` and
`connect-src` turns analytics off. `script-src` alone is not enough — the script
loads and then silently fails to POST.

This is the dead-gate pattern with a delay fuse: someone closes a security task
correctly, every page still renders, nothing errors in CI, and the only symptom
is a chart that stops growing on a date nobody connects to this commit. Test the
allowance against a real page load before shipping the meta tag, the same way
the two existing allowances (api.github.com, Google Fonts) have to be.
