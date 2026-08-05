# the reference product — observed ground truth (captured live, 2026-08-04)

Recorded by driving the real product at  with
`fixtures/reference/artwork.png` uploaded (processing worked signed-out; per-image
editor page at /images/<id>/<name>.html).

## Layout

Two-pane editor: LEFT = original raster, RIGHT = vector result. Four numbered steps
around the panes: ① model preset, ② input color palette, ③ quality enhancement,
④ output colors.

## Step ① — model presets (top-left toolbar)

- **Clipart** (Few Colors) — has a **Detail Level** dropdown: Maximum (Default),
  Ultra, Very High, High, Medium, Low, Minimum.
- **Photo** (Many Colors)
- **Sketch** (Grayscale)
- **Drawing** (Black / White) — input options become Black/White checkboxes plus a
  luminance histogram with a draggable threshold slider.

## Step ② — Input Options (below left pane)

- Tabs: **Color Palettes** | **Background**
- "Colors: N" label. Radio list of auto-generated candidate palettes at sizes
  1, 2, 3, 4, 5, 6, 8, 12, 15, 16, 18 — each row rendered as its swatch strip.
- **Custom Palette** button.
- **Enhance image with AI** (Beta) checkbox. Observed effect on artwork.png: busy
  yellow patterned background became near-white — i.e. denoise + background
  simplification before tracing.
- **Advanced Options** tabs: Quality Enhancement | Transparency | Filters | Text
  - Anti-aliasing: Off / Smart / Mid (+ dropdown)
  - Noise Reduction: Off / Low / High
  - Upscaling: Off / 200%

## Left pane tools

Zoom in / zoom out / fit; **Crop Image**; **Edit Pixels** (pixel editor on the source).

## Right pane — result styles & tools

- **Filled Layers** (color-filled vector elements) vs **Stroked Layers**
  (color-bordered vector elements); each has 4 sub-mode icons (layer stacking views).
- Zoom in / out / fit; **Isometric View** toggle (hamburger icon) — exploded
  per-color-layer 3D-ish visualization of the stacked vector layers.
- File size label (e.g. "223KB") + render progress bar during vectorization.
- **Download** button + format dropdown (see below).

## Step ④ — Output Options (below right pane)

- Tabs: **Color Groups** | **Gradients**
- "Colors: N" — output color groups as circles (circle size ∝ area coverage);
  each has a checkbox to disable that color (tutorial: disable background color to
  get transparent background); drag & drop circles to reorder/regroup layers.
- Sort dropdown (e.g. "Brightness ↓/↑"), merge-threshold dropdown (e.g. "5%"),
  reset + palette-view buttons, vertical slider.
- **Advanced Options** tabs: Vectorization | Output Size | Specials | ≤15KB GT
  - Roundness: 3 curve-fitting levels (+ dropdown)
  - Minimum Area: 0px² / 5px² / 90px² (+ dropdown) — speck removal
  - Overlap: Full / High — how layers overlap under each other
  - Circle Detection: Off / On

## Download formats (dropdown next to Download)

- SVG v1.0 (default), SVG v1.1, SVG v1.2 P/S
- ZIP: minimized, splitted, ~15KB, GT
- Vector: EPS, PDF, DXF (splines), DXF (lines), XML vector drawable (Android)
- STL: no color (standard) .zip, color (non-standard) .zip, STL… dialog .zip
- GCODE
- Pixel: PNG, PNG sharp edges, PNG high resolution, PNG high-res + sharp edges
  (labeled "special use cases")

## Output SVG structure (from DOM `#outputsvg`)

`<svg width height viewBox="0 0 W*10 H*10">` with one `<g fill="rgb(r,g,b)">` per
output color group (dark-to-light layering), paths in potrace-style long-form
relative coordinates at 10× scale. Layers stack: later/lighter layers sit on top
(Overlap behavior).

## Parameter-response measurements (artwork.png, 1045×833, Enhance ON)

| Preset  | Palette | Min Area | Groups | Paths | DOM size |
|---------|---------|----------|--------|-------|----------|
| Clipart (Max detail) | 18 | 5px² | 15 | 1642 | 361 KB |
| Clipart (Max detail) | 16 | 5px² | 13 | 1374 | 325 KB |
| Clipart (Max detail) | 16 | 90px² | 13 | 315 | 179 KB |
| Clipart (Max detail) | 6  | 90px² | 6  | 93  | 91 KB  |
| Photo   | 16 | 90px² | 16 | 620 | 275 KB |
| Drawing | B/W | 90px² | 2 (black, white) | 37 | 30 KB |
| Clipart (Max detail), AA Off   | 18 | 90px² | 15 | 354 | 186 KB |
| Clipart (Max detail), **AA Smart** | 18 | 90px² | 15 | **67** | **42 KB** |

**Smart anti-aliasing is the highest-leverage control observed**: at identical other
settings it collapsed 354 paths → 67 (-81%) and 186KB → 42KB. It is evidently a
pre-trace edge cleanup (edge-aware smoothing of the quantized regions), not a
post-render effect. The engine's analog matters more than any tracer parameter.

Saved exemplars in this directory:
- `artwork.png` — source raster
- `artwork.svg` — user-captured real output (34 paths, 31KB). User recalls settings
  were ~16 colors with **Smart anti-aliasing enabled** — consistent with the measured
  Smart-AA profile below.
- `artwork-clipart-6colors-min90.svg` — DOM-extracted real output at Clipart /
  6-color palette / Minimum Area 90px² / AA Off / Enhance ON (93 paths, 91KB)
- `artwork-clipart-18colors-min90-smartAA.svg` — DOM-extracted real output at
  Clipart / 18-color palette / Minimum Area 90px² / **AA Smart** / Enhance ON
  (67 paths, 42KB) — the primary smoothness/economy exemplar

## Parity scope note for GetVect

Core parity (must-have): 4 presets + Clipart detail levels, palette size radio +
custom palette, Enhance toggle, noise reduction/anti-aliasing, filled vs stroked,
output color groups with per-color disable (→ transparency) and merge threshold,
roundness / minimum area / overlap / circle detection, zoom/fit both panes,
downloads: SVG, EPS, PDF, DXF, PNG. Stretch (minor if missing): isometric view,
crop, edit pixels, gradients tab, STL/GCODE/VectorDrawable, ZIP variants,
≤15KB GT, output size tab, drag-to-regroup color circles.

## Fox exemplar (license-clean replacement art, captured 2026-08-04)

`fox-sticker.png` is an original generated mascot (Gemini image gen, chroma-keyed to
real alpha; 1024×1024, 76.5% transparent pixels) with `fox-sticker-white.png` as the
white-flattened variant. Run through the real product signed-out:

- **Transparency is preserved**: both panes render on a checkerboard; the output SVG
  has NO background-covering path (first path starts mid-canvas at M4460 8480). The
  site auto-selected an 8-color palette; output = 7 color groups.
- `fox-sticker-clipart-8colors-smartAA.svg` — real output at Clipart defaults for
  this image (Smart AA was ON by default here, Enhance ON, min-area 5px²):
  63 paths, 7 groups, 35.5KB, viewBox 0 0 10240 10240.
- Same settings with AA Off: 637 paths, 189KB — replicates the artwork Smart-AA
  finding (~90% path reduction) on a second subject.

These fox files are the go-forward public exemplars; the artwork set is Nintendo
artwork and must be purged (including git history) before the repo goes public.
