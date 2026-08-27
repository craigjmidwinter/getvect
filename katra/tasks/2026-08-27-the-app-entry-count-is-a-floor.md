---
title: The /app/ entry count is a floor, and nobody has written that down
date: "2026-08-27"
time: "14:12:00"
tags:
    - analytics
    - honesty
summary: 96 visitors, 127 pageviews, 2 open-web-app clicks. The click is counted from the marketing page only, so direct and README arrivals to /app/ are invisible. The 2 is a lower bound and must never be read as a conversion rate.
type: task
status: todo
effort: S
---

## The number, and what it is not

First real traffic, 2026-08-27, from a Reddit post:

| measure | value |
|---|---|
| visitors (marketing site) | 96 |
| pageviews | 127 |
| referred from Reddit | 34 |
| `open-web-app` clicks | **2** |
| people who finished a vectorise | **unknown, and uncollectable** |

**2 is a floor, not a conversion rate.** The click event fires from
`site/index.html` only. Every other route into the browser build is invisible to
it:

- the direct link, `getvect.midwinter.io/app/`, typed or shared
- the README's own **Use it in your browser** link, which points straight at
  `/app/` and never touches the instrumented page
- any link anyone else posts

So the true entry count is 2 plus an unknown number, and the shape of that
unknown is exactly the audience most likely to arrive from a link rather than
from the front page.

## Why write down a number that makes us look bad

Because the uncomfortable version is the one that gets misread later. A `2` sitting
in a dashboard next to `96` reads as a 2% click-through, and somebody will
eventually quote it that way in a decision about whether the browser build is
worth keeping. It is not a rate. It is a partial count of one of several doors,
and the denominator does not belong to it.

This is the same failure the harness rules already guard against in the engine:
*a rate measured over a short boundary is not a defect, state the window of every
measurement.* The window here is "clicks originating on the marketing page", and
it has never been stated anywhere a reader would find it.

## Not fixable by instrumenting /app/

That was considered on 2026-08-27 and deliberately declined: the browser build
ships `connect-src 'none'` and prints a footer inviting the reader to verify that
it cannot make a network request. Tagging it would make that claim false in front
of the audience most likely to check. The blind spot is the accepted price of the
guarantee, not an outstanding bug.

## What to do

- State the floor in [[analytics-decisions-live-only-in-a-script-comment]] when
  that file is written, with the routes it cannot see enumerated.
- Consider whether the README link should carry a distinguishable path or
  fragment, so at least README arrivals become countable without touching the
  `/app/` CSP at all. That would shrink the unknown without costing the
  guarantee, and it is the only lever here that does not.
