<div align="center">

<img src="docs/assets/frankie-mascot.png" alt="Frankie, the GetVect mascot" width="220">

<img src="docs/assets/getvect-wordmark.svg" alt="GetVect" width="420">

<br>

**Raster → vector, on your machine.**

Drop in a PNG, JPEG or BMP. Get back SVG, EPS, DXF, PDF or PNG.
No account, no credits, no subscription. Offline by default.

[![CI](https://github.com/craigjmidwinter/getvect/actions/workflows/ci.yml/badge.svg)](https://github.com/craigjmidwinter/getvect/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Platform: macOS | Windows | Browser](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Browser-lightgrey)

**[Try it in your browser](https://getvect.midwinter.io/app/)** — no install, no
account, and after the page loads it runs entirely on your machine.
**[Download the app](https://github.com/craigjmidwinter/getvect/releases/latest)** for
the command-line tracer, AI Enhance and in-place updates.

</div>

---

Every good online vectorizer wants your image on their server and your card on file — a
credit per conversion, a watermark until you pay, a queue when they're busy. GetVect is
the same job as a desktop app: a local Electron program with an offline tracing engine,
a full control surface for palette / detail / smoothing / speck removal, and native
save dialogs. There is no per-image cost and nothing to sign up for.

**Ingest, tracing, preview and every export run offline**, with the renderer under a
`default-src 'self'` CSP and no network calls at all. There are exactly **two network
touchpoints, both in your control**, and they are worth naming rather than burying:
optional [AI Enhance](#ai-enhance-optional-bring-your-own-key), and a once-per-launch
update check against GitHub Releases (disable with `GETVECT_NO_UPDATE_CHECK=1`). AI
Enhance ships off, needs a key you supply, and sends the image you are working on to
Google under that key. The update check asks one question — is there a newer GetVect —
sends no identifier, and fails silently when you are offline. Nothing else, ever, leaves
the machine.

**The browser version is counted separately, on purpose.** A page is fetched over the
network by definition, so "exactly two touchpoints" is a sentence about the desktop app
and does not transfer verbatim. What is true there:
[getvect.midwinter.io/app](https://getvect.midwinter.io/app/) downloads once and then
runs entirely on your machine — load it, turn off your wifi, and it keeps tracing. It is
served with `connect-src 'none'`, so the browser *refuses* a network request rather than
the code merely not making one. It has no AI Enhance and no update check: a page is
always current, and a browser has nowhere safe to keep an API key.

The quality bar is explicit and measured. A 21-fixture harness scores every trace on
colour error, SSIM, ink recall, boundary geometry and document structure, and gates it —
including on **public-domain artwork nobody here drew** (`fixtures/third-party/`, licences
recorded next to the files), because a bar anchored only on pictures we made ourselves can
only ever agree with us. See [`docs/HARNESS.md`](docs/HARNESS.md).

## Before / after

![Frankie the cat: 568 KB PNG at 200% zoom next to the 17 KB SVG GetVect traced from it](docs/assets/frankie-before-after.png)

Frankie is our mascot and our demo fixture. Traced at 8 colours with Smart anti-aliasing,
a 568 KB raster becomes a **17 KB SVG in 7 colour layers and 42 shapes** — curve-fitted
outlines, transparent background preserved, and infinitely re-scalable. The full output is
[`docs/assets/frankie-vector.svg`](docs/assets/frankie-vector.svg) and the source is in
[`fixtures/reference/`](fixtures/reference/).

Frankie is ours, though, so he is shown here and gates nothing: a picture we drew cannot
tell an improvement from a change tuned to it. The bars live on artwork we did not draw
and on fixtures generated from equations — see
[`docs/HARNESS.md`](docs/HARNESS.md#who-is-allowed-to-decide-that-a-change-is-an-improvement).

## The app

![Side-by-side view: the noisy source raster on the left, the cleaned vector result on the right, with the full settings surface below](docs/assets/screenshot-side-by-side.png)

<details>
<summary>More screenshots</summary>

Synchronised zoom across both panes — the speckle on the left is gone from the trace on
the right, and the edges stay crisp at any magnification:

![Zoomed in on both panes; source speckle vs clean vector edges](docs/assets/screenshot-zoom-sync.png)

Candidate palettes at eleven fixed sizes, plus a palette editor that can recolour, merge
and remove individual swatches:

![Input palette panel with candidate palette sizes and the swatch editor](docs/assets/screenshot-palette.png)

</details>

## What it does

Grounded in [REFERENCE.md](./REFERENCE.md), which is the spec the whole project is graded
against. Every item below has an acceptance spec in [`tests/e2e/`](tests/e2e/).

**Ingest** — drag-and-drop or file picker; PNG, JPEG and BMP; unsupported files rejected
with a real message; multiple images in a sidebar you can switch between.

**Vectorization** — auto-traces on load with visible progress, off the UI thread.
- Four model presets: **Clipart** (with seven detail levels), **Photo**, **Sketch**
  (grayscale), **Drawing** (black/white with a luminance threshold).
- **Input palette**: auto-generated candidate palettes at 1–18 colours as selectable rows,
  plus a custom palette editor (change a colour, merge two, remove one).
- **Output colour groups**: per-colour disable — switch off the background colour and you
  get a transparent background — with a merge threshold and sort order.
- **Quality**: Enhance (denoise + colour simplification), Noise Reduction off/low/high,
  Anti-aliasing off/smart/mid — Smart is the default. When it landed (August 2026) it
  measured 1747 sub-paths → 551 and 396 KB → 140 KB on the then gold-standard artwork;
  that artwork has since been removed for licensing, so the number is a record, not a
  re-runnable benchmark. What stays gated on every run is what Smart AA must not cost:
  sharp corners and curve quality (`tests/engine/sharp-corners.test.mjs`, the
  `minCurveCommandRatio` bars in `fixtures/manifest.json`).
- **Advanced**: Roundness (3 curve-fitting levels), Minimum Area (0/5/90 px² speck
  removal), Overlap, Circle Detection.
- **Result style**: filled layers or stroked layers.

**Preview** — original/vector toggle and side-by-side, zoom in/out/fit and pan
synchronised across both panes. The preview *is* the SVG that gets exported, not a
re-render of it.

**Export** — SVG, EPS, DXF, PDF and PNG through the native save dialog, with per-colour
`<g fill="rgb(...)">` layers in the SVG so the result drops into Illustrator or Inkscape
as editable colour groups. The DXF keeps its curves: every fitted cubic travels as a
degree-3 `SPLINE`, so a CAD or cutter file is a drawing rather than a point cloud — and
the **Splines / Lines** picker beside the DXF button flattens it to R12 POLYLINE for the
older CAD and cutter firmware that cannot read a spline at all.

## AI Enhance (optional, bring your own key)

Off by default, and the only thing in GetVect that can touch the network.

An "enhance" step that actually helps shaded artwork is not a filter at all: it is a
generative image-to-image **re-illustration** — background removed, soft shading flattened
into bands, outlines regularized — after which the tracer is tracing already-flat art. No
amount of median filtering reproduces it. GetVect can do that step by asking an image model
for it: paste your own Google Gemini API key, switch AI Enhance on, and the enhanced image
becomes the working image the engine traces, at the model's own resolution. One call, ~8s
on a 1024px source in our measurements.

**The trade, stated plainly.** With AI Enhance on, *that image is uploaded to Google* under
your own API key and their terms — which is exactly the thing the rest of this app exists
to avoid. Nothing else changes: no other image, no other feature, no telemetry, and the
switch is off until you turn it on. The key is encrypted at rest with Electron's
`safeStorage` (Keychain on macOS) inside the app's data directory, lives only in the main
process, and is never returned to the UI — the interface can save one, clear one, and ask
whether one exists. If the OS has no keystore available, GetVect refuses to store the key
rather than writing it in the clear. If a run fails — bad key, no network, 60s timeout — the
un-enhanced image is traced instead and the app says why.

The fully-local version of this (background removal, then an on-device generative flatten,
with nothing leaving the machine) is the plan of record:
**[issue #1](https://github.com/craigjmidwinter/getvect/issues/1)**. The provider layer was
written for it — a local backend is meant to arrive as one more `EnhanceProvider`, not as a
second pipeline.

**Not built** (REFERENCE section E, deliberately out of scope for now): isometric layer
view, crop, pixel editing, gradient detection, drag-to-regroup colour circles, Android
VectorDrawable / STL / GCODE export, ZIP variants. Accounts, credits and a web API are
out of scope permanently — that's the point.

## Download

**[Latest release →](https://github.com/craigjmidwinter/getvect/releases/latest)** — macOS
on Apple Silicon (M1 and later): grab `GetVect-<version>-arm64.dmg`. Windows on x64 (since
v0.1.1): grab `GetVect-<version>-x64.exe` — one click, per-user, never asks for
administrator rights. Both come off the same tag and carry the same 80 engine contracts,
run on each platform before packaging. Intel Macs and Linux build from source (below) but
are not tested and not published, so they are not offered as if they were.

**On macOS it just opens.** Since v0.1.3 the dmg is signed with an Apple Developer ID and
notarized by Apple, with the ticket stapled, so there is no quarantine warning and no
right-click dance — see [Code signing policy](#code-signing-policy) for how to check that
yourself. **On Windows** there is still no certificate, so SmartScreen says "Windows
protected your PC" — choose **More info**, then **Run anyway**.

### Code signing policy

**macOS** — signed with an Apple Developer ID and notarized by Apple since **v0.1.3**, with
the ticket stapled so the check works offline. Nothing you have to take on trust:

```bash
spctl -a -t install -vv GetVect-0.1.3-arm64.dmg   # accepted / source=Notarized Developer ID
codesign -dvvv /Applications/GetVect.app          # TeamIdentifier=6UV93L24YL
```

The release pipeline enforces it: an artefact that is not signed, Gatekeeper-accepted and
stapled cannot be published, and the last check runs against the asset re-downloaded from
the published release ([SIGNING.md](./SIGNING.md)).

**Windows** — still unsigned. There is no Authenticode certificate, and SmartScreen will
warn on first launch.

**Roles.** Committers and reviewers: Craig Midwinter. Approvers: Craig Midwinter. GetVect is
a single-maintainer project; releases are cut from tags by
[a workflow](.github/workflows/release.yml) that refuses to publish an artefact it cannot
verify.

**Privacy policy.** [What GetVect does on the network](#what-it-does-on-the-network): two
touchpoints, both disclosed — a once-per-launch update check against GitHub Releases
(opt-out via `GETVECT_NO_UPDATE_CHECK=1`) and opt-in AI Enhance under your own API key.
Nothing else leaves the machine.

### Homebrew — macOS, built on your own machine

```bash
brew install craigjmidwinter/tap/getvect
getvect
```

This is a **formula, not a cask**: it builds from source on your machine, so nothing
arrives as a downloaded application bundle at all. That is a different guarantee from the
signed `.dmg` — not a stronger or weaker one. The dmg is something Apple has checked and
vouched for; the formula is something you compiled yourself and never had to trust anyone
about. Pick whichever of those you find more convincing.

The trade is time and a toolchain — Homebrew pulls in Node, then runs an `npm install` and
a full build, so budget a few minutes rather than the seconds a `.dmg` takes. It also
cannot live in homebrew-core: core does not accept GUI/Electron applications as formulas,
and a core *cask* would reintroduce the quarantine this is here to avoid.

### Uninstall

What GetVect puts on your machine, and how to take all of it off again:

**macOS** — drag `GetVect.app` out of Applications, then remove the state the app
created if you want a clean slate:

```bash
rm -rf ~/Library/Application\ Support/GetVect   # settings + the encrypted AI key, if you saved one
rm -rf ~/Library/Caches/getvect-updater         # update-check cache
```

Installed with Homebrew instead? `brew uninstall getvect` takes the build and the launcher.
The two lines above still apply — that state is written by the app on first launch, not by
the installer, so no uninstaller of either kind knows about it.

**Windows** — Settings → Apps → GetVect → Uninstall (or run `Uninstall GetVect.exe`
from `%LOCALAPPDATA%\Programs\GetVect`). The uninstaller removes the app, its Start
Menu entry and its registry key, but **leaves two things it should tell you about**:

```powershell
Remove-Item -Recurse "$env:APPDATA\GetVect"                  # settings + AI key, created on first launch
Remove-Item -Recurse "$env:LOCALAPPDATA\getvect-updater"     # ~100 MB cached copy of the installer
```

The installer caches itself in `getvect-updater` and the uninstaller does not clean it
up — measured, not guessed. Until that is fixed, these two lines are the honest
difference between "uninstalled" and "gone".

### Updates

GetVect asks GitHub Releases once per launch whether there is a newer version, and if
there is, shows a dismissible banner with a link. It does not download or install
anything. The silent in-app updater is written and dormant; it switches on once it has been
exercised end to end against a signed release, because an updater that pulled 150 MB and
then failed at the last step would be worse than none
([`src/shared/update.ts`](src/shared/update.ts) explains the whole reasoning).

The check sends no identifier, happens once, and fails silently when you are offline. To
turn it off entirely:

```bash
GETVECT_NO_UPDATE_CHECK=1 open -a GetVect
# or, permanently:
launchctl setenv GETVECT_NO_UPDATE_CHECK 1
```

## Quick start

Building from source. Requires Node 20+ and, for now, macOS.

```bash
git clone https://github.com/craigjmidwinter/getvect.git
cd getvect
npm install     # postinstall also de-quarantines + ad-hoc-signs the Electron binary
npm start       # build + launch
npm run dist    # package the app -> release/mac-arm64/GetVect.app (+ dmg, zip)
```

`npm run dist` builds **unsigned** — see [PUBLISH-CHECKLIST.md](./PUBLISH-CHECKLIST.md)
for the signing and notarization notes; the packaging config itself is
[`electron-builder.yml`](./electron-builder.yml).

> **macOS note.** On recent macOS, Gatekeeper/XProtect deletes the freshly-extracted,
> unsigned `node_modules/electron/dist/Electron.app` the first time you exec it — the
> symptom is `spawn .../Electron ENOENT` on a file that was there a second ago. The
> `postinstall` hook ([`scripts/verify-electron.mjs`](scripts/verify-electron.mjs))
> detects this, strips the quarantine xattrs and applies an ad-hoc signature. If you ever
> see that ENOENT, run `npm run postinstall`.

## Command line

The same engine, without the window. Built for a caller that is not a person —
an agent that just produced a raster and wants a path back:

```bash
git clone https://github.com/craigjmidwinter/getvect.git
cd getvect && npm install && npm run build:node

node bin/getvect.mjs logo.png                 # -> logo.svg
```

That is the whole common case. Format follows the output extension, everything
else has a default:

```bash
node bin/getvect.mjs logo.png logo.dxf        # svg | eps | dxf | pdf | png
node bin/getvect.mjs shot.jpg -f svg -c 16 -p photo
node bin/getvect.mjs logo.png - > logo.svg    # stdout, for a pipe
node bin/getvect.mjs logo.png out.svg --stats # SVG to the file, JSON to stdout
```

`node bin/getvect.mjs --help` lists every setting the app exposes — palette
size, model preset, detail, smoothing, despeckle, anti-aliasing, noise
reduction, minimum area, roundness, the black/white threshold, and DXF
splines-vs-lines.

**Or install it.** `brew install craigjmidwinter/tap/getvect` puts `getvect` on
your `PATH`: with arguments it traces, with none it opens the app.

```bash
getvect logo.png                       # same thing, no clone
```

> Do not `npm link` from a clone — that would put a second, different `getvect`
> on your `PATH`, and which one wins is an accident of ordering. Run it by path
> or install it, not both.

**The contract it holds, because a subprocess has no way to ask:**

- **stdout stays empty** unless you pass `--stats`, which prints one JSON object
  on one line. Nothing to parse around.
- **every failure exits non-zero** with one line on stderr — missing file `66`,
  unsupported input `65`, bad arguments `64`, trace failure `70`, write failure
  `73`, engine not built `69`.
- **it never asks anything.** No prompt, no window, no renderer, no keychain, no
  network. It imports the engine directly, the way the instruments do.
- **it is the same trace the app shows** — byte-identical output for the same
  input and settings, which is a test (`tests/engine/cli.test.mjs`), not a
  claim.

```bash
$ node bin/getvect.mjs frankie.png out.svg --stats
{"input":"frankie.png","output":"/abs/path/out.svg","format":"svg","width":1195,
 "height":896,"colors":7,"layers":7,"bytes":17844,"ms":595}
```

## Testing & instruments

```bash
npm test              # engine contract tests, then the Playwright acceptance suite
npm run test:engine   # just the engine contracts (pure Node, no Electron)
npm run instruments   # fidelity metrics -> artifacts/metrics.json
npm run screenshots   # a labelled contact sheet of the whole flow -> artifacts/screenshots/
npm run docs:screenshots # regenerate the three screenshots this README shows
```

Three layers, and they are the project's real documentation:

- **Acceptance suite** — Playwright driving the *packaged* Electron app, one spec file per
  REFERENCE checklist section, every test title prefixed with its id (`[A1]`…`[D5]`).
  Selectors are `data-testid` only; the DOM contract is [docs/TESTIDS.md](docs/TESTIDS.md).
- **Engine contracts** — `node --test` over the pure tracing engine: determinism, setting
  semantics, SVG/EPS/DXF/PDF structure, alpha handling, and rasterized checks that the
  *picture* actually changed.
- **Instruments** — the light meter. For every fixture it runs `vectorize()`, rasterizes
  the SVG back to source dimensions with resvg and diffs: mean colour error, SSIM, ink
  recall, sub-path count, tiny-speck ratio, curve-command ratio, transparent-area colour
  error, boundary geometry and blind-spot incidence — on synthetic fixtures whose right
  answer comes from an equation, and on public-domain artwork nobody here drew. Adjectives
  turned into numbers that can fail a build.

Full guide, metric definitions and the engine interface contract:
**[docs/HARNESS.md](docs/HARNESS.md)**.

## How it was built

GetVect was written almost entirely by a **pit crew gauntlet** — a multi-agent loop where
three roles take turns on one repo. *Builders* implement a slice at a time (engine →
shell → settings → export). *Critics* start with fresh context, read only the spec and the
running app, and score it. And a *pit crew* does nothing but build measurement: the
Playwright-for-Electron harness, the fixture generator, the fidelity instruments. The bet
being tested is the thesis that a loop's speed limit is measurement, not intelligence — so
a third role that only makes things countable should pay for itself.

The single biggest correction came from refusing to grade against adjectives: a bar
written as prose does not fail CI. Rebuilding the spec around *model presets and candidate
palettes*, rather than the detail/smoothing/despeckle sliders we had guessed, surfaced the
finding the engine now revolves around: **Smart anti-aliasing collapses sub-path count by
about two thirds at otherwise identical settings** — 90 → 29 on the fox and 159 → 42 on
Frankie, Clipart at 8 colours, counted with `countPaths`/`countSubPaths` from
`instruments/lib/metrics.mjs`. Sub-paths are the unit that moves: we emit one path per
colour layer, so the element count barely changes while the slivers inside it collapse.
That is a pre-trace edge cleanup, not a rendering garnish, and it is the difference between
output that looks *traced* and output that looks *drawn*.

The loop also caught itself cheating. For an entire lap the instruments fed the engine a
white-flattened image that no UI could ever produce, while the renderer's canvas ingest
was handing it `(0,0,0,0)` for transparent pixels — so every transparent-background PNG,
the whole sticker/decal use case, traced an invented opaque black background and scored
*green*. A number measured on pixels the product never sees is not a measurement of the
product. There is now a decode-parity spec whose only job is to go red the moment the app
and the harness disagree.

The whole build is chronicled as it happened in [`katra/entries/`](katra/entries/),
published at [getvect.midwinter.io/devlog](https://getvect.midwinter.io/devlog/).
Longer-form writing on the loop itself lives at
[midwinter.io/blog](https://midwinter.io/blog/).

## Layout

```
src/main/        Electron main process + preload bridge
src/renderer/    React UI (workspace, preview, settings) + vectorization worker
src/engine/      pure vectorization engine (palette / trace / curve fit / SVG / EPS / DXF / PDF)
src/shared/      testid constants shared by app and tests
tests/e2e/       Playwright acceptance suite, one spec per checklist section
tests/engine/    engine contract tests (node --test)
instruments/     fidelity metrics + screenshot harness
fixtures/        deterministic test images (npm run fixtures) + reference-product exemplars
scripts/         build/dev/fixture/postinstall tooling
artifacts/       generated output (git-ignored)
```

The engine (`src/engine/`) is a **pure module** — no Electron, no DOM, no `fs`, no network
— because the renderer runs it in a worker and the instruments import it straight from
Node. That constraint is what makes the whole measurement story possible.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Short version: the suite must be green where it
was green, the instruments must not regress, and any new UI has to declare its testids in
[docs/TESTIDS.md](docs/TESTIDS.md).

## Status

Pre-1.0 and honest about it. The acceptance suite is the source of truth for what works
today — run `npm test` and read the summary. macOS is where the full acceptance suite
runs; on Windows the 80 engine contracts run in CI before every release and the
installer's behaviour (silent, per-user, no admin) has been verified on a real machine —
but the app's UI has not been driven end-to-end there. Linux needs `xvfb-run -a` for the
Electron tests and is untested.

## License & credits

[MIT](./LICENSE) © 2026 Craig Midwinter.

Tracing builds on [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs)
(Unlicense) for boundary extraction; curve fitting, colour handling and every exporter are
this project's own. The test harness uses [sharp](https://github.com/lovell/sharp) and
[resvg-js](https://github.com/yisibl/resvg-js). The mascot is **Frankie**, an orange tabby
— the maintainer's own cat; the artwork was generated with an image model from a photo of
him and then hand-corrected for coat colour and markings, and it is MIT-licensed along
with the rest of the repo. The fox he replaced is still in
[`fixtures/reference/`](fixtures/reference/), also ours, also MIT. The
wordmark is set in [Sedgwick Ave Display](https://fonts.google.com/specimen/Sedgwick+Ave+Display)
(SIL Open Font License), shipped as converted outlines in `docs/assets/getvect-wordmark.svg`.
