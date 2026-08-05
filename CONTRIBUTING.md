# Contributing to GetVect

Thanks for looking. GetVect is a small, opinionated codebase with an unusually heavy test
harness, and the harness is the thing to understand first — it is what keeps a
raster-to-vector engine honest.

## Dev setup

Node 20+ and macOS (see [Platforms](#platforms) below for the state of everything else).

```bash
git clone https://github.com/craigjmidwinter/getvect.git
cd getvect
npm install     # postinstall de-quarantines + ad-hoc-signs the Electron binary on macOS
npm start       # build + launch the real bundle
npm run dev     # Vite dev server + Electron with renderer HMR (iteration only)
```

If you ever see `spawn .../Electron ENOENT` on a binary that was there a second ago, that
is macOS XProtect deleting the unsigned Electron dev build. Run `npm run postinstall`.

`npm start` always builds and launches the real bundle — that is what the acceptance suite
tests. `npm run dev` is for iteration; nothing is verified in that mode.

## Test commands

```bash
npm run typecheck     # both tsconfig projects, no emit
npm run test:engine   # engine contract tests (pure Node, fast, no Electron)
npm test              # engine contracts, then the Playwright acceptance suite
npm run instruments   # fidelity metrics -> artifacts/metrics.json
npm run screenshots   # labelled contact sheet -> artifacts/screenshots/
```

Useful slices:

```bash
npx playwright test -g "\[B2\]"                              # one checklist item
npx playwright test tests/e2e/d-export.spec.ts --headed --workers=1
npx playwright show-report artifacts/e2e-report
PW_WORKERS=1 npm test                                        # serialize while debugging
```

Do **not** run `npx playwright install` — the suite drives Electron through the `_electron`
launcher and needs no browser download.

Read [docs/HARNESS.md](docs/HARNESS.md) before changing anything measured. It defines every
metric, the engine interface contract, and the reasoning behind the per-fixture thresholds.

### Reading harness output cheaply

The stdout tables are the interface. `artifacts/metrics.json` and
`artifacts/e2e-results.json` are large — query them, don't read them whole:

```bash
jq -r '.results[] | select(.status=="FAIL") | "\(.id): \(.failures|join("; "))"' artifacts/metrics.json
jq -r '.suites[].specs[]? | select(.ok==false) | .title' artifacts/e2e-results.json
```

## The testid contract

The acceptance suite selects **exclusively** on `data-testid` — never on text, class names
or DOM position. That is deliberate: it lets the UI be restyled and restructured freely
without touching a single spec.

- The full DOM contract is [docs/TESTIDS.md](docs/TESTIDS.md). **Read it before building
  UI.** It lists every testid, its required attributes, and the state semantics
  (e.g. `data-selected` must be the string `"true"`/`"false"` on *every* item).
- The ids themselves live in [`src/shared/testids.ts`](src/shared/testids.ts) and are
  imported by both the renderer and the specs, so a typo is a compile error rather than a
  mystery timeout. Import `TESTIDS`; never type a string literal.
- Adding a testid is free. Renaming or removing one is a breaking change: update
  `src/shared/testids.ts`, `docs/TESTIDS.md` and the affected specs **in the same commit**.

## Touching the engine

`src/engine/` is a pure module: no Electron, no DOM, no `fs`, no network. The renderer runs
it in a worker and the instruments import it straight from Node, so that purity is what
makes the measurement story work. Beyond the types in
[`src/engine/types.ts`](src/engine/types.ts):

- **Deterministic.** The same `(image, settings)` must produce a byte-identical `svg`, or
  the instruments cannot tell a regression from noise. Seed anything stochastic.
- **Non-blocking.** Call `onProgress` at least once per phase and yield between phases.
- **Alpha is data, not padding.** Callers hand over RGBA, and a canvas returns `(0,0,0,0)`
  for a transparent pixel. Dropping those pixels or flattening them onto white are both
  fine; treating them as opaque black is not.
- If you change how the renderer decodes an image, change `canvasIngest()` in
  `instruments/lib/decode.mjs` **in the same commit**.
  `tests/e2e/q-decode-parity.spec.ts` exists to go red the moment the two drift apart.

Do not change the exported engine signatures without updating
`instruments/run-instruments.mjs` and `docs/HARNESS.md` alongside them.

## Pull requests

1. **The suite is green where it was green.** `npm test` must not turn a passing spec red.
   Some specs are red by design until the matching REFERENCE feature lands — a PR may leave
   those red, but say which and why in the description.
2. **The instruments must not regress.** Run `npm run instruments` before and after and
   include the relevant rows. A change that improves fidelity while blowing the path-economy
   budget (or vice versa) needs a note explaining the trade.
3. **`npm run typecheck` passes.** CI runs it on every push.
4. **New UI declares its testids** in `docs/TESTIDS.md` and `src/shared/testids.ts`.
5. **New features get a spec** titled with their REFERENCE checklist id, and
   `docs/HARNESS.md`'s spec table gets the row.
6. Keep commits logical and self-describing. Describe *what changed for the user or the
   measurement*, not "fix stuff".

Behaviour is graded against [REFERENCE.md](REFERENCE.md). If you think the spec itself is
wrong, that is a legitimate PR — change the spec and the tests together and argue for it.

## Platforms

macOS is the only platform currently exercised end to end. Linux should work but needs a
display for Electron (`xvfb-run -a npm test`). Windows is untested; a PR that gets the
suite green there is very welcome.

## Reporting bugs

Use the bug report template. The two things that make a vectorization bug reproducible are
**the input image** and **the exact settings** — please include both.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
