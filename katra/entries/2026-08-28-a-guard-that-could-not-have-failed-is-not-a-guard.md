---
title: A guard that could not have failed is not a guard
date: "2026-08-28"
time: "12:51:49"
tags:
    - web
    - tests
    - honesty
hash: 1ecaf5c
stat:
    f: 5
    a: 370
    d: 14
summary: src/web/bridge.ts named a test that did not exist, for the claim the browser build rests on. Writing it was the easy half; the entry point and the mutation sweep were the part that decided whether it was worth anything.
---

`src/web/bridge.ts` closed its header with a sentence doing real work:

> `tests/engine/web-bridge.test.mjs` asserts the first of those in the source,
> because "we don't upload anything" is exactly the kind of claim that should
> not rest on someone remembering.

The claim above it — no fetch, no XHR, no WebSocket, no beacon — is the browser
build's entire pitch, and the page prints a footer inviting the reader to
falsify it. The file named there did not exist. Not a stale path to a renamed
test: nothing anywhere asserted the property in source.

That is worse than an unenforced claim, because the sentence tells the next
person to touch the bridge that they are covered. It is one layer up from a DEAD
GATE — nothing declares a threshold and fails to produce a metric, but a control
is cited, trusted, and absent.

## The entry point was the whole decision

The obvious move is to walk the import graph from `bridge.ts` and scan for
network primitives. It would have passed on the first run and every run after,
because `bridge.ts` imports exactly one thing and it is a `type`. A graph of one
file, a green suite, and a guard incapable of ever going red.

So the walk starts at `src/web/main.tsx`, which is what `index.html` actually
loads. That reaches 24 first-party files — 11 engine, 8 renderer, 3 shared, 2
web — including `vectorize.worker.ts`, where the image data really lives. The
worker is only in the graph because the resolver strips Vite's query suffix:
`engineClient.ts` reaches it through `'../workers/vectorize.worker?worker&inline'`,
and a resolver that treats that as an unresolvable specifier drops the single
most important file and stays quiet about it.

## It went red before it went green

The reach assertions justified themselves on the first run:

```
✖ the import graph reaches the code that handles the image
  src/web/bridge.ts is not in the graph — the resolver is broken
```

A real bug. Candidate paths were accepted with `existsSync`, which is true for a
directory sitting in front of the `.ts` file the specifier meant. Without an
assertion naming the files the graph must contain, that ships as a scanner
covering one file and reporting success forever.

Then the sweep. Each primitive appended to the worker in turn:

| probe | result |
|---|---|
| `await fetch("https://x.test/collect")` | red |
| `new XMLHttpRequest()` | red |
| `new WebSocket("wss://x.test")` | red |
| `new EventSource("/s")` | red |
| `navigator.sendBeacon("/c", d)` | red |
| `// we deliberately never fetch( anything here` | green |

The last row is not padding. The bridge's own header lists all five in prose, so
a detector that does not strip comments indicts the paragraph explaining the
rule — the same shape as `skill-doc.test.mjs` having to exempt
`--colours-please`, an illustrative flag it would otherwise read as a claim.
Comments are stripped conservatively, only block comments and whole-line ones. A
trailing `// fetch(` still trips it, and that is the correct direction to be
wrong in: a false positive costs a human ten seconds, a false negative costs the
guard.

## What it does not cover, said out loud

The window is first-party source under `src/`. React and react-dom are in the
bundle and are not scanned, and pretending otherwise would make this the second
overstated claim in the same file. What covers them is `connect-src 'none'` in
`index.html`, enforced by the browser against every script on the page whoever
wrote it. The header now says that, rather than naming a file and letting the
reader assume totality.

`w-web-offline.spec.ts` stays exactly as valuable as it was, and neither replaces
the other. It takes the page offline and traces an image anyway, which is
stronger evidence about one path and blind to a call on a branch it never walks.
Source-level and runtime, each covering the other's blind spot.

## Found while in the neighbourhood

`skill-doc.test.mjs` still asserted, in three places, that callers outside this
repo branch on the CLI exit codes. That report was retracted on 2026-08-27 — it
was a suggestion that such an extension *could* be built, not a shipped one. The
doc comment above the table had been corrected at the time. The assertion
messages underneath had not, so the retracted claim sat in the exact place
someone reads at the moment they are deciding whether a change is safe. Now
phrased conditionally: what *would* break a caller written against the table,
which is the true version and the one that supports the same conclusion.
