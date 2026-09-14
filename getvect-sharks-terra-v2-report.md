# GetVect sparse-line fixture repair — Terra executor receipt

Date: 2026-09-04

Scope: exact bounded successor of `dc9c031fff8b3576ebc7a5198399e7191960ea97` only. No network, install, push, tag, release, live pane, dialog, or competitor artifact was used.

## Candidate

- commit: `babec278d7ba63b3dc5ab10a0823d42cdcdfe7dd`
- tree: `3db4b745b789b3b81c54aa4b2117bdf8db41b40b`
- parent: `dc9c031fff8b3576ebc7a5198399e7191960ea97`
- bounded change: Sharp 0.33.5 has no `box` resize kernel; replaced it with its documented deterministic `sharp.kernel.linear` reduction, retained the Drawing-only engine change, then generated and committed only the synthetic line-network PNG and manifest row.

## Failing-first and generation

- Reproduction: `sharp(...).resize(2, 2, { kernel: 'box' })` exited 1 with `Expected valid kernel name for kernel but received box of type string`.
- Installed Sharp source exposes only `nearest`, `linear`, `cubic`, `mitchell`, `lanczos2`, and `lanczos3`; `linear` is its documented triangle reduction kernel.
- `npm run fixtures`: exit 0.
- generated `fixtures/line-network-736.png`: 28,528 bytes, SHA-256 `33a741149c9c784bce83de1e53940ab18e8f4893feb1d6593a13b287691fa6b4`.
- generated `fixtures/manifest.json`: SHA-256 `df75d55395b270caa2f951aa4a7fc3a3861c44eb4d5330b05a4010d8a54384f9`.

## Clean-clone checks

A local shared fresh clone at the exact candidate, with only a temporary symlink to pre-existing dependencies and no local Sharks overlay, ran:

- `npm run typecheck`: exit 0.
- `npm run build:node`: exit 0.
- `npm run test:engine`: exit 0; 126 passed, 0 failed.
- `npm run instruments`: exit 0; 20 pass, 0 fail, 0 not-implemented, 2 skipped, 5 unmet non-gated aspirations. `line-network-736`: pass; MAE 1.23/255, SSIM 0.9927, ink 0.9764, strict ink 0.8709, component ratio 0.6327, coverage 0.9627, supported precision 0.9967, enclosed-light retention 1.0000, width ratio 0.9081, SVG 6,943 bytes, 79.13 ms.
- `npm test`: exit 0; Playwright 155 passed, 3 skipped in 55.9 s; engine contracts and acceptance suite both PASS.
- `npm run assets`: exit 0; all published claims matched measured values.
- clean-clone instrument artifact: SHA-256 `9aec2f5126e41e9b77ffe256ad033c502f4b0d8ed379dc92792579eaae10b8aa`.

## Worktree status

The source change is committed. The implementation worktree still has only executor-local side effects: `scripts/derived-assets.stamp.json` (engine source hash after the asset check), the earlier v1 report, and the temporary `node_modules` symlink. The candidate itself has no uncommitted source change. I did not discard those local side effects after the command guard rejected destructive cleanup; they are not staged or committed.

## Result

**GO for independent review; not acceptance.**
