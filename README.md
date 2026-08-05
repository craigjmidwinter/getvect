# GetVect

Local desktop raster → vector app (Electron + TypeScript + React). Target behaviour is
specified in [REFERENCE.md](./REFERENCE.md).

**Current state: the REFERENCE checklist is implemented…** The app
does ingest (drag-drop + picker, multi-image sidebar), auto-vectorize in a worker, the
four model presets with Clipart's detail levels, candidate palettes and a palette
editor, output colour groups with per-colour disable (transparent background), noise
reduction / anti-aliasing / enhance, the advanced vectorization controls (roundness,
minimum area, overlap, circle detection), filled-vs-stroked result styles,
original/vector/side-by-side preview with synchronised zoom & pan, and
SVG/EPS/DXF/PDF/PNG export through the native save dialog.

**…measured against pixels the app could not actually produce.** The instruments fed
`vectorize()` a white-flattened image while the renderer's canvas ingest hands it
`(0,0,0,0)` for transparent pixels, so every transparent-background PNG — REFERENCE's
sticker/decal use case — traced with an invented opaque black background and nothing
noticed. The harness now feeds the engine the same pixels the UI does, and the resulting
red is the honest state:

- `npm run test:engine` — 50 pass, 6 fail (input alpha ignored; DXF flattens every curve;
  circle detection finds one of three circular contours).
- `npm test` — 100 acceptance specs pass, 8 fail (transparent export, app-vs-headless
  decode parity, undecodable-file rejection, Drawing's dead colour controls, output
  controls below the fold).
- `npm run instruments` — 5 of 8 fixtures pass. `reference-artwork` now misses the
  REFERENCE 3× economy bar at 4.51× the exemplar's sub-paths, and the two alpha fixtures
  fail on `transparentAreaColorError`.

```bash
npm install
npm start             # build + launch
npm test              # engine contract tests + acceptance suite (tests/e2e, [A1]…[D4])
npm run test:engine   # just the engine contract tests (pure Node, no Electron)
npm run instruments   # fidelity metrics -> artifacts/metrics.json
npm run screenshots   # flow contact sheet -> artifacts/screenshots/
```

- [docs/HARNESS.md](./docs/HARNESS.md) — how to run everything, what each metric means,
  and the engine interface contract.
- [docs/TESTIDS.md](./docs/TESTIDS.md) — the `data-testid` / DOM contract the UI must
  implement for the suite to pass. **Read this before building UI.**

## Layout

```
src/main/        Electron main process + preload bridge
src/renderer/    React UI (workspace, preview, settings) + vectorization worker
src/engine/      pure vectorization engine (palette / trace / curve fit / SVG / EPS / DXF / PDF)
src/shared/      testid constants shared by app and tests
tests/e2e/       Playwright acceptance suite, one spec per checklist section
tests/engine/    engine contract tests (node --test): contract, parity, rendered, alpha
instruments/     fidelity metrics + screenshot harness
fixtures/        deterministic test images (npm run fixtures)
scripts/         build/dev/fixture/postinstall tooling
artifacts/       generated output (git-ignored)
```
