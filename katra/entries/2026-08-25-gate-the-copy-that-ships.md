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
