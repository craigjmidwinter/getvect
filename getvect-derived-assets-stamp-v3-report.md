# GetVect derived-assets stamp successor — Terra executor receipt

Date: 2026-09-04

Scope: generated-stamp successor only, atop `babec278d7ba63b3dc5ab10a0823d42cdcdfe7dd`. No network, install, push, tag, release, live pane, dialog, or local-overlay modification occurred.

## Commit and index proof

- commit: `f8094a7f145cbc0b9fe4d3387bdd5e78b171dbc0`
- tree: `512c8e44eb6e2642f72a81f254a1b2b764e11498`
- parent: `babec278d7ba63b3dc5ab10a0823d42cdcdfe7dd`
- cached name list before commit: exactly `scripts/derived-assets.stamp.json`.
- `git diff --cached --check`: exit 0.
- sole tracked diff confirmed: `sources.engine` changed from `fda064f67c4e157f73be43bea22efbfaf86ae496cb79bd43346a3b3c089a0d1d` to `ecfbe7501268dcc348a2ebd356ffad4030986322c7e88f938ae9db1f114b5f1b`.
- generator `--check` before and after commit: exit 0; it independently recomputed the current source hash and reported the derived assets up to date.
- `git diff --quiet 5c0f065c6ba1a3fc1b0e9bd35a0309a0fec6089e HEAD -- docs/assets build site/assets site/favicon.ico src/renderer/favicon.png`: exit 0. All tracked generated asset blobs are byte-identical to the original base.

## Clean committed-tree verification

Fresh local shared clone at the exact commit, with an ephemeral link to pre-existing dependencies and no local overlay:

- `npm run build:node`: exit 0.
- `node scripts/regenerate-derived-assets.mjs --check`: exit 0.
- `npm run typecheck`: exit 0.
- `npm run test:engine`: exit 0; 126 passed, 0 failed.
- `npm run instruments`: exit 0; 20 pass, 0 fail, 0 not-implemented, 2 skipped, 5 unmet non-gated aspirations.
- `npm test`: exit 1. Engine contracts passed; Playwright had 154 passed, 3 skipped, and one ambient failure: `tests/e2e/a-ingest.spec.ts:67` `[A3] multiple images form a list` timed out at `electronApplication.firstWindow` after 30,000 ms in `tests/e2e/helpers.ts:129`, before any page was available. This is an Electron launch/fixture failure, not a Drawing or asset assertion failure. No retry was run.

## Remaining executor-local state

No tracked file is modified or staged. Untracked, uncommitted executor artifacts remain in the implementation worktree: the earlier two reports, this report, and the temporary `node_modules` symlink. Ignored build/test artifacts remain disposable. None are part of the committed tree.

## Result

**NO-GO for acceptance solely because the required full-suite command exited 1; all bounded stamp, asset, type, engine, and instrument checks passed.**
