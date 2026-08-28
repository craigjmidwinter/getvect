---
title: The web bridge cites a no-network test that does not exist
date: "2026-08-27"
time: "09:00:00"
tags:
    - web
    - tests
    - honesty
summary: 'Done. The named test now exists and is armed: it walks the static import graph from src/web/main.tsx (24 files — engine, renderer, worker, bridge) and fails on fetch/XHR/WebSocket/EventSource/sendBeacon. All five were verified red by mutation in the worker; a comment naming them stays green. The bridge header now states the window instead of only naming the file.'
type: task
status: done
effort: S
---

## What is wrong

`src/web/bridge.ts` closes its header with:

> `tests/engine/web-bridge.test.mjs` asserts the first of those in the source,
> because "we don't upload anything" is exactly the kind of claim that should
> not rest on someone remembering.

There is no such file. `ls tests/engine/ | grep -i 'web\|bridge'` returns
nothing, and no other test asserts the property against the source.

## Why it matters more than a stale path

The claim it names — no fetch, no XHR, no WebSocket, no beacon — is the one the
browser version's entire pitch rests on, and the site invites the reader to
falsify it. A comment saying a test enforces it, where no test does, is the
signature failure this repo has a rule against: the evidence is asserted rather
than produced, and the next person to touch the bridge reads the comment and
believes they are covered.

It is not a DEAD GATE by the letter — nothing declares a threshold and fails to
produce a metric — but it is the same defect one layer up: a control that is
cited, trusted, and absent.

## What exists and is not a substitute

`tests/e2e/w-web-offline.spec.ts` exercises the property at runtime, offline.
That is a good check and it is not the one claimed: it proves the app behaves
offline in one traced path, not that the bridge source contains no network call
on any path. A `fetch` added behind a branch that test does not walk stays green.

## Fix

Either write the named test — a source-level assertion over `src/web/bridge.ts`
(and what it transitively pulls in) for `fetch`/`XMLHttpRequest`/`WebSocket`/
`sendBeacon` — or, if the runtime check is judged sufficient, change the comment
to name `w-web-offline.spec.ts` and state plainly what it does and does not
cover. Do not leave it pointing at a file that is not there.

Found while reconciling the hero restructure on 2026-08-27; not caused by it.


## Closed 2026-08-28 — the test was written, not the comment softened

The choice in "Fix" was between writing the named test and re-pointing the
comment at the runtime spec. The test was written, because the task's own
argument against the substitution holds: `w-web-offline.spec.ts` proves one
traced path, and a `fetch` behind a branch it does not walk stays green there.

**Entry point is `main.tsx`, not `bridge.ts`.** Walking from the bridge would
have produced a graph of one file — it imports exactly one thing and it is a
`type`. That guard could never have gone red, which is the already-satisfied
control wearing the costume of a passing test. `main.tsx` is what index.html
loads and it reaches 24 first-party files: 11 engine, 8 renderer, 3 shared, 2
web. The vectorize worker is in there only because the resolver strips the
`?worker&inline` suffix, and that is the file the image data actually passes
through.

**It was armed before it was trusted.** All five primitives were appended to
`src/renderer/workers/vectorize.worker.ts` one at a time and each turned the
suite red; a full-line comment naming `fetch(` stayed green, which is the
false-positive direction that matters because the bridge's own header lists all
five in prose. The reach assertions earned their place immediately — the first
run failed with *"src/web/bridge.ts is not in the graph"*, a real bug where
`existsSync` on a candidate path accepted a directory ahead of the `.ts` file.
Without that assertion the guard would have shipped scanning one file and
passing forever.

**The window is stated rather than implied.** First-party source under `src/`
only; react and react-dom are in the bundle and are not scanned. What covers
them is `connect-src 'none'`, and the comment now says so instead of letting a
reader assume the test is total.

Fixed in passing: `skill-doc.test.mjs` still asserted in three places that
outside callers branch on the exit codes — the claim retracted on 2026-08-27.
The doc comment above the table had been corrected; the assertion messages
underneath had not, so the retracted claim was still waiting to be read as a
reason not to change something. Now phrased conditionally.
