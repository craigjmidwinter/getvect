---
title: Freeze it for the caller who is not there yet
date: "2026-08-27"
time: "13:25:55"
tags:
    - cli
    - contract
    - docs
    - honesty
hashes:
    - 3243b65
    - 54b3b52
stat:
    f: 8
    a: 280
    d: 17
summary: A reported external dependency on exit 73 turned out not to exist. The contract got frozen anyway, for a better reason than the one that was retracted.
---

The CLI shipped with an exit table and a contract document written to be depended
on. Within a day a report came back that someone was depending on it: an
extension keying off exit `73` for collision, with `--force` as the escape hatch.

That report was wrong, and it was retracted the same day. Re-reading the comment,
the person was saying such an extension *could* be narrow now that the contract
is clean. It was a suggestion, not a shipped integration. Nothing outside this
repo branches on exit 73 today.

The retraction is the interesting part, because it arrived after the work was
already done. Four files had been edited to say an integration exists. That is a
worse defect than it looks: a false claim that someone depends on us is exactly
the kind of thing that gets cited later, in good faith, as a reason not to change
something. It does not fail loudly. It just quietly makes a decision for whoever
reads it next.

So all four were corrected, and the reasoning was rewritten rather than deleted:

> No outside caller is known to depend on these today. The reason to freeze them
> is not that someone would break: it is that nobody can build against a table
> that moves, so treating it as stable is what makes the integration possible in
> the first place.

The guard stayed, because the guard was right for a reason that never depended on
the false half.

## The guard was green in the direction that breaks a caller

`skill-doc.test.mjs` already checked the exit table against the source. It asked:
is every number the docs name a number the CLI can actually return? That catches
a stale document, which is the direction docs usually rot in.

It does not catch the direction that hurts a caller. Renumbering a code and
updating the docs in the same commit passes clean, because the two agree with
each other and the test only compares them to each other.

This was verified rather than assumed. `badInput` was moved from 65 to 68 across
the source and both documents, the shape a refactor with a doc regeneration
actually takes, and the suite went green on all five tests. Only `73` was pinned,
by a single hardcoded assertion that happened to name it.

The fix pins both tables by name, with the asymmetry the situation calls for:

| change | before | after |
|---|---|---|
| renumber 65 to 68, code and both docs | green | **red** |
| remove `traceFailed: 70` entirely | green | **red** |
| rename `--force` to `--overwrite` | green | **red** |
| *add* a new code and a new flag | green | green |

Adding is free and needs no edit. Renumbering or removing requires editing the
pinned list, which is the point: it cannot happen as a side effect of a refactor,
only as a decision, and the diff on that list is where the note goes.

Each of those four rows was run as a real mutation and reverted from backup, then
checked clean with an empty diffstat. A guard nobody has watched go red is a
guard nobody knows the shape of.

## Two other claims that were not true

Freezing the contract meant reading it closely, and reading it closely turned up
two more.

The site said the browser build had "every export format except PNG". It does
not. PNG export is pure canvas in the shared renderer, loaded through a `blob:`
URL so nothing taints, and `src/web/main.tsx` says plainly that the exporters are
imported unchanged: the same renderer, not a port. The web bridge lists exactly
two omissions, AI Enhance and the update channel. The PNG line had been written
from an assumption and never checked.

The page metadata also still described a "desktop vectorizer for macOS and
Windows", which is the copy that shows in search results and link previews. That
contradicted the browser button sitting in the hero.

## The front door says two destinations now

The hero had been restructured to give the browser build and the download equal
weight, and the reasoning had been written into the file rather than left in
someone's head, which is the only reason it survived a context clear.

The ruling that settled it corrects a fact rather than expressing a preference:
the browser version is not a try-before-you-download. Someone might want it on
their machine, and someone else might just want to run it in a tab. Two
destinations for the same person, not two stages of one journey.

The difference list is exactly two items, the command line and AI Enhance, and
Enhance is desktop only for one reason. A browser has nowhere safe to keep an API
key, and a key sitting in `localStorage` would be a defect we chose rather than a
feature we shipped. An earlier draft of that list had three items, having counted
in-place updates as an advantage. It is not one. A page is always current.
