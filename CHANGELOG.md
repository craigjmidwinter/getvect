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
