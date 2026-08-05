# Publish checklist

The ordered runbook for taking `craigjmidwinter/getvect` public. **Run this only after the
agent loop has finished committing** — steps 2 and 5 rewrite history and will destroy any
in-flight work.

Order matters. The history rewrite is the last thing before flipping visibility.

- [ ] 0. Pre-flight
- [ ] 1. Replace the snorlax fixtures with the fox set
- [ ] 2. Scrub snorlax from git history
- [ ] 3. Re-stamp the katra entries
- [ ] 4. Untrack generated output
- [ ] 5. Recreate the remote and push
- [ ] 6. Verify
- [ ] 7. Describe, topic, publish
- [ ] 8. Post-publish (optional)

---

## Why step 1–2 exist

`fixtures/reference/snorlax.*` is Nintendo/Game Freak artwork. It was the gold-standard
blind-A/B exemplar during the build and it cannot ship in a public repo — not in the tree
and not in history. `fixtures/reference/fox-*` is the license-clean replacement: original
generated mascot art, run through the reference product signed-out, with fully-known
settings recorded in `fixtures/reference/OBSERVED-UI.md`.

The fox numbers are already documented (OBSERVED-UI.md, "Fox exemplar" section):

| | snorlax set (removing) | fox set (keeping) |
| --- | --- | --- |
| source | `snorlax.png` 1046×833, 33% transparent | `fox-sticker.png` 1024×1024, 76.5% transparent |
| opaque variant | — | `fox-sticker-white.png` (white-flattened) |
| primary exemplar | `snorlax.svg` — 34 paths, 31 KB, ~16 colours + Smart AA | `fox-sticker-clipart-8colors-smartAA.svg` — **63 paths, 7 groups, 35.5 KB**, Clipart / 8 colours / Smart AA on / Enhance on / min-area 5 px², viewBox `0 0 10240 10240` |
| second exemplar | `snorlax-clipart-6colors-min90.svg` — 93 paths, 91 KB, 6 colours / min-area 90 px² / AA off | none — see the note in step 1.2 |
| third exemplar | `snorlax-clipart-18colors-min90-smartAA.svg` — 67 paths, 42 KB | none |
| AA-off control | 354 paths / 186 KB at 18c | 637 paths / 189 KB at 8c (measured, not checked in) |

For calibration: GetVect's current engine on `fox-sticker.png` at `colorCount: 8`,
`antiAliasing: 'smart'`, `minArea: 5` produces **6 colour layers, 29 sub-paths, 13.6 KB**
in ~340 ms — i.e. comfortably inside the 3×/5× economy ratios against the fox exemplar.
That output is checked in at `docs/assets/fox-vector.svg` as the README's before/after.

---

## 0. Pre-flight

```bash
cd /Users/craig/workspace/getvect
git status --short          # must be clean; the loop must be stopped
npm test                    # know exactly what is green before you touch anything
npm run instruments         # and what the numbers are
```

Take a backup you can actually restore from — everything after this is destructive:

```bash
git clone --no-local . ../getvect-backup-$(date +%Y%m%d)
```

---

## 1. Replace the snorlax fixtures with the fox set

### 1.1 Delete the artwork

```bash
git rm fixtures/reference/snorlax.png \
       fixtures/reference/snorlax.svg \
       fixtures/reference/snorlax-clipart-6colors-min90.svg \
       fixtures/reference/snorlax-clipart-18colors-min90-smartAA.svg
```

**Also `katra/media/screenshot-1785892659092-2.jpg`.** It is a screenshot of the reference
product's editor with the Snorlax artwork loaded in both panes — same problem, different
file type, and it is easy to miss because it does not have "snorlax" in its name. Either
delete it and drop the `![...]` line that references it from
`katra/entries/2026-08-04-driving-the-real-vectorizer-for-ground-truth-smart-aa-is-the-whole-ballgame.md`,
or retake the same screenshot with `fox-sticker.png` loaded and keep the caption.

`katra/media/screenshot-1785892642715-1.jpg` (the zoomed-edge shot) is fine to keep — it
shows nothing but an anonymous curve.

### 1.2 Rewrite the fixture manifest

`fixtures/manifest.json` is **generated** — do not hand-edit it. The two snorlax entries are
defined in `scripts/generate-fixtures.mjs` around **lines 500–560**:

- `reference-snorlax` (line 503) → rename to `reference-fox`
  - `file: 'reference/snorlax.png'` → `'reference/fox-sticker.png'`
  - `exemplar: 'reference/snorlax.svg'` → `'reference/fox-sticker-clipart-8colors-smartAA.svg'`
  - `settings: { colorCount: 16, enhance: true }` → `{ colorCount: 8, antiAliasing: 'smart', minArea: 5, enhance: true }`
    (these are the settings the fox exemplar was actually captured at — OBSERVED-UI.md)
  - width/height `1046 × 833` → `1024 × 1024`
  - `note:` drop the cross-reference to `reference-snorlax-6c`
- `reference-snorlax-6c` (line 541) → **delete, or repoint at `fox-sticker-white.png`.**
  There is no 6-colour fox exemplar, so its `exemplar` / `maxMeanColorErrorRatio` gates have
  nothing to compare against. Recommended: replace it with a `reference-fox-white` entry on
  `reference/fox-sticker-white.png` with **absolute** thresholds and no `exemplar` — it still
  earns its keep as the opaque counterpart that proves the alpha path is what changed.
- Keep `maxTransparentAreaColorError: 8`. The fox is 76.5% transparent, so this fixture is a
  *stronger* alpha guard than snorlax was, not a weaker one.

Then regenerate and re-measure:

```bash
npm run fixtures        # reference/ entries are listed, not recreated; expect MISSING for none
npm run instruments     # re-tune thresholds against real numbers, do not guess them
```

### 1.3 Rewrite the code and prose references

18 tracked files mention snorlax. Work through them:

| file | what to change |
| --- | --- |
| `tests/e2e/helpers.ts:21` | `snorlax: join(FIXTURES,'reference','snorlax.png')` → `fox: join(FIXTURES,'reference','fox-sticker.png')` |
| `tests/e2e/c-preview-interaction.spec.ts:35,57` | `FIXTURE.snorlax` → `FIXTURE.fox` |
| `tests/e2e/c2-resize-fit.spec.ts:32` | same |
| `tests/e2e/q-decode-parity.spec.ts:69,74,119,127` | same — this is the alpha/decode-parity guard, and the fox's 76.5% transparency makes it sharper |
| `tests/e2e/d5-export-formats.spec.ts:91` | comment naming `snorlax.svg` as the fill-notation source → name the fox exemplar |
| `tests/engine/alpha.test.mjs:86,88` | `loadPair('reference/snorlax.png')` → `'reference/fox-sticker.png'`; the "33% transparent" comment becomes 76.5% |
| `tests/engine/parity.test.mjs:39,153-155,328` | `load('reference/snorlax.png')` → fox; the AA off/smart/mid comparison at `colorCount: 16` should move to `8` to match the exemplar |
| `tests/engine/rendered.test.mjs` (13 refs, incl. 44, 98, 116-118, 163-165, 178, 190-191, 201-202, 210-212) | the exemplar A/B block. `readFileSync(fixture('reference/snorlax.svg'))` → the fox exemplar; curve-ratio baseline `0.639` needs re-measuring on the fox exemplar; the 6-colour test at line 210 ("the reference product keeps snorlax's black outline") needs re-basing on the fox or deleting with the 6c fixture |
| `REFERENCE.md:75-89` | the "Gold-standard exemplar" section — rewrite around the fox, keeping the 3×/5× economy language |
| `docs/HARNESS.md` (5 refs) | fixture table row, the `inkRecall` bar (`≥ 0.94 (snorlax)`), the `sourceTransparentRatio` context values (`0.33 for snorlax` → `0.765 for the fox`), and the decode-contract war story — that story is worth keeping, just rename the fixture |
| `docs/TESTIDS.md:295` | comment citing `snorlax.svg` for the inherited-fill notation → fox exemplar |
| `fixtures/reference/OBSERVED-UI.md` (9 refs) | the parameter-response table and exemplar list are *measurements of the reference product on that image*. Keep the Smart-AA finding (it is the headline), drop the per-image identification, and promote the "Fox exemplar" section to the top |
| `katra/media/paths-by-settings.html`, `katra/media/pitcrew-loop.html` | one label each |
| `katra/entries/2026-08-04-driving-...md` | "one sleepy Pokémon" and the screenshot reference |
| `README.md` | already fox-only — verify with the grep in step 6 |

Verify:

```bash
git grep -il snorlax || echo "clean"
npm run typecheck && npm test && npm run instruments
```

Commit:

```bash
git add -A && git commit --no-gpg-sign \
  -m "Retire the snorlax exemplar set for the license-clean fox fixtures"
```

---

## 2. Scrub snorlax from git history

> **Do not skip the backup in step 0.** `git filter-repo` rewrites every commit hash.

```bash
# git filter-repo is already installed (/opt/homebrew/bin/git-filter-repo).
# It refuses to run on a non-fresh clone, hence --force.
git filter-repo --force --invert-paths \
  --path fixtures/reference/snorlax.png \
  --path fixtures/reference/snorlax.svg \
  --path fixtures/reference/snorlax-clipart-6colors-min90.svg \
  --path fixtures/reference/snorlax-clipart-18colors-min90-smartAA.svg \
  --path katra/media/screenshot-1785892659092-2.jpg
```

`filter-repo` **removes the `origin` remote on purpose** (so you cannot reflexively push a
rewritten history over a shared branch). Re-add it:

```bash
git remote add origin https://github.com/craigjmidwinter/getvect.git
git remote -v
```

Then expire the old objects locally:

```bash
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

**Optional — the word, not just the file.** The rewrite above removes the *artwork*, which
is the licensing problem. The string "snorlax" survives in old commit messages and in old
revisions of the docs. That is prose, not artwork, and is generally fine to leave. If you
want it gone anyway:

```bash
printf 'snorlax==>fox\nSnorlax==>Fox\n' > /tmp/replacements.txt
git filter-repo --force --replace-text /tmp/replacements.txt
```

Be aware this edits historical source code (identifiers like `FIXTURE.snorlax` become
`FIXTURE.fox` retroactively), so old commits will no longer be exactly what was run.

---

## 3. Re-stamp the katra entries

Every commit hash changed, so the hash stamps in `katra/entries/*.md` now point at commits
that no longer exist:

| entry slug | stale hashes |
| --- | --- |
| `2026-08-04-a-pit-crew-gauntlet-takes-on-a-leading-online-vectorizer` | `5c66188` |
| `2026-08-04-driving-the-real-vectorizer-for-ground-truth-smart-aa-is-the-whole-ballgame` | `36db131`, `69cc521`, `ea13a03`, `f11b9d6` |

`filter-repo` writes the old→new mapping to `.git/filter-repo/commit-map`. Translate:

```bash
python3 - <<'PY'
import pathlib
m = {}
for line in pathlib.Path('.git/filter-repo/commit-map').read_text().splitlines()[1:]:
    old, new = line.split()
    if set(new) != {'0'}:            # all-zero = commit was dropped
        m[old[:7]] = new[:7]
for h in ['5c66188', '36db131', '69cc521', 'ea13a03', 'f11b9d6']:
    print(f'{h} -> {m.get(h, "DROPPED")}')
PY
```

Re-stamp with the new hashes (`--hash` accepts a comma-separated chapter):

```bash
katra stamp --entry 2026-08-04-a-pit-crew-gauntlet-takes-on-a-leading-online-vectorizer \
  --hash <new-5c66188>

katra stamp --entry 2026-08-04-driving-the-real-vectorizer-for-ground-truth-smart-aa-is-the-whole-ballgame \
  --hash <new-36db131>,<new-69cc521>,<new-ea13a03>,<new-f11b9d6>

katra doctor          # catches dangling media + parse errors
git add katra/ && git commit --no-gpg-sign -m "Re-stamp katra entries after the history rewrite"
```

If the new entry hashes matter to you being stable, re-stamp **before** any further
rewrites, not after.

---

## 4. Untrack generated output

Currently nothing under `artifacts/` or `dist/` is tracked (verified: `git ls-files |
grep -cE '^(artifacts|dist)/'` returns `0`) and both are in `.gitignore`. If that has
changed since — the loop may have committed a report — untrack without deleting:

```bash
git ls-files | grep -E '^(artifacts|dist|node_modules|test-results|playwright-report)/' || echo "clean"
# if anything shows up:
git rm -r --cached artifacts dist
git commit --no-gpg-sign -m "Untrack generated output"
```

Also confirm no stray junk:

```bash
git ls-files | grep -iE '\.env|credential|secret|\.pem$|\.key$|id_rsa|\.DS_Store' || echo "clean"
git status --porcelain --untracked-files=all | grep '^??'   # loop scratch files
```

The agent loop leaves throwaway probe scripts at the repo root (`probe*.mjs` and friends).
They are untracked, not ignored, so they will show up in that last command — delete them
rather than committing them.

---

## 5. Recreate the remote and push

> **This is the step people get wrong.** `origin` already contains the snorlax blobs
> (commit `89b5038` is pushed). A `--force` push does **not** delete them from GitHub —
> unreachable objects stay retrievable by SHA, through the API, and through any fork or
> cached view, until GitHub garbage-collects them. GitHub's own guidance is to contact
> Support, or to delete and recreate the repository.

The repo is still private with no forks, stars or issues, so deleting it costs nothing:

```bash
gh repo view craigjmidwinter/getvect --json isPrivate,forkCount,stargazerCount,issues
gh repo delete craigjmidwinter/getvect --yes

gh repo create craigjmidwinter/getvect --private \
  --description "Local, offline raster-to-vector desktop app. PNG/JPEG/BMP to SVG/EPS/DXF/PDF/PNG. No account, no credits, no upload." \
  --source . --remote origin

git push -u origin main
```

(If you would rather keep the repo object — stars/issues history you care about — force-push
instead and open a GitHub Support ticket asking them to purge the unreachable objects
*before* flipping to public. Recreating is faster and certain.)

---

## 6. Verify

All four must come back empty:

```bash
git log --all --oneline -- '*snorlax*'          # (d) must print nothing
git log --all --oneline -- 'katra/media/screenshot-1785892659092-2.jpg'
git grep -i snorlax $(git rev-list --all) -- 2>/dev/null | head   # slow but definitive
git rev-list --objects --all | grep -i snorlax
```

And a working-tree sweep:

```bash
git grep -il snorlax || echo "tree clean"
```

Sanity-check the package as it would ship:

```bash
npm pack --dry-run
```

Read the file list it prints: `node_modules/`, `artifacts/`, `dist/` and `test-results/`
must not appear, and `fixtures/reference/` must contain only fox files. Note that
`package.json` still has `"private": true` — that is correct for an app that is not
published to npm and does not block `npm pack --dry-run`. Remove it only if GetVect is ever
actually published to the registry.

Final green run before flipping the switch:

```bash
npm ci && npm run typecheck && npm test && npm run instruments
```

---

## 7. Describe, topic, publish

```bash
gh repo edit craigjmidwinter/getvect \
  --description "Local, offline raster-to-vector desktop app — PNG/JPEG/BMP to SVG/EPS/DXF/PDF/PNG. No account, no credits, no upload." \
  --homepage "https://github.com/craigjmidwinter/getvect" \
  --add-topic vectorizer \
  --add-topic raster-to-vector \
  --add-topic image-tracing \
  --add-topic svg \
  --add-topic electron \
  --add-topic desktop-app \
  --add-topic offline-first \
  --add-topic typescript \
  --add-topic privacy \
  --add-topic ai-agents

gh repo edit craigjmidwinter/getvect --enable-issues --enable-discussions

# last step. everything above must be done first.
gh repo edit craigjmidwinter/getvect \
  --visibility public --accept-visibility-change-consequences
```

Then confirm the README renders and every image resolves:

```bash
gh browse craigjmidwinter/getvect
```

---

## 8. Post-publish (optional, not blockers)

- **App icon. Done.** The fox artwork lives in `build/` (`icon.icns`, `icon.png` 512,
  `icon-1024.png`) and is wired all the way through:

  | where | what does it |
  | --- | --- |
  | packaged `.app` bundle icon | `mac.icon: build/icon.icns` in [`electron-builder.yml`](./electron-builder.yml) |
  | Dock icon under `npm start` | `app.dock.setIcon()` in `src/main/main.ts` (dev only — a packaged app already has the icns, and the whole identity block is skipped under `GETVECT_E2E=1`) |
  | window/taskbar icon on Linux + Windows | `BrowserWindow({ icon })`, resolved from `process.resourcesPath` in a packaged app via the `extraResources` entry |
  | menu bar + About panel | `app.setName('GetVect')` + `app.setAboutPanelOptions()`. Note the dev caveat: macOS takes the *leftmost menu title* from the running bundle's `CFBundleName`, which under `npm start` is Electron's own `Electron.app`, so it still says "Electron" there. Everything derived from `app.name` — About/Hide/Quit — does say GetVect, and the packaged bundle gets the title too |
  | renderer favicon | `src/renderer/favicon.png` (32px, `sips`-derived from `build/icon-1024.png`), fingerprinted into `dist/renderer/assets/` by Vite |

  To regenerate the icns from new artwork:

  ```bash
  mkdir -p /tmp/GetVect.iconset
  for s in 16 32 64 128 256 512; do
    sips -z $s $s build/icon-1024.png --out /tmp/GetVect.iconset/icon_${s}x${s}.png
    sips -z $((s*2)) $((s*2)) build/icon-1024.png --out /tmp/GetVect.iconset/icon_${s}x${s}@2x.png
  done
  iconutil -c icns /tmp/GetVect.iconset -o build/icon.icns
  ```

- **Cutting a release. Done — it is three commands and a tag.**
  [`.github/workflows/release.yml`](./.github/workflows/release.yml) fires on any `v*` tag:
  macOS runner, `npm ci`, typecheck, engine contracts, `npm run build`, then
  `npm run dist -- --publish always`.

  ```bash
  npm version 0.1.1 --no-git-tag-version    # bump package.json only
  git commit -am "Release 0.1.1" && git push
  git tag v0.1.1 && git push origin v0.1.1  # this is what starts the workflow
  ```

  **The tag and `package.json` must agree** — the workflow's first step compares
  `v$(node -p "require('./package.json').version")` against the tag and refuses to build on
  a mismatch. That is not pedantry: `latest-mac.yml` carries the version the *app* reports,
  so a release tagged 0.1.1 built from a package.json saying 0.1.0 produces a feed every
  installed copy will read as "you already have this", forever.

  Three things must be on the release page, and the workflow checks for all three before it
  publishes: the **dmg**, the **zip**, and **`latest-mac.yml`**. The last one is the whole
  reason `--publish always` is used instead of `gh release create` — only electron-builder
  writes the feed file, with each artefact's sha512 and size, and a release assembled by
  hand is a release no installed copy can ever discover.

  The release is created as a **draft** (`publish.releaseType` in
  [`electron-builder.yml`](./electron-builder.yml)) and un-drafted by the workflow's last
  step. Otherwise it would be GitHub's "latest release" — and therefore what the site's
  Download button resolves to — while its assets were still uploading.

  **The draft is created by the workflow, before electron-builder runs**, and that ordering is a
  fix rather than a preference. electron-builder runs one publisher per target (zip, dmg); both
  look for a release by tag, both find none, and both create one — GitHub accepts two *drafts*
  sharing a tag, because a draft has no tag to collide on. The first v0.1.0 attempt did exactly
  that and split its own artefacts across two invisible drafts. The verification step now also
  asserts there is exactly one release for the tag.

  Not run on a tag: the Playwright acceptance suite. Driving a real Electron window on a
  hosted runner is still too flaky to stand between a tag and a release (same reasoning as
  the disabled `e2e` job in `ci.yml`). The engine contracts are what would make a shipped
  build *wrong*, and those do run.

- **The update check, and the one line that turns it on properly.** The shipped app checks
  GitHub Releases once per launch and, if something is newer, shows a dismissible banner
  with a Download link (`src/main/updater.ts`, `src/renderer/components/UpdateBanner.tsx`).
  It deliberately does **not** download or install, because Squirrel.Mac refuses to install
  an update it cannot validate against the running app's signature and this app is
  unsigned — see `src/shared/update.ts`.

  The download-and-install path is written, shipped, and covered by a spec
  (`tests/e2e/u-update-banner.spec.ts`, "the signed-build path"). **When signing lands, the
  entire flip is one line** in `electron-builder.yml`:

  ```yaml
  extraMetadata:
    updateMode: auto     # was: notify
  ```

  Then re-verify on a machine that has never built GetVect: install the previous version,
  publish the new one, and confirm the banner goes `available → downloading → downloaded`
  and that Restart actually relaunches into the new build. `GETVECT_UPDATE_MODE=auto`
  exercises the UI locally without a certificate; it cannot exercise Squirrel.

  Users can opt out with `GETVECT_NO_UPDATE_CHECK=1`, which is documented in the README and
  on the site, and which the honest "two network touchpoints" sentence names by hand:

  > Two network touchpoints, both in your control: optional AI Enhance, and a
  > once-per-launch update check against GitHub Releases (disable with
  > `GETVECT_NO_UPDATE_CHECK=1`).

  That sentence must stay true. Anything that adds a third touchpoint changes the sentence
  in three places (README, `site/index.html`, and the release-notes template in
  `release.yml`) before it changes the code.

- **Signing and notarization — still to do.** `npm run dist` produces
  `release/mac-arm64/GetVect.app` plus a dmg and a zip, and it is **unsigned on purpose**:
  `mac.identity: null` in `electron-builder.yml`. That is fine locally (the build machine
  runs its own output) and wrong for distribution — a downloaded unsigned app is
  quarantined, and on Apple Silicon Gatekeeper will refuse it outright rather than offering
  the right-click-Open escape hatch. For a real release:

  1. A **Developer ID Application** certificate in the login keychain. Then drop
     `identity: null` (electron-builder finds the cert on its own, or set `CSC_NAME`).
  2. `hardenedRuntime: true` and an entitlements plist — the hardened runtime is a
     prerequisite for notarization.
  3. Notarization: `mac.notarize: true` plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
     `APPLE_TEAM_ID` (or an App Store Connect API key) in the environment. electron-builder
     staples the ticket for you.
  4. Verify the result — `codesign --verify --deep --strict --verbose=2 GetVect.app` and
     `spctl -a -vv -t install GetVect.app` — and check on a machine that has never built it.

  Until that is done, say plainly in the release notes that the download is unsigned and
  give the `xattr -dr com.apple.quarantine /Applications/GetVect.app` incantation.

- **Dependency licence hygiene.** All direct dependencies are MIT-compatible:

  | package | licence | note |
  | --- | --- | --- |
  | `imagetracerjs` | Unlicense | public domain; the only tracing dependency that ships |
  | `react`, `react-dom`, `electron`, `vite`, `@vitejs/plugin-react` | MIT | — |
  | `typescript`, `@playwright/test` | Apache-2.0 | dev only |
  | `sharp` | Apache-2.0 | bundles libvips (`@img/sharp-libvips-*`, **LGPL-3.0-or-later**) |
  | `@resvg/resvg-js` | MPL-2.0 | file-level copyleft |
  | `electron-updater` | MIT | **ships**, vendored — see below |

  `electron-updater` is the one runtime dependency other than Electron itself, and it does
  not reach the app through `node_modules`: `scripts/bundle-updater.mjs` compiles it and its
  transitive closure (`builder-util-runtime`, `js-yaml`+`argparse`, `semver`, `fs-extra`,
  `lazy-val`, `tiny-typed-emitter`, two `lodash.*` singles, `debug`+`ms`, `sax`,
  `graceful-fs`, `jsonfile`, `universalify`) into one file under `dist/`. All MIT or ISC bar
  `argparse`, which is Python-2.0 — permissive, and its notice travels in the bundle's
  `legalComments` footer along with everything else's. Bundling rather than allowlisting
  sixteen `node_modules` paths in `files` is what keeps the "nothing from node_modules
  ships" rule above intact instead of riddled with exceptions.

  **`sharp` and `@resvg/resvg-js` are not used by the shipped app at all** — they appear only
  in `instruments/`, `scripts/` and `tests/` (verified: no import in `src/`). They are
  currently listed under `dependencies`, which means an Electron package would drag LGPL
  libvips and MPL resvg into the distributed bundle for no reason. **Move both to
  `devDependencies`** before the first packaged release and the shipped licence surface
  becomes MIT + Unlicense + MIT-licensed Electron. (Left undone here because `package.json`
  dependency edits were off-limits while the loop was running.)

- **Release. Done for 0.1.0** — see "Cutting a release" above. The release notes the
  workflow writes say plainly that the build is unsigned and give the `xattr` incantation.
  When notarization lands, delete that section from the template in `release.yml` rather
  than leaving a warning that is no longer true.

- **Second exemplar subject.** The katra devlog's own open question: every fidelity number
  comes from one image. Something photographic, and something with text, should join
  `fixtures/reference/` before the numbers get treated as general.
