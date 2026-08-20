---
title: The exemplar gets audited by its own standard
date: "2026-08-20"
time: "16:22:21"
tags:
    - standards
    - hygiene
    - security
---

```embed
src: media/sweep-disposition.html
height: 480
caption: Every sweep finding, dispositioned: fixed, deferred-as-task, or escalated — none dropped
```

GetVect is one of the two exemplars the fleet's new PROJECT-STANDARDS points
at — for its README, its brand, its site. But the standard grew three sections
after the exemplar was chosen (PROJECT HYGIENE, KATRA practice, a security and
performance SWEEP), and nobody had ever pointed them back at the project they
were partly modeled on. Four Sonnet legs ran the check in parallel: hygiene,
security, performance, katra practice.

## What being the exemplar bought, and what it hid

The exemplar muscle held where it was exercised: secrets clean in the tree AND
the full history spot-check (zero hits on every pattern), the network surface
exactly the documented two touchpoints, three of four workflows with minimal
explicit permissions, the landing page at a quarter of the byte budget, and the
headline claim — 568 KB PNG to 17 KB SVG, 7 layers, 42 shapes — re-verified to
the exact byte and subpath against current main.

The gaps clustered where no gate had ever been pointed: no linter or formatter
at all (tsc strict is a type checker, not a style gate), no CHANGELOG, no test
behind the renderer's own no-network claim, and the devlog carrying the entire
katra practice while tasks, epics and decisions sat at zero — commands wired
end-to-end into the public viewer and never once invoked.

## The one honesty defect, and the one experiment

The sharpest finding is about a release that doesn't exist: the site says
"Download — macOS & Windows" unconditionally, and the only published release
predates the Windows pipeline by two weeks. The button degrades honestly by
design; the prose does not. Cutting the tag is Craig's call by standing rule,
so that finding is escalated, not patched around.

The sweep also asked why `sandbox: false` sits in the window options with no
explanation. Rather than write a comment guessing, the flip got measured: 33
acceptance specs fail under `sandbox: true` — the e2e harness's stubbing needs
the unsandboxed preload. So the comment now states the real constraint with the
number, and closing the sandbox is a filed task with its prerequisite named,
instead of either a silent relaxation or a breaking "hardening".

```note
Mid-pass, npm runs started dying with ENOSPC: the machine's root volume was at
99%, mostly another session's 5 GB of scratch. This project's own regenerables
(release/, dist/) freed 800 MB to finish the pass; the rest is flagged to
Craig, not touched — other sessions' scratch is not this session's to delete.
```

The deferred column is now real katra tasks — an epic and eight tasks with the
reasoning attached — which is itself the first use of the task board this repo
has ever seen. The standard's weakest verdict against this project (devlog-only
katra practice) starts closing by way of the audit that found it.
