# The reference product — observed ground truth (captured live, 2026-08-04 / 2026-08-05)

Recorded by driving the reference product — a leading online vectorizer we
benchmark against — in a browser with real artwork uploaded (processing worked
signed-out; one editor page per image). Three subjects have been driven; two have their
captures checked in — `fixtures/reference/frankie-sticker.png` (the current
mascot and primary demo fixture) and `fixtures/reference/fox-sticker.png` (its
predecessor, retained). See "Exemplars in this directory" immediately below.

## Exemplars in this directory

### Frankie (2026-08-05) — the current mascot, primary demo fixture

`frankie-sticker.png` is original artwork of the maintainer's own cat (an orange
tabby), 1195x896, **53.0% transparent** pixels, with `frankie-sticker-white.png`
as the white-flattened variant. Uploaded signed-out and run at Clipart:

- The site **auto-selected an 8-colour palette**, **Enhance ON** by default, and
  **Smart anti-aliasing ON by default** for this upload, Minimum Area 5px².
- `frankie-clipart-8colors-smartAA.svg` — real output at those settings:
  **40 paths, 55 sub-paths, 7 `<g fill>` groups, 21.7KB**, curve command ratio
  0.647, viewBox `0 0 11840 8960` at a declared 1184x896. Note the declared size
  is 11px narrower than the 1195px upload — the product trimmed transparent
  margin, which is why exemplar registration is chosen by measurement rather than
  by the declared size (`instruments/lib/render.mjs`).
- **Transparency preserved**: no full-canvas backdrop path.
- Output layers: `rgb(255,254,254)` border-white, `rgb(245,191,128)` light cream,
  `rgb(234,137,108)` pink (nose/ears), `rgb(239,162,75)` body orange,
  **`rgb(121,176,89)` green — the eyes get their own layer**, `rgb(206,101,30)`
  stripes, `rgb(1,0,0)` ink.
- **The eye layer is a repaint, not a preservation.** The source's eyes are olive
  `rgb(187,161,80)`; the exemplar's are a saturated green 69 RGB units away,
  covering 22.9% of the eyes crop against the source's 22.7%. That is the
  generative Enhance re-illustrating rather than tracing (see Step ② below), and
  it is why the fixture measures each side against the colour it actually uses.
  Our engine, on the same upload, delivers 0.6% of the olive with Enhance on and
  99.2% with it off — **[issue #2](https://github.com/craigjmidwinter/getvect/issues/2)**.

An **earlier PALE-coated variant** of the same drawing was captured first and is
not checked in; its numbers are kept only for the anti-aliasing table below,
where they are the third replication of the Smart-AA collapse: the site
auto-selected a 10-colour palette and AA was OFF by default for that upload, so
it measured **758 paths / 132.7KB / 8 layers** at AA-off and **41 paths /
22.3KB / 8 layers** at Smart — a **94.6%** path reduction.

### The fox (2026-08-04) — predecessor, retained as a license-clean fixture

`fox-sticker.png` is an original generated mascot (chroma-keyed to real alpha;
1024×1024, **76.5% transparent** pixels) with `fox-sticker-white.png` as the
white-flattened variant. Run through the reference product signed-out:

- **Transparency is preserved**: both panes render on a checkerboard; the output
  SVG has NO background-covering path (the first path starts mid-canvas at
  M4460 8480). The site auto-selected an 8-color palette; output = 7 color
  groups, two pairs of which are near-duplicates (rgb(125,64,29) beside
  rgb(116,58,28), rgb(8,0,0) beside rgb(0,0,0)) — fold those and it is five
  distinguishable colors.
- `fox-sticker-clipart-8colors-smartAA.svg` — real output at Clipart defaults for
  this image (Smart AA was ON by default here, Enhance ON, min-area 5px²):
  **63 paths, 114 sub-paths, 7 groups, 35.5KB**, curve command ratio 0.671,
  viewBox `0 0 10240 10240` at a declared 1024×1024. This is the primary
  smoothness/economy exemplar and the only one the fixtures gate against.
- Same settings with **AA Off**: 637 paths, 189KB (measured, not checked in) —
  the same ~90% path reduction the parameter table below records on the other
  subject, replicated on a second one.
- The fox's cyan eyes, `rgb(72,182,210)`, are **dropped by the reference product too**
  (0.0% of them survive into its capture) — unlike Frankie's, where it keeps a
  distinct eye colour. Ours drops them in every configuration. Both observations
  are in issue #2.

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
- **Enhance image with AI** (Beta) checkbox. Initially this looked like denoise +
  background simplification. Extracting the site's `#inputcanvas` with Enhance on
  settled it: the "enhanced input" is a **generative image-to-image re-illustration**
  of the upload — busy background fully removed, soft shading repainted as flat
  colour bands, outlines redrawn uniform, and the image resampled to a new working
  resolution (observed 1152×928 for a 1046×833 upload; dimensions divisible by 8,
  consistent with a diffusion-style model). The tracer then traces already-flat art.
  This is the reference product's structural advantage on shaded artwork; GetVect's
  Enhance is classical (denoise + quantization), which flat-art fixtures don't
  distinguish but soft-shaded art does. Side effect consistent with a generative
  pass: small distinct features (e.g. a mascot's small coloured eyes) can be
  dropped entirely.
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

## Parameter-response measurements (1045×833 flat-color character, Enhance ON)

The numbers are the reference product's, measured live at the settings named. They are
kept because the *response* is what matters and it is not subject-specific — the
Smart-AA finding below replicates on the fox (637 paths → 63). The image they were
taken on is not checked in.

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

**Replicated three times now**, on three unrelated subjects, which is what moves
it from an observation to a property of the control:

| Subject | AA Off | AA Smart | reduction |
|---------|--------|----------|-----------|
| 1045x833 character (above) | 354 paths / 186 KB | 67 / 42 KB | -81% |
| fox sticker | 637 paths / 189 KB | 63 / 35.5 KB | -90% |
| Frankie (pale variant) | 758 paths / 132.7 KB | 41 / 22.3 KB | **-94.6%** |

## Parity scope note for GetVect

Core parity (must-have): 4 presets + Clipart detail levels, palette size radio +
custom palette, Enhance toggle, noise reduction/anti-aliasing, filled vs stroked,
output color groups with per-color disable (→ transparency) and merge threshold,
roundness / minimum area / overlap / circle detection, zoom/fit both panes,
downloads: SVG, EPS, PDF, DXF, PNG. Stretch (minor if missing): isometric view,
crop, edit pixels, gradients tab, STL/GCODE/VectorDrawable, ZIP variants,
≤15KB GT, output size tab, drag-to-regroup color circles.
