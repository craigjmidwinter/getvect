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

B. **Vectorization engine**
   - B1. Auto-vectorizes on load with defaults; visible progress state; UI stays responsive.
   - B2. Settings: color count, detail, smoothing, despeckle — each observably changes output.
   - B3. Palette editor: shows computed palette; a color can be changed via picker, merged
     into another, or removed; result re-renders accordingly.
   - B4. "Enhance image (experimental)" toggle: denoise + color simplification preprocessing
     that observably improves noisy input.

C. **Preview**
   - C1. Original/vector toggle AND side-by-side mode.
   - C2. Zoom in/out/fit and pan, synchronized across both views.
   - C3. Vector preview is the actual SVG that will be exported.

D. **Export**
   - D1. SVG export: valid XML, renders identically to the preview.
   - D2. EPS export: structurally valid (parses, correct bounding box, paths present).
   - D3. DXF export: structurally valid (readable entities, correct extents).
   - D4. Exports go through the native save dialog with sensible default filenames.

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
