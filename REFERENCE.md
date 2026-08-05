# GetVect — Reference Spec (feature parity with the reference product)

This is the **quality bar** for the gauntlet loop. The target is feature parity with the
*behavior* of **the reference product**, a leading online vectorizer we benchmark against —
the raster→vector conversion workflow — delivered as a local desktop Electron app.
Accounts, credits, payments, and the web API are explicitly **out of scope** (they are
billing plumbing, not vectorizer behavior).

## What the reference product does (the reference)

Converts raster images (PNG, JPEG, BMP) into scalable vector graphics (SVG, EPS, DXF) by
color analysis + edge detection, turning pixel data into geometric paths. Workflow:

1. **Upload** via drag-and-drop or file browser. Multiple images can be uploaded; the user
   switches between them in a list.
2. Optional **"Enhance image with AI (experimental)"** preprocessing: removes noise,
   simplifies colors, improves edges before vectorization.
3. **Automatic vectorization** on load with sensible defaults, with a progress indicator.
4. **Preview & adjust**: compare original vs. vector result (toggle and side-by-side),
   zoom/pan (synchronized between views), then tune settings and re-vectorize:
   - **Color palette**: number of colors; auto-computed palette; per-color editing
     (change a color, merge similar colors, remove a color).
   - **Detail** level (how closely paths follow pixel edges).
   - **Smoothing** (curve fitting aggressiveness).
   - **Despeckle / noise filter** (drop tiny specks below an area threshold).
5. **Download** the result as SVG, EPS, or DXF via native save dialog.

Highlighted use cases: t-shirt designs, tattoo templates, stickers, decals, logos,
billboards — i.e. flat-color artwork is the primary target, not photographs.

## Acceptance checklist (each item separately judgeable)

A. **Launch & ingest**
   - A1. App launches to a drop zone; accepts PNG/JPEG/BMP via drag-drop AND a file picker.
   - A2. Unsupported files are rejected with a clear message.
   - A3. Multiple images form a sidebar/list; selecting one switches the workspace to it.

B. **Vectorization engine** — the reference product's controls were captured live; see
   `fixtures/reference/OBSERVED-UI.md` for the exact UI ground truth. Summary:
   - B1. Auto-vectorizes on load with defaults; visible progress state; UI stays responsive.
   - B2. Model presets: Clipart (with Detail Level: Maximum/Ultra/Very High/High/Medium/
     Low/Minimum), Photo, Sketch (grayscale), Drawing (B/W with luminance threshold
     control) — each observably changes output.
   - B3. Input palette: auto-generated candidate palettes at sizes 1,2,3,4,5,6,8,12,15,16,18
     selectable as radio rows, plus a custom palette editor. Output color groups panel:
     per-color disable checkbox (disabling the background color yields a transparent
     background), merge threshold (e.g. 5%), sort order.
   - B4. "Enhance image with AI (Beta)" toggle: denoise + color/background simplification
     preprocessing that observably improves noisy input. Plus Noise Reduction (Off/Low/High)
     and Anti-aliasing (Off/Smart/Mid).
   - B5. Vectorization advanced controls, each observably changing output: Roundness
     (3 curve-fitting levels), Minimum Area (0/5/90 px² speck removal), Overlap (Full/High),
     Circle Detection (Off/On).
   - B6. Result styles: Filled Layers vs Stroked Layers.

C. **Preview**
   - C1. Original/vector toggle AND side-by-side mode.
   - C2. Zoom in/out/fit and pan, synchronized across both views.
   - C3. Vector preview is the actual SVG that will be exported.

D. **Export**
   - D1. SVG export: valid XML, renders identically to the preview. Reference product's SVG
     structure: per-color `<g fill="rgb(...)">` layers, 10× scaled viewBox (see exemplars).
   - D2. EPS export: structurally valid (parses, correct bounding box, paths present).
   - D3. DXF export: structurally valid (readable entities, correct extents).
   - D4. Exports go through the native save dialog with sensible default filenames.
   - D5. PDF and PNG export options alongside SVG/EPS/DXF (reference product also offers these).

E. **Stretch features** (reference product has them; missing = minor severity, not blockers):
   isometric exploded layer view, crop image, edit pixels, gradients detection tab,
   drag-to-regroup output color circles, DXF lines-vs-splines variants, Android
   VectorDrawable XML, STL, GCODE, ZIP/minimized/≤15KB variants, output size controls.

## Gold-standard exemplar (reference product output — use for blind A/B)

`fixtures/reference/fox-sticker.png` is a raster source (1024×1024 original mascot artwork,
flat-color character with a black outline on a **76.5% transparent** field) and
`fixtures/reference/fox-sticker-clipart-8colors-smartAA.svg` is **the actual output
the reference product produced for it**, captured signed-out at Clipart / 8-color palette / Smart
anti-aliasing on / Enhance on / Minimum Area 5px². Measured properties of the reference product's
output: 63 paths in 7 per-color `<g fill="rgb(...)">` layers, 114 sub-paths, 35.5KB, curve
command ratio 0.671, no background-covering path at all (the transparency survives), viewBox
`0 0 10240 10240` at a declared 1024×1024. Our engine, run on the same PNG at those settings,
should be in the same class: comparable visual fidelity when both are rasterized, path count
within ~3× of the exemplar's (not thousands of specks), file size within ~5×, and per-color
layer grouping. Critics should do a blind A/B: rasterize both SVGs and judge which is closer
to the source.

Those ~3×/~5× numbers are the product floor, not the bar the engine is held to. It currently
lands at 0.08× the exemplar's paths, 0.22× its sub-paths and 0.42× its bytes, so
`fixtures/manifest.json` gates the measured numbers with headroom instead — a limit an order
of magnitude above reality is a limit that has been deleted. Where the reference product is still
ahead is line quality, and that is where the ratios in the manifest point: its outlines come
back 5% more solid than ours in the crop where we are worst, and its strokes are 1.6× more
even.

`fixtures/reference/OBSERVED-UI.md` records the live parameter table the settings above come
from. Headline finding: the reference product's **Smart anti-aliasing** collapses path count by
~81% at identical settings (354→67 on one subject, 637→63 on the fox). Matching that
smoothness-per-path economy is a core engine goal, not a stretch feature.

## Quality bar (measurable — the pit crew turns these into instruments)

- **Fidelity**: rasterizing the exported SVG back to the source dimensions and diffing
  against the (preprocessed) original on flat-color fixtures should give mean per-pixel
  color error under ~8/255 and ≥ 0.90 structural similarity.
- **Economy**: flat-color fixtures (≤8 colors, simple shapes) should produce ≤ 200 paths
  and an SVG under 100KB.
- **Responsiveness**: a 1024×1024 image vectorizes in under 10s on this machine; the UI
  never hard-freezes.
- **Round-trip**: exported files open in standard consumers (SVG in a browser; EPS/DXF
  parse with common tooling).

## Tech constraints

- Electron + TypeScript. Renderer stack is the builders' choice (React + Vite suggested).
- Tracing may use an existing library (e.g. imagetracerjs) — parity of behavior is the
  goal, not a from-scratch tracer. EPS/DXF may be converted from the traced geometry.
- Everything runs locally; no network calls at runtime.
- `npm start` runs the app; `npm test` runs the acceptance/e2e suite.
