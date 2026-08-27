---
title: docs/ANALYTICS.md is cited as the authority and does not exist
date: "2026-08-27"
time: "14:10:00"
tags:
    - analytics
    - docs
    - honesty
summary: Two places cite docs/ANALYTICS.md as the record for why /app/ is deliberately unmeasured. The file does not exist, so the rationale for a deliberate decision lives only in a comment inside check-analytics-coverage.mjs, where the next reader will not find it and will re-litigate it.
type: task
status: todo
effort: S
---

## The gap

`docs/ANALYTICS.md` is referenced twice as the place the reasoning lives:

- `scripts/check-analytics-coverage.mjs`, in the `/app/` exemption: *"That
  undercount is a known, accepted limit — see docs/ANALYTICS.md."*
- `site/index.html`, in the callout comment: *"this page carries the analytics
  tag, /app/ does not and cannot — see docs/ANALYTICS.md."*

`ls docs/ANALYTICS.md` fails. Same class of defect as the web bridge citing a
test that does not exist: a claim that the reasoning is written down somewhere,
where it is not.

## Why it is worth more than a broken link

The decision it points at is a good one and a non-obvious one: the browser build
is deliberately unmeasured because instrumenting it would require opening
`connect-src`, and the page prints a footer inviting the reader to verify that it
*cannot* make a network request. That is a real trade, deliberately taken.

A decision whose rationale lives only in a comment inside a script is a decision
that gets re-litigated by whoever reads the script next and does not find the
reasoning. It nearly was on 2026-08-27: the absence of a tag on `/app/` was
reported as an oversight rather than a choice, and the only thing that stopped it
being "fixed" was that the exemption happened to spell out its reasoning inline.
The next reader may not be so lucky, and the failure mode is silent, because
adding the tag looks like completing an unfinished job.

## What it should contain

- What is collected, on which surfaces, and by whom (Umami, self-hosted).
- Why `/app/` is exempt, and what that costs: the entry click is counted from
  `site/index.html`, so direct and README arrivals are invisible. See
  [[the-app-entry-count-is-a-floor]].
- What would have to change to instrument `/app/`, so a future decision to do it
  is made with the full price visible: CSP allowlist, the footer claim, the
  README passage, the site callout, the coverage exemption, and the offline e2e
  spec.
- The rule the exemption already encodes: a new published surface either carries
  the tag or is added to `EXEMPT` with a reason.

Publishing it is also the honest move for a project whose pitch is that it does
not collect things: saying plainly what it does collect is stronger than saying
little.
