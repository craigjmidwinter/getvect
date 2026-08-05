# site/

The GetVect landing page and docs, served at <https://getvect.midwinter.io>.

Plain static HTML/CSS and ~30 lines of JS — no framework, no build step. Everything the
pages reference lives in `site/assets/` (optimized copies of `docs/assets/` plus the
`fixtures/reference/` fox raster), because GitHub Pages deploys this directory as the
artifact, not the repo tree.

**`site/assets/` is generated.** Every file in it is written by
`scripts/regenerate-derived-assets.mjs` from the mascot and the engine — edit the source or
the script, then run `npm run assets`; CI fails on a stale copy (`--check`).

**Deploy flow.** A push to `main` that touches `site/**` runs
`.github/workflows/pages.yml`, which uploads `site/` with `actions/upload-pages-artifact`
and publishes it with `actions/deploy-pages`. `site/CNAME` carries the custom domain.
Nothing is generated, so what is in this directory is exactly what is served.

To preview locally: `python3 -m http.server -d site 8080`.
