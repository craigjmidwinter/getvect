# Publish checklist

The runbook for releasing `craigjmidwinter/getvect`, plus the procedure for removing an
asset from every commit. **Run the history section only after the agent loop has finished
committing** — it rewrites every hash and will destroy in-flight work.

- [ ] 0. Pre-flight
- [ ] 1. Untrack generated output
- [ ] 2. Push
- [ ] 3. Verify
- [ ] 4. Describe, topic, publish
- [ ] 5. Post-publish (optional)

Plus, when an asset has to leave history entirely: **History hygiene**, below.

---

## History hygiene — removing an asset from every commit

Sometimes an asset has to leave not just `HEAD` but every commit that ever carried it: a
public repository distributes its whole history, and an unreferenced blob stays fetchable
by SHA. This is the procedure, and it has been run more than once.

> **Back up first, and PROVE the backup.** `git filter-repo` rewrites every commit hash.
> Take a mirror clone plus a `git bundle` of every ref, stored outside the repo — then
> restore from the bundle into a scratch directory and confirm `HEAD` and the tags are
> present. An unverified backup is a check that agrees with itself.

```bash
# git-filter-repo is installed at /opt/homebrew/bin/git-filter-repo.
# It refuses to run on a non-fresh clone, hence --force.
git filter-repo --force --invert-paths --path PATH [--path PATH ...]

# A word in commit messages ships with every clone too. Write the rules to a
# file, one "old==>new" per line, then:
git filter-repo --force --replace-text /tmp/replacements.txt
```

`filter-repo` **removes the `origin` remote on purpose**, so a rewritten history cannot be
reflexively pushed over a shared branch. Re-add it, expire the old objects locally, then
force-push:

```bash
git remote add origin https://github.com/craigjmidwinter/getvect.git
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force --all && git push --force --tags
```

**A force-push does not delete anything from GitHub.** Unreachable commits stay resolvable
by direct SHA until GitHub garbage-collects on its own schedule, and any fork keeps them
permanently. After pushing, *measure* it rather than assuming: try to fetch a removed blob
by its old SHA from the remote, and check whether the repository has forks, and report what
you find. Every tag also moves, so verify that any GitHub Release still points at a commit
that exists and that its download still resolves.

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

> **This is the step people get wrong.** `origin` already contains the removed blobs
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
git log --all --oneline -- '<removed-path>'     # (d) must print nothing
git log --all --oneline -- 'katra/media/screenshot-1785892659092-2.jpg'
git grep -i '<removed-term>' $(git rev-list --all) -- 2>/dev/null | head   # slow but definitive
git rev-list --objects --all | grep -i '<removed-term>'
```

And a working-tree sweep:

```bash
git grep -il '<removed-term>' || echo "tree clean"
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

- **Cutting a release. Done — it is three commands and a tag, and it now ships two
  platforms.** [`.github/workflows/release.yml`](./.github/workflows/release.yml) fires on
  any `v*` tag. The same three commands produce the macOS **and** the Windows build; there
  is nothing extra to run, and no second ritual to remember.

  ```bash
  npm version 0.1.1 --no-git-tag-version    # bump package.json only
  git commit -am "Release 0.1.1" && git push
  git tag v0.1.1 && git push origin v0.1.1  # this is what starts the workflow
  ```

  Four jobs, and the shape is load-bearing:

  | job | runner | what it does |
  | --- | --- | --- |
  | `draft` | ubuntu | version guard, then opens **exactly one** draft release |
  | `mac` | macOS | `npm ci`, typecheck, engine contracts, build, `npm run dist -- --mac --publish always` |
  | `windows` | Windows | the same steps with `--win` |
  | `publish` | ubuntu | asserts every artefact is present, then un-drafts |

  `mac` and `windows` run in parallel and upload into the release `draft` opened. `publish`
  waits on both, so a release is never public carrying half its assets.

  **The tag and `package.json` must agree** — each build job compares
  `v$(node -p "require('./package.json').version")` against the tag and refuses to build on
  a mismatch. That is not pedantry: the feed files carry the version the *app* reports, so a
  release tagged 0.1.1 built from a package.json saying 0.1.0 produces a feed every
  installed copy will read as "you already have this", forever.

  Five things must be on the release page, and `publish` checks for all five: the **dmg**,
  the **zip**, **`latest-mac.yml`**, the **exe**, and **`latest.yml`**. The two feed files
  are the whole reason `--publish always` is used instead of `gh release create` — only
  electron-builder writes them, with each artefact's sha512 and size, and a release
  assembled by hand is a release no installed copy can ever discover. electron-updater picks
  its feed by platform, so a release with a `latest-mac.yml` and no `latest.yml` is one
  every Windows installation is permanently blind to, and it looks completely fine on the
  releases page.

  The release is created as a **draft** (`publish.releaseType` in
  [`electron-builder.yml`](./electron-builder.yml)) and un-drafted by the `publish` job.
  Otherwise it would be GitHub's "latest release" — and therefore what the site's Download
  button resolves to — while its assets were still uploading.

  **The draft is created by the workflow, before electron-builder runs**, and that ordering is a
  fix rather than a preference. electron-builder runs one publisher per target (zip, dmg); both
  look for a release by tag, both find none, and both create one — GitHub accepts two *drafts*
  sharing a tag, because a draft has no tag to collide on. The first v0.1.0 attempt did exactly
  that and split its own artefacts across two invisible drafts. Two runners packaging at once
  would only widen that race, which is why the draft is its own job that both builds wait on.
  The verification step also asserts there is exactly one release for the tag.

- **Testing the Windows build without cutting a release.**
  [`.github/workflows/win-smoke.yml`](./.github/workflows/win-smoke.yml) is
  `workflow_dispatch`-only: it runs the Windows job's exact steps, packages with
  `--publish never`, and uploads the installer as a workflow artefact. No release is
  touched, no tag exists afterwards, and its token is `contents: read`.

  ```bash
  gh workflow run win-smoke.yml     # optional: -f ref=<branch|tag|sha>
  gh run watch
  ```

  Run it after touching package.json's install scripts, the `electron` or
  `electron-builder` versions, or anything under `win:` in `electron-builder.yml`. The
  reason it exists is that a `v*` tag is the worst possible moment to learn that Windows
  stopped building, and a pushed tag is not something you can take back.

  The specific thing it guards: `npm ci` on Windows used to die in `postinstall`, which ran
  the macOS-only `xattr -cr` de-quarantine unconditionally. That call is behind a
  `process.platform === 'darwin'` check now, and nothing but this workflow tests it.

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
