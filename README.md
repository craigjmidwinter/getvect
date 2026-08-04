# GetVect

Local desktop raster → vector app (Electron + TypeScript + React). Target behaviour is
specified in [REFERENCE.md](./REFERENCE.md).

**Current state: instrumented skeleton.** The app launches to a placeholder window; the
tracing engine is a documented stub. The acceptance suite is red by design — 36 checklist
tests fail, 4 harness smoke tests pass. That gap is the work.

```bash
npm install
npm start             # build + launch
npm test              # acceptance suite (tests/e2e), titles tagged [A1]…[D4]
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
src/renderer/    React UI (placeholder)
src/engine/      pure vectorization engine — STUB, implement this
src/shared/      testid constants shared by app and tests
tests/e2e/       Playwright acceptance suite, one spec per checklist section
instruments/     fidelity metrics + screenshot harness
fixtures/        deterministic test images (npm run fixtures)
scripts/         build/dev/fixture/postinstall tooling
artifacts/       generated output (git-ignored)
```
