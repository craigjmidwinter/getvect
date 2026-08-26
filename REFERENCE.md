# GetVect — Reference Spec

This is the **quality bar**: what GetVect has to do, and how well, stated so that each
item can be judged on its own. It is a spec for a local desktop raster→vector application,
not a comparison with anything. Accounts, credits, payments and a web API are explicitly
**out of scope** — they are billing plumbing, not vectorizer behaviour, and this app has
none of them by design.

Where a number appears below it is measured, and the section says what measured it. A
target nobody can reproduce is a wish, not a spec.

## The job

Convert raster images (PNG, JPEG, BMP) into scalable vector graphics (SVG, EPS, DXF, PDF,
PNG) by colour analysis and edge detection, turning pixel data into geometric paths.
The workflow:

1. **Ingest** via drag-and-drop or file browser. Multiple images can be loaded; the user
   switches between them in a list.
2. Optional **AI Enhance** preprocessing: a generative image-to-image pass that flattens
   shading and regularizes outlines before tracing, on a key the user supplies. Off by
   default, and the only thing in the app that touches the network.
3. **Automatic vectorization** on load with sensible defaults, with a progress indicator.
4. **Preview and adjust**: compare original vs vector result (toggle and side-by-side),
   zoom and pan (synchronized between views), then tune settings and re-vectorize:
   - **Colour palette**: number of colours; auto-computed palette; per-colour editing
     (change a colour, merge similar colours, remove a colour).
   - **Detail** level (how closely paths follow pixel edges).
   - **Smoothing** (curve-fitting aggressiveness).
   - **Despeckle / noise filter** (drop tiny specks below an area threshold).
5. **Export** via native save dialog.

**Flat-colour artwork is the primary target, not photographs** — t-shirt designs, tattoo
templates, stickers, decals, logos, signage. That choice drives everything downstream: it
is why palette control is a first-class surface, why speck removal matters more than
gradient fidelity, and why the sharpness of a corner is a gated property rather than a
matter of taste.

## Acceptance checklist (each item separately judgeable)

Every item has an acceptance spec in `tests/e2e/`, named for its id.

A. **Launch & ingest**
   - A1. App launches to a drop zone; accepts PNG/JPEG/BMP via drag-drop AND a file picker.
   - A2. Unsupported files are rejected with a clear message.
   - A3. Multiple images form a sidebar/list; selecting one switches the workspace to it.

B. **Vectorization engine**
   - B1. Auto-vectorizes on load with defaults; visible progress state; UI stays responsive.
   - B2. Model presets: Clipart (with Detail Level: Maximum/Ultra/Very High/High/Medium/
     Low/Minimum), Photo, Sketch (grayscale), Drawing (B/W with luminance threshold
     control) — each observably changes output.
   - B3. Input palette: auto-generated candidate palettes at sizes 1,2,3,4,5,6,8,12,15,16,18
     selectable as radio rows, plus a custom palette editor. Output colour groups panel:
     per-colour disable checkbox (disabling the background colour yields a transparent
     background), merge threshold (e.g. 5%), sort order.
   - B4. AI Enhance toggle: denoise plus colour/background simplification that observably
     improves noisy input. Plus Noise Reduction (Off/Low/High) and Anti-aliasing
     (Off/Smart/Mid).
   - B5. Advanced controls, each observably changing output: Roundness (3 curve-fitting
     levels), Minimum Area (0/5/90 px² speck removal), Overlap (Full/High), Circle
     Detection (Off/On).
   - B6. Result styles: Filled Layers vs Stroked Layers.

C. **Preview**
   - C1. Original/vector toggle AND side-by-side mode.
   - C2. Zoom in/out/fit and pan, synchronized across both views.
   - C3. Vector preview is the actual SVG that will be exported.

D. **Export**
   - D1. SVG export: valid XML, renders identically to the preview. Structure is per-colour
     `<g fill="rgb(...)">` layers with a 10× scaled viewBox, so the result drops into
     Illustrator or Inkscape as editable colour groups rather than one flattened shape.
   - D2. EPS export: structurally valid (parses, correct bounding box, paths present).
   - D3. DXF export: structurally valid (readable entities, correct extents). Fitted cubics
     travel as degree-3 `SPLINE` entities, with an R12 POLYLINE fallback for firmware that
     cannot read a spline.
   - D4. Exports go through the native save dialog with sensible default filenames.
   - D5. PDF and PNG export alongside SVG/EPS/DXF.

E. **Stretch features** (missing = minor severity, not blockers): isometric exploded layer
   view, crop image, edit pixels, gradient detection, drag-to-regroup output colour circles,
   Android VectorDrawable XML, STL, GCODE, ZIP/minimized/≤15KB variants, output size
   controls.

## What good output looks like, measured

The bars the engine is actually held to live in `fixtures/manifest.json`, per fixture, as
**absolute measured values** — mean colour error, SSIM, ink recall, curve command ratio,
tiny-sub-path ratio, transparent-area colour error, wall-clock. They are not ratios against
anything else, and nothing outside this repo is needed to evaluate them. `npm run
instruments` computes them and fails the run on any breach.

Read `docs/HARNESS.md` before changing any of it — in particular **who is allowed to decide
that a change is an improvement**. A threshold anchored only on artwork this project drew
is a measurement agreeing with itself; `tests/engine/provenance.test.mjs` enforces that.

### The anti-aliasing result

The single measurement that shaped the engine most, and the reason **Smart is the default**
(`src/engine/index.ts DEFAULT_SETTINGS.antiAliasing`). Our engine, Clipart at 8 colours,
counted by `countPaths` / `countSubPaths` in `instruments/lib/metrics.mjs`:

| subject | AA off | Smart AA | sub-paths |
| --- | --- | --- | --- |
| `fox-sticker.png` | 8 paths / 90 sub-paths / 23.6 KB | 6 paths / 29 sub-paths / 16.5 KB | −68% |
| `frankie-sticker.png` | 8 paths / 159 sub-paths / 32.2 KB | 7 paths / 42 sub-paths / 17.4 KB | −74% |

Smoothness per sub-path is a core engine goal, not a stretch feature: the sub-paths Smart
AA removes are the slivers a stair-stepped edge generates, and removing them is most of the
difference between a file an illustrator can edit and a file they delete.

**What it must not cost is sharpness.** The failure mode of any de-staircasing pass is
rounding what was meant to be angular, so `tests/engine/sharp-corners.test.mjs` and the
`minCurveCommandRatio` bars in the manifest gate the corner geometry independently. The
mascot's ear tip is the canary.

### The demo fixtures

`fixtures/reference/` holds this project's own artwork, MIT-licensed with the rest of the
repo — see `ARTWORK.md` there for provenance and for what each fixture is a guard against.
They are the most detailed pictures the harness traces and a lot of the engine was worked
out on them, but **they cannot anchor a ratchet**, for the reason above.

`fox-sticker.png` is 1024×1024 and 76.5% transparent, which makes it the strongest alpha
guard in the suite: a trace that paints the alpha-0 background opaque scores ~255 on
`maxTransparentAreaColorError` instead of the ~0.1 it should.

## Quality bar (measurable — the pit crew turns these into instruments)

- **Fidelity**: rasterizing the exported SVG back to the source dimensions and diffing
  against the (preprocessed) original on flat-colour fixtures should give mean per-pixel
  colour error under ~8/255 and ≥ 0.90 structural similarity.
- **Economy**: flat-colour fixtures (≤8 colours, simple shapes) should produce ≤ 200 paths
  and an SVG under 100KB.
- **Responsiveness**: a 1024×1024 image vectorizes in under 10s on this machine; the UI
  never hard-freezes.
- **Round-trip**: exported files open in standard consumers (SVG in a browser; EPS/DXF
  parse with common tooling).

## Tech constraints

- Electron + TypeScript. Renderer stack is the builders' choice (React + Vite suggested).
- Tracing may use an existing library (e.g. imagetracerjs); a from-scratch tracer is not
  the goal. EPS/DXF may be converted from the traced geometry.
- Everything runs locally. The only network touchpoints are the once-per-launch release
  check and opt-in AI Enhance, both in `src/main/` and both disclosed.
- `npm start` runs the app; `npm test` runs the acceptance/e2e suite.
