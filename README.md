# GetVect

Local desktop raster → vector app (Electron + TypeScript + React). Target behaviour is
specified in [REFERENCE.md](./REFERENCE.md).

**Current state: the REFERENCE checklist is implemented and measured green.** The app
does ingest (drag-drop + picker, multi-image sidebar), auto-vectorize in a worker, the
four model presets with Clipart's detail levels, candidate palettes and a palette
editor, output colour groups with per-colour disable (transparent background), noise
reduction / anti-aliasing / enhance, the advanced vectorization controls (roundness,
minimum area, overlap, circle detection), filled-vs-stroked result styles,
original/vector/side-by-side preview with synchronised zoom & pan, and
SVG/EPS/DXF/PDF/PNG export through the native save dialog.

`npm test` runs both suites — 50 engine contract tests then 96 Playwright acceptance
specs, 0 fail. `npm run instruments` 7 fixtures pass, including the blind A/B against
the real the reference product exemplars (2.82x their sub-path count at 16 colours, 0.81x at 6,
with lower mean colour error against the source in both cases, and 96 % ink recall —
the hairlines the cleanup passes used to eat).

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
tests/engine/    engine contract tests (node --test): contract, parity, rendered
instruments/     fidelity metrics + screenshot harness
fixtures/        deterministic test images (npm run fixtures)
scripts/         build/dev/fixture/postinstall tooling
artifacts/       generated output (git-ignored)
```
