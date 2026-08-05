# GetVect — Reference Spec (feature parity with the reference product)

This is the **quality bar** for the gauntlet loop. The target is feature parity with the
*behavior* of https://the reference product — the raster→vector conversion workflow — delivered as a
local desktop Electron app. Accounts, credits, payments, and the web API are explicitly
**out of scope** (they are billing plumbing, not vectorizer behavior).

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

B. **Vectorization engine** — the REAL product's controls were captured live; see
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
   - D1. SVG export: valid XML, renders identically to the preview. Real product's SVG
     structure: per-color `<g fill="rgb(...)">` layers, 10× scaled viewBox (see exemplars).
   - D2. EPS export: structurally valid (parses, correct bounding box, paths present).
   - D3. DXF export: structurally valid (readable entities, correct extents).
   - D4. Exports go through the native save dialog with sensible default filenames.
   - D5. PDF and PNG export options alongside SVG/EPS/DXF (real product also offers these).

E. **Stretch features** (real product has them; missing = minor severity, not blockers):
   isometric exploded layer view, crop image, edit pixels, gradients detection tab,
   drag-to-regroup output color circles, DXF lines-vs-splines variants, Android
   VectorDrawable XML, STL, GCODE, ZIP/minimized/≤15KB variants, output size controls.

## Gold-standard exemplar (real the reference product output — use for blind A/B)

`fixtures/reference/snorlax.png` is a raster source (1045×833 artwork, flat-color character
on a busy background) and `fixtures/reference/snorlax.svg` is **the actual output
the reference product produced for it** at roughly a 16-color setting. Measured properties of the
real product's output: 34 paths, 31KB, paths grouped into per-color `<g fill="rgb(...)">`
layers, smooth curve-fitted outlines (no pixel staircase), rendered at 1152×928 with a 10×
scaled viewBox. Our engine, run on the same PNG at 16 colors, should be in the same class:
comparable visual fidelity when both are rasterized, path count within ~3× of the
exemplar's (not thousands of specks), file size within ~5×, and per-color layer grouping.
Critics should do a blind A/B: rasterize both SVGs and judge which is closer to the source.

Two more DOM-captured real outputs with fully-known settings live alongside it — see
`fixtures/reference/OBSERVED-UI.md` for their parameter table. Headline finding recorded
there: the real product's **Smart anti-aliasing** collapses path count by ~81% at identical
settings (354→67 paths). Matching that smoothness-per-path economy is a core engine goal,
not a stretch feature.

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
