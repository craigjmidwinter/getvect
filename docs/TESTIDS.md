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
| `image-remove-button` | per-item remove | Optional for the checklist; wire it if you add it. |

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

---

## B. Vectorization engine

| testid | element | required attributes / behaviour |
| --- | --- | --- |
| `workspace` | main working area | **Required:** `data-image-id` — the id of the currently selected image. Must match the selected `image-list-item`'s `data-image-id`. |
| `status-text` | status line | **Required:** `data-status` ∈ `idle` \| `loading` \| `vectorizing` \| `ready` \| `error`. `ready` means *the SVG in the preview is current for the present settings*. Every settings change must leave `ready` and return to it. This is the suite's universal synchronisation point (`waitForReady()`). |
| `progress-indicator` | spinner / bar | Visible while `data-status` is `loading` or `vectorizing`; hidden otherwise. **Required:** `data-progress` in `0..1`. |
| `settings-panel` | container | Visible when an image is selected. |
| `color-count` | `<input type="range">` | min 2, max 64, integer step. |
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
setting value ⇒ different `preview-vector` markup (REFERENCE B2).

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

While a save is in flight every export button is disabled, so a click cannot land on a
second format while the first dialog is open. They re-enable when the dialog resolves.

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
`<g fill="#rrggbb">` layer — the structure the reference product emits — so a path element
inherits its fill rather than repeating it. Anything parsing our SVG back into geometry
must honour that inheritance; `parseSvgShapes` (src/engine/path.ts) does, and it is what
the EPS/DXF/PDF writers use.

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
