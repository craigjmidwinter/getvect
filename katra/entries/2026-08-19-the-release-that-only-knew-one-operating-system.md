---
title: The release that only knew one operating system
date: "2026-08-19"
time: "15:01:33"
tags:
    - release
    - ci
---

The engine has been fine on Windows for a while. We just proved it: 80 of 80
engine contracts green on a real Windows box, the same 80 that gate every macOS
release. Determinism, palette semantics, SVG/EPS/DXF/PDF structure, alpha — all
of it, on a machine nobody develops on.

Nobody could install it. The thing standing between that green suite and a
Windows user was one word in `package.json`:

```
"postinstall": "node node_modules/electron/install.js && xattr -cr ..."
```

`xattr` is macOS. It does not exist on Windows, `npm ci` runs `postinstall`, and
so every install on Windows died before Electron was even unpacked. A
cross-platform app whose dependency install is macOS-only is a macOS app with
extra source files.

## The workaround that worked, and why it is not the fix

Getting the suite to run on that box took `npm ci --ignore-scripts`. It works,
and it is exactly the wrong thing to put in a workflow — because the script it
ignores is not only the `xattr` call. It is also `node
node_modules/electron/install.js`, which is what downloads and unpacks Electron
itself. Skip that and the tests still pass (they are pure Node), the packaging
step then has no Electron to package, and the failure surfaces two minutes later
wearing a completely unrelated face.

So the guard goes where the platform-specific thing is, not around the whole
script:

```
node -e "if (process.platform === 'darwin') require('child_process').execFileSync('xattr', [...])"
```

macOS gets the identical de-quarantine it has always had. Windows runs a `node
-e` that evaluates to nothing. The trailing `|| true` became `|| exit 0` for the
same reason the guard exists at all — `true` is not a command on Windows either,
and `cmd.exe` would have turned a tolerated failure into a hard one.

## Where the draft gets opened, which turned out to be the whole design

Two build jobs uploading into one GitHub release is the shape of a bug this repo
has already shipped once. The v0.1.0 attempt ended with **two draft releases**
sharing a tag — the dmg and `latest-mac.yml` in one, a lone blockmap in the
other — because electron-builder runs one publisher per target, each looked for
a release by tag, each found none, and each made one. GitHub permits that: a
draft has no tag to collide on until it is published. The fix was to open the
draft first, in the workflow, so every publisher finds it instead of creating it.

Adding a second runner puts that race back on the table with a bigger surface.
Three options, and the two that lost are the interesting ones:

**Duplicate the draft-creation step in both jobs.** This is the smallest diff and
it reintroduces the original bug precisely — two machines, both running `gh
release view`, both getting nothing, both creating a draft. The idempotence check
already in that step (`if gh release view ... else create`) reads like it handles
this, and it does not: it is not atomic across two runners.

**Make `windows` depend on `mac`.** Safe, and it costs fifteen minutes of wall
clock on every release to serialise two builds that share nothing. Worse, it
makes a macOS failure present as "Windows never ran", which is the kind of
misattribution that gets debugged on the wrong machine.

What shipped is a `draft` job both builds wait on. It is ten lines and a
`needs:`, and it makes "exactly one release exists before either packager
starts" a property of the graph rather than a property of hoping.

```embed
src: media/release-graph.html
height: 400
caption: One tag, four jobs. The draft is opened once, both runners upload into it, and the release only goes public after the box on the right counts five artefacts.
```

The un-drafting moved for the same reason. It used to be the mac job's last step;
now it is a fourth job with `needs: [mac, windows]`. The window it closes is real
and got wider with the second runner: the mac job can be entirely finished while
Windows is still packaging, and a release that went public in that gap is one the
site's Download button resolves to while half its assets do not exist yet.

That job now counts five artefacts, not three. The two new ones are the exe and
**`latest.yml`** — and the second is the one worth checking for, because
electron-updater picks its feed file by platform. A release carrying
`latest-mac.yml` and no `latest.yml` is a release every Windows installation is
permanently blind to, and it looks completely correct on the releases page.

## The proof lever that does not cut a release

The Windows job runs on a `v*` tag, which is the single worst moment to discover
that Windows stopped building, and a pushed tag is not something you can take
back. So there is a second workflow, `win-smoke.yml`: `workflow_dispatch` only,
the same steps, `--publish never`, and the installer comes back as a workflow
artefact. Its token is `contents: read`, which is a better guarantee that it
cannot touch a release than a missing `--publish` flag is.

It guards one specific thing that nothing else tests: that `npm ci` works on
Windows. That is a claim about a `process.platform` check in a JSON string, and
the only machine that can falsify it is a Windows runner.

## The site had to stop assuming

`download.js` resolves the Download button through the GitHub API rather than
hard-coding a URL, because artefact names carry their version and a dmg in a
Downloads folder should say which GetVect it is. It was matching `/\.dmg$/`
unconditionally. It now picks the pattern by OS — `userAgentData.platform`
first, `platform` and the UA string as the fallback — and rewrites the label,
the size line and a secondary link to the other platform.

The nice part is that the failure design did not need touching. A release with
no `.exe` on it is, from the browser's point of view, indistinguishable from a
rate-limited API: neither resolves, and both leave the `releases/latest` link the
markup shipped with. Which is why the markup's own copy had to change from
"Download for macOS" to "Download — macOS & Windows". The fallback is what a
visitor sees when JavaScript is off, when the API is throttled, **and** right
now, on every Windows machine, because the current latest release predates all of
this and carries no exe at all. It has to be true for all three.

```note
The Windows copy on the site says what SmartScreen will say — "Windows protected
your PC", More info, Run anyway — and that the installer is per-user and never
asks for administrator rights. That last part is a claim about nsis defaults, and
it is the reason the nsis block was left at its defaults rather than configured:
an unsigned installer demanding elevation is the exact shape of the thing people
are correctly told not to run.
```
