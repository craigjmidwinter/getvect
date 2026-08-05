/**
 * Single source of truth for `data-testid` values.
 *
 * The renderer MUST render these ids and the e2e suite selects on them.
 * Human-readable documentation of the surrounding DOM contract (attributes,
 * state, events) lives in docs/TESTIDS.md — keep the two in sync.
 */
export const TESTIDS = {
  // --- A. Launch & ingest ---------------------------------------------------
  appRoot: 'app-root',
  dropZone: 'drop-zone',
  filePickerButton: 'file-picker-button',
  fileInput: 'file-input', // real <input type="file" multiple> — how e2e injects files
  errorToast: 'error-toast',
  imageList: 'image-list',
  imageListItem: 'image-list-item', // + data-image-id, data-selected
  imageListItemName: 'image-list-item-name',
  imageRemoveButton: 'image-remove-button',

  // --- B. Vectorization engine ---------------------------------------------
  workspace: 'workspace',
  progressIndicator: 'progress-indicator', // + data-progress 0..1
  statusText: 'status-text', // + data-status idle|loading|vectorizing|ready|error
  settingsPanel: 'settings-panel',
  settingColorCount: 'color-count',
  settingColorCountHint: 'color-count-hint', // + data-requested, data-actual
  settingDetail: 'detail',
  settingSmoothing: 'smoothing',
  settingDespeckle: 'despeckle',
  enhanceToggle: 'enhance-toggle',
  revectorizeButton: 'revectorize-button',
  resetSettingsButton: 'reset-settings-button',

  // --- B2. Model presets (REFERENCE B2 / OBSERVED-UI step ①) ---------------
  presetClipart: 'preset-clipart',
  presetPhoto: 'preset-photo',
  presetSketch: 'preset-sketch',
  presetDrawing: 'preset-drawing',
  settingDetailLevel: 'detail-level', // <select> maximum|ultra|very-high|high|medium|low|minimum
  settingBwThreshold: 'bw-threshold', // <input type="range"> 0..255, Drawing preset only

  // --- B4. Quality enhancement (REFERENCE B4) ------------------------------
  settingNoiseReduction: 'noise-reduction', // <select> off|low|high
  settingAntiAliasing: 'anti-aliasing', // <select> off|smart|mid

  // --- B5. Advanced vectorization (REFERENCE B5) ---------------------------
  settingRoundness: 'roundness', // <select> 0|1|2 (three curve-fitting levels)
  settingMinArea: 'min-area', // <select> 0|5|90 (px²)
  settingOverlap: 'overlap', // <select> full|high
  settingCircleDetection: 'circle-detection', // checkbox

  // --- B6. Result styles (REFERENCE B6) ------------------------------------
  resultStyleFilled: 'result-style-filled',
  resultStyleStroked: 'result-style-stroked',

  paletteEditor: 'palette-editor',
  paletteSwatch: 'palette-swatch', // + data-color, data-index
  paletteColorInput: 'palette-color-input',
  paletteMergeButton: 'palette-merge-button',
  paletteMergeTarget: 'palette-merge-target',
  paletteRemoveButton: 'palette-remove-button',
  paletteAutoButton: 'palette-auto-button', // discards palette edits (optional)
  paletteSizeOption: 'palette-size-option', // + data-size, one per 1,2,3,4,5,6,8,12,15,16,18

  // --- B3. Output colour groups (REFERENCE B3) -----------------------------
  colorGroups: 'color-groups',
  colorGroupToggle: 'color-group-toggle', // checkbox + data-index, data-color
  colorMergeThreshold: 'merge-threshold', // <select>, percentages
  colorSortOrder: 'color-sort', // <select>

  // --- C. Preview -----------------------------------------------------------
  previewPane: 'preview-pane', // + data-mode original|vector|side-by-side
  previewOriginal: 'preview-original',
  previewVector: 'preview-vector', // contains the live <svg>
  previewViewLabel: 'preview-view-label', // ORIGINAL / VECTOR corner badge, one per view
  previewToggle: 'preview-toggle',
  previewSideBySide: 'preview-side-by-side',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  zoomFit: 'zoom-fit',
  zoomLevel: 'zoom-level', // + data-zoom (1 === 100%)
  panState: 'pan-state', // + data-pan-x, data-pan-y
  previewBusy: 'preview-busy', // busy overlay; must NOT live inside the zoom/pan stage

  // --- D. Export ------------------------------------------------------------
  exportSvg: 'export-svg',
  exportEps: 'export-eps',
  exportDxf: 'export-dxf',
  // REFERENCE E "DXF lines-vs-splines variants". `toDxf(result, { curves })` has
  // implemented both since lap 3 and the engine contract documents them, but no
  // control reaches it, so the variant is dead code from the product's point of
  // view. <select> with values splines|lines, feeding `options.curves`.
  exportDxfCurves: 'dxf-curves',
  exportPdf: 'export-pdf', // REFERENCE D5
  exportPng: 'export-png', // REFERENCE D5
  exportStatus: 'export-status', // + data-last-export-path (cleared whenever it goes stale)
  exportSize: 'export-size', // + data-bytes — live size of the SVG in the preview
} as const;

export type TestId = (typeof TESTIDS)[keyof typeof TESTIDS];
