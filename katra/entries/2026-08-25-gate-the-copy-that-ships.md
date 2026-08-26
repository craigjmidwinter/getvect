---
publish: true
title: Gate the copy that ships
date: "2026-08-25"
time: "18:55:58"
tags:
    - site
    - standards
hash: ac042aa
stat:
    f: 1
    a: 85
    d: 0
---

Two findings, both arrived at by checking the deployed page instead of the thing
that produces it. Neither would have been visible from the source.

## The devlog had no social card

A fleet audit turned up three sites that declare `og:image` in source, emit it in
their local builds, and serve none of it. That prompted checking getvect's live
pages rather than its files. Index and docs serve five social meta tags each. The
devlog served zero.

katra renders that page as `<title>Katra</title>` with no `og:` tags at all —
`app.js` sets the real title client-side from `data.json`, which is too late for
a link preview, because no scraper runs it. So every shared devlog link previewed
as **"Katra", grey box, no description**: on the page katra's own attribution
footer exists to drive readers to, and the page whose referral numbers the
analytics tag was installed to measure. Both halves of that pointed at a link
that previewed as somebody else's product name.

Fixed by adding `og:title` and friends rather than rewriting the generated
`<title>`: **supplement the renderer, do not fight it.** Rewriting generated
markup starts a diff war with the next build; adding the tag the platform
actually reads does not.

Deliberately no `og:image:width`/`height` there. index.html and docs.html declare
those and pay for it with a gated claim; the devlog file is injected and sits
outside that gate, so declaring the numbers would be an ungated copy of a value
that can change. **Refusing to add a true statement because nothing would notice
it going false is harder than adding it**, and correct.

## The gate was on the copy nobody visits

The tag, the disclosure and the card are injected by a committed script wired
into `devlog-gate.mjs --build`. That protects the build — and the build is not
what ships. `--build` writes to `artifacts/devlog/site` and explicitly does not
deploy; `site/devlog/` is that output copied across by hand at publish time.

So the artifact visitors actually receive was the one with no check on it.
Rebuild the devlog, move it over without running the injector, and all three
insertions vanish from a page that still renders perfectly. That is the failure
the script was written to prevent, surviving one level up from where it was
fixed — and it was invisible precisely because the injector worked and had been
watched working.

`--check` now asserts all three in the committed snapshot, and CI runs it.

**Gate the copy that ships, not the step that produces it.**

Two smaller rules fell out of proving it:

- **Fault each assertion independently, never as one combined case.** A check
  that only fires when all three are missing passes a snapshot that lost one,
  which is the likelier accident by a wide margin.
- **Confirm the step executed rather than reading the green tick.** A passing run
  containing a step that silently did not run is the original defect wearing the
  result you wanted.

## Why the errors all pointed one way

Across two sessions today, five measurements were taken from the wrong copy —
a build directory, a dirty working tree, a config file, page source, `pmset -g
custom`. Every one produced **false innocence**. Not one invented a defect that
was not there.

That is structural rather than luck. Every copy except the deployed one records
what somebody *meant*: build output holds the intent of the last build, a dirty
tree the intent of the current afternoon, a config file the intent of whoever
wrote it. Intent is always cleaner than reality, because reality is what happened
to the intent afterwards.

So the scepticism has one correct address rather than being spread evenly:
**the moment a re-measurement clears something that was previously flagged.**

## Postscript, four hours later: the hypothetical was not one

The section above describes a failure that had not happened — rebuild the devlog,
copy it across without the injector, lose all four insertions from a page that
still renders. Written as a risk worth gating.

Publishing this entry is what exercised it. The steward decided to ship today's
three entries, which meant the first real `katra build` since any of this was
wired, and the injector reported what it had to put back:

```
devlog-analytics: added social card + icon links + tag + disclosure
```

**A fresh build emits `index.html` with none of the four.** Not a degraded
version — none. So the original plan, hand-editing the snapshot, would have had
this publish silently delete the analytics tag, the disclosure, the social card
and the icon links from the devlog, on the day a Reddit thread points at it. The
pages would have rendered perfectly and the numbers would simply have stopped.

Two things worth keeping, neither of which was predictable this afternoon.

**The interval was four hours.** A "hypothetical" failure in generated output is
usually one that has not been rebuilt yet. The rebuild is the event, and its
timing has nothing to do with when the risk was introduced — so the gap between
writing a risk down and meeting it is not a measure of how unlikely it was.

**The person who would have hit it is not the person who could have recognised
it.** Four hours is long enough for whoever wrote the injector to have moved on,
and short enough that nobody would think to suspect a routine publish. It would
have surfaced as a flat chart on launch day and been read as *nobody clicked
through* — a wrong answer to a question nobody knew they were asking.

The belt-and-braces that made the publish safe, since a publish replaces a whole
tree: diff the build's file list against the snapshot so nothing is dropped or
orphaned, confirm each insertion in the build output, and check that **a fresh
build plus the injector reproduces the committed file**. The last one is the one
worth copying — it proves the step is deterministic rather than that it worked
once, and an injector that succeeds unpredictably passes every other check.
