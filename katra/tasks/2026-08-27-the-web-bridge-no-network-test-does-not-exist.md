---
title: The web bridge cites a no-network test that does not exist
date: "2026-08-27"
time: "09:00:00"
tags:
    - web
    - tests
    - honesty
summary: src/web/bridge.ts says `tests/engine/web-bridge.test.mjs` asserts its no-fetch/no-XHR/no-beacon property in source. That file does not exist and nothing else asserts it in source. The strongest claim the browser build makes is currently unenforced.
type: task
status: todo
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
