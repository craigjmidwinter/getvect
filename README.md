# GetVect

Local desktop raster → vector app (Electron + TypeScript + React). Target behaviour is
specified in [REFERENCE.md](./REFERENCE.md).

**Current state: engine + app shell landed; REFERENCE B2-B6 not started.** The renderer
implements ingest, auto-vectorize in a worker, the four sliders, palette editing,
original/vector/side-by-side preview with synchronised zoom & pan, and SVG/EPS/DXF/PDF/PNG
export through the native save dialog — all green (46 e2e tests).

The harness now also measures the parts that are missing or unfinished, so they show up
as failures instead of prose: model presets, candidate palettes and output colour groups,
noise reduction / anti-aliasing, the advanced vectorization controls, filled-vs-stroked
layers, and — on the quality side — curve fitting, honest shape counts, and a blind A/B
against the real the reference product exemplars. Those checks are **red by design** until the
features land: `npm test` 46 pass / 48 fail, `npm run test:engine` and
`npm run instruments` likewise. See docs/HARNESS.md for which is which.

```bash
npm install
npm start             # build + launch
npm test              # acceptance suite (tests/e2e), titles tagged [A1]…[D4]
npm run test:engine   # engine contract tests (pure Node, no Electron)
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
src/engine/      pure vectorization engine (trace / palette / EPS / DXF)
src/shared/      testid constants shared by app and tests
tests/e2e/       Playwright acceptance suite, one spec per checklist section
tests/engine/    engine contract tests (node --test): contract, parity, rendered
instruments/     fidelity metrics + screenshot harness
fixtures/        deterministic test images (npm run fixtures)
scripts/         build/dev/fixture/postinstall tooling
artifacts/       generated output (git-ignored)
```
