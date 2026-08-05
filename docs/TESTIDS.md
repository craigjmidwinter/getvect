# DOM contract (`data-testid` reference)

This file is the interface between the **app** and the **acceptance suite**. The suite in
`tests/e2e/` selects exclusively on `data-testid` — never on text, class names, or DOM
position — so builders can restyle and restructure freely as long as this contract holds.

The ids themselves live in code at [`src/shared/testids.ts`](../src/shared/testids.ts).
Import `TESTIDS` in the renderer rather than typing string literals; the suite imports the
same module, so a typo is a compile error instead of a mystery failure.

```tsx
import { TESTIDS } from '../shared/testids';
<div data-testid={TESTIDS.dropZone}>…</div>
```

**Rules of the road**

- Adding new testids is free. Renaming or removing one is a breaking change: update
  `src/shared/testids.ts`, this file, and the specs in the same commit.
- Attributes listed as *required* are read by assertions. Missing attribute = failing test.
- State attributes must reflect **committed** state, not in-flight animation state.

---

## A. Launch & ingest

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `app-root` | root container | Always present once the renderer mounts. |
| `drop-zone` | drag-and-drop target | Must handle `dragenter`/`dragover`/`drop`. See "Drag-and-drop" below. |
| `file-input` | `<input type="file" multiple>` | May be visually hidden (`display:none` is fine — Playwright's `setInputFiles` works on hidden inputs) but must exist in the DOM at all times and accept PNG/JPEG/BMP. This is how the suite injects files. |
| `file-picker-button` | button | Opens the native picker via `window.getvect.openImages()`. Must be visible on launch. |
| `error-toast` | error banner | Appears when a file is rejected. Text must name the problem and the accepted formats — the suite matches `/unsupported\|not supported\|can'?t open\|PNG\|JPEG\|BMP/i`. |
| `image-list` | sidebar container | Visible once ≥1 image is loaded. |
| `image-list-item` | one per loaded image | **Required:** `data-image-id` (stable unique id), `data-selected` = `"true"`/`"false"` (the string, on every item — not just the selected one). Must contain the source filename as text. |
| `image-list-item-name` | filename label | Optional; `image-list-item` need only *contain* the filename. |
| `image-remove-button` | per-item remove | Removes that image. Removing the last image must return `status-text` to `idle` and clear `export-status` (see D). |

**Drag feedback (A1).** `app-root` carries `data-dragging="true"` while a file is
being dragged anywhere over the window (set on `dragenter`/`dragover`, cleared on
`dragleave`/`drop`). A drop is accepted anywhere in the window, not only over
`drop-zone`; the suite dispatches drag events at `preview-pane` too.

**Newly ingested images win the selection (A1/A3).** After any successful ingest —
drop or picker, first image or fifth — the first newly accepted entry becomes the
selected one (`data-selected="true"`) and the workspace switches to it. Leaving the
previous selection in place is a silent no-op from the user's point of view: the file
they just dropped is neither shown nor vectorized.

### Drag-and-drop

The suite dispatches a synthetic `DragEvent` carrying real `File` objects in a
`DataTransfer` (see `dropFiles()` in `tests/e2e/helpers.ts`).

> **The drop handler must read `event.dataTransfer.files` and consume each `File` with web
> APIs (`arrayBuffer()`, `createImageBitmap()`).** It must NOT rely on Electron's
> non-standard `File.path` — that property is absent on synthetic drops (and removed in
> recent Electron), which would make drag-and-drop untestable.

Files arriving through `file-input` must go down the exact same ingest code path.

### Rejection (A2)

A rejected file must (a) show `error-toast`, and (b) **not** create an `image-list-item`.
In a mixed drop, supported files still load and the toast reports the rejected ones.

The toast must be **self-dismissing** (within ~10s) and **dismissable by hand** (it
contains a button). It must *not* be cleared as a side effect of an unrelated
successful ingest — a rejection the user never saw acknowledged is a rejection they
never saw.

---

## B. Vectorization engine

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `workspace` | main working area | **Required:** `data-image-id` — the id of the currently selected image. Must match the selected `image-list-item`'s `data-image-id`. |
| `status-text` | status line | **Required:** `data-status` ∈ `idle` \| `loading` \| `vectorizing` \| `ready` \| `error`. `ready` means *the SVG in the preview is current for the present settings*. Every settings change must leave `ready` and return to it. This is the suite's universal synchronisation point (`waitForReady()`). |
| `progress-indicator` | spinner / bar | Visible while `data-status` is `loading` or `vectorizing`; hidden otherwise. **Required:** `data-progress` in `0..1`. |
| `settings-panel` | container | Visible when an image is selected. |
| `color-count` | `<input type="range">` | min 2, max 64, integer step. |
| `color-count-hint` | label next to it | **Required:** `data-requested` (slider value) and `data-actual` (`result.palette.length`), and text naming the actual number. The image often has fewer colours than the slider asks for; the control and the result must not silently disagree. |
| `detail` | `<input type="range">` | min 0, max 100. |
| `smoothing` | `<input type="range">` | min 0, max 100. |
| `despeckle` | `<input type="range">` | min 0, max 100. |
| `enhance-toggle` | checkbox/switch | Toggles `settings.enhance`. Clicking it must re-vectorize. |
| `revectorize-button` | button | Optional. If settings apply automatically (preferred), still provide it — the suite does not require it, but the screenshot harness will use it if present. |
| `reset-settings-button` | button | Optional; restores `DEFAULT_SETTINGS`. |

**Settings inputs must be real `<input>` elements.** The suite sets `.value` through the
native setter and fires `input` + `change` (React-compatible). Custom div-based sliders
will not work.

Each of the four sliders must **observably change the SVG**: same image + different
setting value ⇒ different `preview-vector` markup (REFERENCE B2). "Observably" is
enforced at two levels: the e2e suite compares markup, and
`tests/engine/rendered.test.mjs` rasterizes both results and requires more than 1 % of
pixels to move. A geometry change no pixel can see does not count.

### Model presets (B2)

`fixtures/reference/OBSERVED-UI.md` step ① is the ground truth.

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `preset-clipart` / `preset-photo` / `preset-sketch` / `preset-drawing` | buttons | **Required:** `data-selected` = `"true"`/`"false"` on every one. Clicking re-vectorizes. Each preset must produce a different SVG. |
| `detail-level` | `<select>` | Clipart's Detail Level. Option values exactly `maximum`, `ultra`, `very-high`, `high`, `medium`, `low`, `minimum`, in that order. Minimum must produce a simpler drawing than Maximum. |
| `bw-threshold` | `<input type="range">` 0..255 | Drawing preset only: the luminance split. Moving it must repaint. |

Sketch must emit **grayscale only** (every layer colour has `r == g == b`); Drawing
must emit **at most two** colours, black and white.

### Advanced vectorization (B5)

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `roundness` | `<select>` | Exactly three curve-fitting levels. The roundest must fit strictly more curve commands than the least round. |
| `min-area` | `<select>` | Option values exactly `0`, `5`, `90` (px²). At 5 no shape smaller than 5 px² may survive; at 90 none smaller than 90 px². |
| `overlap` | `<select>` | Option values `full`, `high`. `full` paints lower layers under the upper ones, so it carries at least as much geometry as `high`. |
| `circle-detection` | checkbox | On must yield `<circle>`/`<ellipse>` elements or a higher curve-command ratio than Off. |

### Quality enhancement (B4)

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `noise-reduction` | `<select>` | Option values `off`, `low`, `high`. Each step must not increase the sub-path count. |
| `anti-aliasing` | `<select>` | Option values `off`, `smart`, `mid`. `smart` must not leave more near-duplicate colour layers (RGB distance ≤ 24 between two `<g fill>` layers) than `off` — those are the halo layers antialiased sources produce. |

Enhance must never introduce a colour the source does not contain (asserted against
the flat fixture's exactly six colours).

### Result styles (B6)

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `result-style-filled` / `result-style-stroked` | buttons | **Required:** `data-selected`. Filled is the default. In stroked mode every colour layer becomes `<g fill="none" stroke="…" stroke-width="…">` and the exported document changes with it (C3 still holds). |

### Palette editor (B3)

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `palette-editor` | container | Visible when `data-status` is `ready`. |
| `palette-swatch` | one per palette entry | **Required:** `data-color` = `#rrggbb` lowercase-or-uppercase hex, `data-index` = position. Clicking selects it for editing. Count must equal the palette size. |
| `palette-color-input` | `<input type="color">` | Edits the selected swatch. Setting it re-vectorizes with the overridden palette. |
| `palette-merge-target` | `<select>` | Options = the other palette entries; option `value` = target index. |
| `palette-merge-button` | button | Merges selected swatch into `palette-merge-target`. Palette size drops by one. |
| `palette-remove-button` | button | Removes the selected swatch. Palette size drops by one and the removed colour must no longer appear in the SVG. |
| `palette-auto-button` | button | Optional; present only while the palette has been hand-edited. Clears `settings.palette` so the engine recomputes the palette from the image. |
| `palette-size-option` | one per candidate palette | **Required:** `data-size`. Exactly the eleven sizes the reference product offers, in order: 1, 2, 3, 4, 5, 6, 8, 12, 15, 16, 18. Selecting one drives `colorCount`. |

### Output colour groups (B3)

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `color-groups` | container | Visible when `data-status` is `ready`. |
| `color-group-toggle` | checkbox per output colour | **Required:** `data-index`, `data-color`. One per palette entry. Unchecking removes that colour's layer from the SVG — and unchecking the dominant (index 0) colour must leave a genuinely **transparent** background: no full-bleed backdrop `<rect>`, and the corner pixels render with alpha 0. Re-checking restores the previous document exactly. |
| `merge-threshold` | `<select>` | Percentage thresholds (the real product defaults to 5 %). Raising it must not increase the layer count. |
| `color-sort` | `<select>` | Layer sort order. Changing it reorders `<g>` layers without changing which colours exist. |

The palette editor and colour groups must not crowd out the artwork: at the app's
minimum window size with a 64-colour palette, `settings-panel` must stay under 45 % of
the window height and `preview-pane` must keep more than 40 %.

`palette-editor` also carries `data-palette-size` (entry count) and `data-stale`
(`"true"` while a re-trace is in flight, so the swatches on screen describe the SVG in the
preview rather than the one being computed). Neither is required by the suite.

**Merge vs. remove.** Merging gives the selected slot the *target's* colour: the engine
keeps `k` unchanged, so the clustering — and therefore every contour — is identical, and
the two slots collapse into one layer. Removing drops a slot, so the image is re-quantized
into `k-1` colours. Both shrink the palette by one; only merge leaves the survivor's
geometry untouched.

### Enhance (B4)

Toggling `enhance-toggle` on the noisy fixture must change the SVG and must **not increase**
the path count — denoising should simplify, not complicate.

---

## C. Preview

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `preview-pane` | preview container | **Required:** `data-mode` ∈ `original` \| `vector` \| `side-by-side`. Must have a non-zero bounding box (the suite drags inside it to test panning). |
| `preview-original` | original raster view | **Required (side-by-side):** `data-zoom`, `data-pan-x`, `data-pan-y`. |
| `preview-vector` | vector view | Must contain a live `<svg>` element. **Required:** `data-zoom`, `data-pan-x`, `data-pan-y` — identical values to `preview-original` at all times (synchronised views, REFERENCE C2). |
| `preview-toggle` | button | Cycles `original` ↔ `vector`. |
| `preview-side-by-side` | button | Sets `data-mode="side-by-side"`; both views visible. |
| `zoom-in` / `zoom-out` / `zoom-fit` | buttons | Change zoom. `zoom-fit` must be idempotent and return the same value each time. |
| `zoom-level` | label | **Required:** `data-zoom`, a number where `1` = 100%. |
| `pan-state` | any element (may be the pane itself) | **Required:** `data-pan-x`, `data-pan-y` in image pixels. Must change when the user drags in `preview-pane` while zoomed in. |
| `preview-busy` | busy overlay | Shown while a trace is in flight. Must be **outside** the zoom/pan-transformed stage: its centre stays within 12 px of `preview-pane`'s centre at any zoom. |

### Viewer behaviour (C1/C2)

- **Never blank.** While a re-trace is in flight the previous result stays mounted
  (dimmed is fine) under `preview-busy`. `preview-vector svg` must exist in every
  frame from the first successful trace onwards — including while switching images.
- **The wheel zooms.** A `wheel` event over `preview-pane` changes `data-zoom`
  (cursor-anchored), and both views stay synchronized.
- **Pan is bounded.** No drag may push the artwork out of the view: after any drag the
  rendered `<svg>` still overlaps `preview-pane` by more than 25 % of the smaller of
  the two areas. "Fit" must not be the only way back.
- **Inert when empty.** With no image loaded, `preview-toggle`, `preview-side-by-side`,
  `zoom-in`, `zoom-out` and `zoom-fit` are `disabled`.

### C3 — the preview is the export

The `<svg>` inside `preview-vector` must be the **same document** that gets exported: same
`viewBox`, same number of `<path>` elements. Don't render a downscaled or simplified
preview and generate a different SVG at export time.

---

## D. Export

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `export-svg` / `export-eps` / `export-dxf` | buttons | Enabled when `data-status="ready"`. Each calls `window.getvect.saveExport({ defaultName, contents, format })`. |
| `export-pdf` / `export-png` | buttons | REFERENCE D5. Same contract as the three above. PDF is a vector document from the engine; PNG is rasterized from the *same* SVG by the renderer (`src/renderer/lib/raster.ts`) and sent with `encoding: 'base64'`. |
| `export-status` | status element | **Required after a successful export:** `data-last-export-path` = the absolute path returned by the main process. The suite waits on this attribute; without it every D-series test fails. Leave it absent (not empty) before the first export and after a cancelled one. |
| `export-size` | label | **Required:** `data-bytes` = byte length of the SVG currently in the preview (the real product shows a live size next to Download). Must update when the result changes. |

While a save is in flight every export button is disabled, so a click cannot land on a
second format while the first dialog is open. They re-enable when the dialog resolves.

**`data-last-export-path` means "this file matches what is on screen".** It must
therefore be **cleared** whenever that stops being true: on a settings change, on a
re-vectorize, on switching the selected image, and when the image is removed. A
confirmation that outlives its result is a false statement about the user's disk.

**The export row must not re-flow when it appears.** The status/size labels occupy a
fixed box, so the buttons keep their positions: after an export, each export button's
centre has moved by at most 1 px and `document.elementFromPoint` at the previous
centre still resolves to the same button. Otherwise a two-format export (SVG then PDF)
silently writes the wrong format.

**Default filenames (D4):** `<source basename without extension>.<format>` — e.g.
`logo-flat-512.png` → `logo-flat-512.svg`. The export must apply to the **currently
selected** image.

**Format expectations** (asserted in `tests/e2e/d-export.spec.ts`):

- **SVG** — starts with an optional XML declaration then `<svg`, carries
  `xmlns="http://www.w3.org/2000/svg"`, ends with `</svg>`, `viewBox="0 0 w h"` in source
  pixels, and rasterizes under resvg.
- **EPS** — first line `%!PS-Adobe-3.0 EPSF-3.0`, a `%%BoundingBox: 0 0 w h` matching the
  source dimensions, painting operators present, terminated by `%%EOF`.
- **DXF** — ASCII DXF with `SECTION`/`HEADER`/`ENDSEC`, `$EXTMIN` and `$EXTMAX` reflecting
  the artwork extents, an `ENTITIES` section containing `LWPOLYLINE`/`POLYLINE`/`SPLINE`/
  `HATCH`/`LINE` entities, terminated by `EOF`.
- **PDF** (D5) — `%PDF-1.` header, a `/MediaBox [0 0 w h]` in source pixels, one page, a
  content stream with painting operators, a byte-accurate `xref`/`startxref`, `%%EOF`.
- **PNG** (D5) — a real PNG bitstream (`\x89PNG\r\n\x1a\n` signature, `IHDR` carrying the
  source dimensions, `IEND`), rasterized from the exported SVG.

**SVG document structure (D1).** `renderSvg` groups each colour's paths into a single
`<g fill="rgb(r,g,b)">` layer — the structure *and the notation* the reference product
emits (`fixtures/reference/artwork.svg`) — so a path element inherits its fill rather
than repeating it. Anything parsing our SVG back into geometry must honour that
inheritance; `parseSvgShapes` (src/engine/path.ts) does, and it is what the EPS/DXF/PDF
writers use. The `viewBox` stays at 1× source pixels; see docs/HARNESS.md "The D1
viewBox question" for why that half of the exemplar is deliberately not reproduced.

### Export dialog under test

REFERENCE D4 requires a **native save dialog**, which a headless suite cannot click. The
main process therefore bypasses it when `GETVECT_E2E=1` is set, writing to
`$GETVECT_EXPORT_DIR/<defaultName>` instead (see `src/main/main.ts`, handler
`export:save`). Everything else — the IPC hop, the filename, the file write — is the real
production path.

**Builders must not add a second, dialog-free export path.** Route every export through
`window.getvect.saveExport`; the env-var branch inside the main process is the only place
that knows about tests.

---

## Preload API available to the renderer

```ts
window.getvect.openImages(): Promise<string[]>            // native open dialog
window.getvect.readFile(path: string): Promise<Uint8Array>
window.getvect.saveExport({
  defaultName,                       // "<source stem>.<format>"
  contents,                          // text, or base64 for binary formats
  format,                            // 'svg' | 'eps' | 'dxf' | 'pdf' | 'png'
  encoding?,                         // 'utf8' (default) | 'base64'
}): Promise<{ canceled, filePath }>  // native save dialog + write
window.getvect.appInfo(): Promise<{ version, electron, e2e }>
```
