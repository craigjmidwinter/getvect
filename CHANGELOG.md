# Changelog

All notable changes, written for the person using GetVect — what changed for
you, not what changed in the diff. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver as honestly as a pre-1.0 project can.

The committed dev log (`katra/entries/`, published at
[getvect.midwinter.io/devlog](https://getvect.midwinter.io/devlog/)) is the
detailed record of *why* things changed; this file is the short answer to
"what do I get if I update".

## [Unreleased]

Nothing yet.

## [0.1.7] — 2026-08-27

**The command line will not overwrite an existing file.** Writing to a path that
is already there now exits `73` and writes nothing; pass `--force` to replace it.
That includes the default output name, so `getvect logo.png` refuses when
`logo.svg` exists — and the file at risk there is one you never named.

Before this, it replaced the file silently and exited `0`, which a caller had no
way to detect.

`--stats` can no longer be combined with `-`. Both write to stdout, and the JSON
was being appended to the document, producing a corrupt file from
`getvect logo.png - --stats > logo.svg`. The combination now exits `64`.

**Two new documents.** [`docs/CLI.md`](docs/CLI.md) is the full contract — every
flag with its range and default, every exit code, what goes to stdout versus
stderr, and the failure modes a caller must handle. [`SKILL.md`](SKILL.md) is the
same contract written for an agent.

Also in this release: **GetVect runs in a browser** at
[getvect.midwinter.io/app](https://getvect.midwinter.io/app/), the packaged app
answers command-line arguments without opening a window, and the app header
carries the real wordmark.

## [0.1.6] — 2026-08-26

**GetVect has a command line.** The same engine, without the window — for a
caller that is not a person:

```bash
node bin/getvect.mjs logo.png            # -> logo.svg
node bin/getvect.mjs shot.jpg -f dxf -c 16 -p photo
node bin/getvect.mjs logo.png - > logo.svg
```

Every setting the app exposes is a flag, output format follows the extension
(svg, eps, dxf, pdf, png), and the trace is byte-identical to what the app
produces from the same file. stdout stays empty unless you ask for `--stats`,
every failure exits non-zero with one line on stderr, and it never prompts,
opens a window, touches a keychain or reaches the network.

Run it by path from a clone. The packaged app does not carry the CLI yet.

## [0.1.5] — 2026-08-26

**GetVect now ships the licence texts of the software it includes.** Every build
before this one carried none — not one file, not even Electron's own. MIT, BSD
and Apache-2.0 all require their notice and licence text to accompany the
software, so this was a real gap, and an awkward one for a project whose whole
pitch is being open source.

The notice covers the 22 packages whose code is actually inside the app, each
licence reproduced in full, plus Electron's own licence and Chromium's. It is
generated from what the bundlers included rather than written by hand, so it
cannot drift from the code it describes. Find it under **Help ▸ Third-Party
Licences**, or beside About on macOS.

The About panel now also says **MIT Licensed** next to the copyright, which it
should have said all along.

## [0.1.4] — 2026-08-26

**GetVect can now update itself on macOS.** Because the build is signed, the app
can verify a new version before applying it. It downloads in the background and
then offers **Restart** — choosing it swaps the app and reopens on the new
version. Nothing is installed behind your back. Windows still shows a banner
with a link and does
not install, because without a code-signing certificate the install step cannot
be verified — an updater that pulls 117 MB and then fails is worse than none.

Either way it stays one check per launch, sends no identifier, and
`GETVECT_NO_UPDATE_CHECK=1` switches it off before any request is made.

Nothing else changed. This version exists to be a target: an updater cannot be
tested without something to update *to*.

## [0.1.3] — 2026-08-26

**The macOS build is signed and notarized.** It opens with no Gatekeeper
warning, no right-click dance and no `xattr` incantation. The notarization
ticket is stapled, so the check works offline. You do not have to take that on
trust:

```bash
spctl -a -t install -vv GetVect-0.1.3-arm64.dmg   # accepted / source=Notarized Developer ID
codesign -dvvv /Applications/GetVect.app          # TeamIdentifier=6UV93L24YL
```

**Windows is still unsigned** and SmartScreen still warns: choose **More info**,
then **Run anyway**. The installer is per-user and never asks for administrator
rights.

## [0.1.1] — 2026-08-20

First release with a Windows build.

### Added
- **Windows support, end to end.** This tag builds a Windows x64 installer
  (`GetVect-0.1.1-x64.exe`) from the same workflow as the macOS build, with
  its own update feed (`latest.yml`). The engine's 80 contracts pass on
  Windows; the installer has been verified on a real machine — silent install,
  per-user, no administrator rights — and the site's download button resolves
  per-OS. Unsigned, so SmartScreen will ask you to confirm (More info → Run
  anyway).
- The public dev log: 21 entries from the build, at `/devlog/` on the site.

### Changed
- The curve fitter no longer produces multi-thousand-pixel control handles on
  short chords ("balloons") — 367 corpus-wide occurrences fixed to zero, with
  the bound gated in CI. Sharp corners are unaffected (0 of 26 moved).
- Demo and site assets regenerated with the fixed engine.

### Fixed
- `npm ci` works on Windows (the postinstall de-quarantine step is now
  macOS-only instead of failing every other platform).
- Engine tests run identically on every OS and Node version (test discovery
  moved out of shell-glob territory).

## [0.1.0] — 2026-08-05

First public release.

- macOS (Apple Silicon) app: drop in a PNG, JPEG or BMP; get SVG, EPS, DXF,
  PDF or PNG out. Deterministic engine — same image + same settings =
  byte-identical output.
- 4 presets, 7 detail levels, palette control (1–18 colours plus a custom
  palette editor), per-colour disable, Smart anti-aliasing, DXF spline/polyline
  variants.
- Optional AI Enhance via your own Gemini API key, encrypted at rest; the app
  otherwise makes exactly one kind of network request (the release feed, once
  per launch, and only to tell you — unsigned builds do not self-update).
- Unsigned: macOS quarantines it on first launch (right-click → Open, or
  `xattr -dr com.apple.quarantine /Applications/GetVect.app`).

[Unreleased]: https://github.com/craigjmidwinter/getvect/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/craigjmidwinter/getvect/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/craigjmidwinter/getvect/releases/tag/v0.1.0
