---
title: The install that succeeded and could not start
date: "2026-08-25"
time: "18:11:46"
tags:
    - ergonomics
    - standards
    - distribution
hash: PENDING
stat:
    f: 0
    a: 0
    d: 0
---

The README wanted one line: `brew install craigjmidwinter/tap/getvect`. The tap
already had a formula, and the reasoning behind it is genuinely good — a
**formula, not a cask**, built from source, so nothing arrives as a downloaded
application bundle and Gatekeeper never fires. That is the one macOS install
path that solves quarantine without anybody buying an Apple certificate, and it
holds: zero `com.apple.quarantine` attributes in the Cellar, verified.

The line did not ship, because the install it documents could not start.

## What running it found that reading it could not

The formula pruned the binary it then execed:

- `electron` is a **devDependency** (`^43.3.0`) — electron-builder requires it
  there, and as a runtime dep it lands in the asar and breaks `npm run dist`.
- the formula ran `npm prune --omit=dev` after the build.
- `npm prune --omit=dev --dry-run` says it plainly: `remove electron 43.3.0`,
  one of 336.
- the launcher execs an absolute path into
  `libexec/node_modules/.bin/electron`.
- after a clean reinstall, that path did not exist.

So `brew install` succeeded, printed a caveat telling the user to run `getvect`,
and `getvect` died with *no such file or directory*. The formula's comment said
"electron itself is a runtime dep and stays". It isn't, and it didn't.

## The gate that could not go red

The test asserted `bin/getvect` is executable. That is true of a wrapper
pointing at nothing, so `brew test` was green on an install that could not
launch — a check that cannot fail for the reason it was written, which is the
DEAD GATE rule aimed squarely at this. The engine probe beside it proved
`vectorize` loads, which was also true and also not the question. Nobody had run
the binary.

## Fixed, and a second failure underneath the first

The steward took the fix into the tap (`homebrew-tap` 21da979): the prune is
gone, and the test now asserts the launcher's target exists, is executable, and
that its signature verifies. Removing the prune exposed a failure hiding behind
the first one — Electron ships an ad-hoc linker-signed bundle, Homebrew's copy
breaks the signature seal, and macOS SIGKILLs the app. It needs re-signing in
`post_install` rather than `install`, because Homebrew relocates the staged tree
afterwards and breaks the seal again; innermost-out, since `--deep` is
deprecated for signing and leaves nested frameworks invalid.

Verified here from a clean build, without launching anything headed:
`codesign --verify --deep --strict` passes, zero quarantine attributes, and
`ELECTRON_RUN_AS_NODE=1` execs the real binary to completion — a broken seal
SIGKILLs at exec whether or not a window is asked for, so that is a signature
proof that costs nobody their screen. `brew test` exits 0. The launcher chain
resolves end to end: bash wrapper, `cli.js` whose shebang pins Homebrew's node
absolutely rather than by PATH, then `Electron.app/Contents/MacOS/Electron`.

Now the README line ships, along with the `brew uninstall` counterpart — the
app's state directories are written on first launch, not by any installer, so
neither uninstaller knows about them.

**The reusable part:** a green suite and a successful install both described a
program that could not run. The only check that would have caught it is the one
nobody had performed — starting the thing.
