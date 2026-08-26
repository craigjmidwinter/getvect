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
